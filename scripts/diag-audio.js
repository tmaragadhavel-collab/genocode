/**
 * Audio-pipeline diagnostic for the legacy (Electron) path.
 *
 * Replays a real speech recording through the exact messages the Electron
 * renderer sends — `session_control` then base64 `audio_data` with
 * source="system" / "microphone" — and reports which stage of the journey the
 * audio last reached. Everything downstream of the WebSocket is the real
 * server, the real DeepgramStreamingService and the real Deepgram API.
 *
 * It does NOT exercise the browser half (mic → LiveKit → remote track → PCM);
 * that part needs a real microphone and is covered by the manual procedure.
 *
 * Usage: node scripts/diag-audio.js [port] [interviewer|candidate|both]
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const port = process.argv[2] || '3001';
const which = process.argv[3] || 'both';
const base = `http://localhost:${port}`;

const FIXTURES = {
  // 16 kHz mono PCM16 WAV; strip the 44-byte header.
  interviewer: 'question-python.wav',
  candidate: 'process-vs-thread.wav',
};

const FRAME_SAMPLES = 4096; // matches the renderer's ScriptProcessor block size
const FRAME_BYTES = FRAME_SAMPLES * 2;
const FRAME_MS = (FRAME_SAMPLES / 16000) * 1000; // ~256 ms

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pcmOf = (name) => fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', name)).subarray(44);

const transcripts = { interviewer: [], candidate: [] };

async function diag() {
  const r = await fetch(`${base}/api/diag/audio`);
  if (!r.ok) throw new Error(`/api/diag/audio returned ${r.status}`);
  return r.json();
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/?view=app`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'transcript') {
        const t = msg.payload;
        if (t.text && t.text.trim() && transcripts[t.speaker]) {
          transcripts[t.speaker].push({ text: t.text, isFinal: t.isFinal, confidence: t.confidence });
        }
      }
    });
  });
}

/** Streams the fixture in real time, exactly as the renderer would. */
async function stream(ws, source, pcm) {
  for (let i = 0; i < pcm.length; i += FRAME_BYTES) {
    const frame = pcm.subarray(i, i + FRAME_BYTES);
    ws.send(JSON.stringify({
      type: 'audio_data',
      payload: { source, data: frame.toString('base64') },
      timestamp: new Date().toISOString(),
    }));
    await sleep(FRAME_MS);
  }
}

function verdict(label, c, spoke) {
  const stages = [
    ['WebSocket audio received by server', c.wsMessages > 0],
    ['Audio decoded to PCM bytes', c.wsBytes > 0],
    ['Deepgram socket connected', c.deepgramOpens > 0],
    ['Bytes forwarded to Deepgram', c.deepgramBytesSent > 0],
    ['Deepgram partial transcript', c.partials > 0],
    ['Deepgram FINAL transcript', c.finals > 0],
  ];
  console.log(`\n--- ${label} ---`);
  if (!spoke) {
    console.log('  (not exercised in this run)');
    return true;
  }
  let firstFailure = null;
  for (const [name, ok] of stages) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok && !firstFailure) firstFailure = name;
  }
  console.log(`  audio: ${c.audioSeconds}s in, ${c.deepgramSeconds}s to Deepgram, ${c.deepgramDropped} frame(s) dropped`);
  console.log(`  deepgram: opens=${c.deepgramOpens} closes=${c.deepgramCloses} errors=${c.deepgramErrors} connected=${c.deepgramConnected}`);
  const heard = transcripts[label.toLowerCase()] || [];
  const finals = heard.filter((t) => t.isFinal);
  console.log(`  transcripts: ${heard.length - finals.length} partial, ${finals.length} final`);
  for (const t of finals) console.log(`    FINAL "${t.text}" (confidence ${t.confidence})`);
  if (firstFailure) console.log(`  ROOT CAUSE: first broken link is "${firstFailure}"`);
  return !firstFailure;
}

(async () => {
  console.log(`Audio pipeline diagnostic → ${base}`);
  const pre = await diag();
  console.log(`Deepgram configured: ${pre.deepgramConfigured}`);
  if (!pre.deepgramConfigured) {
    console.log('FAIL  No Deepgram key configured — nothing downstream can pass.');
    process.exit(1);
  }

  const ws = await connect();
  await fetch(`${base}/api/diag/audio/reset`, { method: 'POST' });

  ws.send(JSON.stringify({ type: 'session_control', payload: { action: 'start' }, timestamp: new Date().toISOString() }));
  await sleep(2000); // let both Deepgram sockets open

  const mid = await diag();
  console.log(`STT service started: ${mid.sttServiceStarted}`);
  console.log(`Deepgram streams connected: interviewer=${mid.interviewerStreamConnected} candidate=${mid.candidateStreamConnected}`);

  const doI = which === 'both' || which === 'interviewer';
  const doC = which === 'both' || which === 'candidate';

  if (doI) {
    console.log('\nStreaming interviewer speech (source="system")…');
    await stream(ws, 'system', pcmOf(FIXTURES.interviewer));
  }
  if (doC) {
    console.log('Streaming candidate speech (source="microphone")…');
    await stream(ws, 'microphone', pcmOf(FIXTURES.candidate));
  }

  console.log('Waiting for Deepgram to finalise…');
  await sleep(5000);

  const post = await diag();
  const okI = verdict('Interviewer', post.counters.interviewer, doI);
  const okC = verdict('Candidate', post.counters.candidate, doC);

  ws.send(JSON.stringify({ type: 'session_control', payload: { action: 'stop' }, timestamp: new Date().toISOString() }));
  await sleep(300);
  ws.close();

  console.log(`\n${okI && okC ? 'SERVER-SIDE PIPELINE PASSED' : 'SERVER-SIDE PIPELINE FAILED'}`);
  process.exit(okI && okC ? 0 : 1);
})().catch((e) => { console.error('Diagnostic crashed:', e.message); process.exit(2); });
