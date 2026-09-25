/**
 * Reproduces the suspected interviewer-transcription failure: Deepgram closes an
 * idle socket, and nothing reopens it, so every later utterance is dropped.
 *
 * Interviewer speaks → pause (the length of a candidate's answer) → speaks again.
 * A healthy pipeline transcribes both utterances.
 *
 * Usage: node scripts/diag-idle.js [port] [idleSeconds]
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const port = process.argv[2] || '3001';
const idleSeconds = Number(process.argv[3] || 20);
const base = `http://localhost:${port}`;

const FRAME_BYTES = 4096 * 2;
const FRAME_MS = (4096 / 16000) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pcm = fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'question-python.wav')).subarray(44);

const finals = [];

(async () => {
  const ws = new WebSocket(`ws://localhost:${port}/?view=app`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'transcript' && m.payload.speaker === 'interviewer' && m.payload.isFinal && m.payload.text.trim()) {
      finals.push({ at: Date.now(), text: m.payload.text });
    }
  });

  await fetch(`${base}/api/diag/audio/reset`, { method: 'POST' });
  ws.send(JSON.stringify({ type: 'session_control', payload: { action: 'start' }, timestamp: new Date().toISOString() }));
  await sleep(2000);

  const speak = async () => {
    for (let i = 0; i < pcm.length; i += FRAME_BYTES) {
      ws.send(JSON.stringify({
        type: 'audio_data',
        payload: { source: 'system', data: pcm.subarray(i, i + FRAME_BYTES).toString('base64') },
        timestamp: new Date().toISOString(),
      }));
      await sleep(FRAME_MS);
    }
    await sleep(3000);
  };

  console.log('Interviewer utterance 1…');
  await speak();
  const afterFirst = finals.length;
  let d = (await (await fetch(`${base}/api/diag/audio`)).json()).counters.interviewer;
  console.log(`  finals=${afterFirst} deepgramConnected=${d.deepgramConnected} opens=${d.deepgramOpens} closes=${d.deepgramCloses}`);

  console.log(`\nCandidate answers for ${idleSeconds}s — interviewer is silent (no audio sent, exactly as when muted or just listening)…`);
  await sleep(idleSeconds * 1000);
  d = (await (await fetch(`${base}/api/diag/audio`)).json()).counters.interviewer;
  console.log(`  deepgramConnected=${d.deepgramConnected} opens=${d.deepgramOpens} closes=${d.deepgramCloses}`);

  console.log('\nInterviewer utterance 2 (the next question)…');
  await speak();
  await sleep(3000);
  const afterSecond = finals.length - afterFirst;
  d = (await (await fetch(`${base}/api/diag/audio`)).json()).counters.interviewer;
  console.log(`  finals=${afterSecond} bytesToDeepgram=${d.deepgramSeconds}s dropped=${d.deepgramDropped} opens=${d.deepgramOpens} closes=${d.deepgramCloses}`);

  console.log('\nTranscripts received:');
  for (const f of finals) console.log(`  "${f.text}"`);

  const pass = afterFirst > 0 && afterSecond > 0;
  console.log(`\n${pass ? 'PASS' : 'FAIL'}  interviewer transcription survives a ${idleSeconds}s pause`);
  if (!pass && afterFirst > 0) {
    console.log('ROOT CAUSE: the Deepgram socket closed while idle and was never reopened;');
    console.log(`            ${d.deepgramDropped} audio frame(s) from utterance 2 were dropped before reaching Deepgram.`);
  }

  ws.send(JSON.stringify({ type: 'session_control', payload: { action: 'stop' }, timestamp: new Date().toISOString() }));
  await sleep(300);
  ws.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('crashed:', e.message); process.exit(2); });
