/**
 * Deepgram stream-lifecycle acceptance tests for the legacy (Electron) path.
 *
 * Runs the scenarios that used to fail permanently:
 *   1. Late interviewer  — STT starts, nobody speaks for N s, then the interviewer does.
 *   2. Idle recovery     — interviewer speaks, goes quiet for N s, speaks again.
 *   3. Candidate         — regression check that the other stream is unaffected.
 *   4. Independence      — both speak in the same session; each gets its own transcript.
 *
 * Everything below the WebSocket is the real server and the real Deepgram API.
 *
 * Usage: node scripts/diag-lifecycle.js [port] [idleSeconds]
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const port = process.argv[2] || '3001';
const idle = Number(process.argv[3] || 20);
const base = `http://localhost:${port}`;

const FRAME_BYTES = 4096 * 2;
const FRAME_MS = (4096 / 16000) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fixture = (n) => fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', n)).subarray(44);
const QUESTION = fixture('question-python.wav');
const ANSWER = fixture('process-vs-thread.wav');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

let ws;
let finals = { interviewer: [], candidate: [] };

const diag = async () => (await (await fetch(`${base}/api/diag/audio`)).json());
const send = (o) => ws.send(JSON.stringify({ ...o, timestamp: new Date().toISOString() }));

async function speak(source, pcm) {
  for (let i = 0; i < pcm.length; i += FRAME_BYTES) {
    send({ type: 'audio_data', payload: { source, data: pcm.subarray(i, i + FRAME_BYTES).toString('base64') } });
    await sleep(FRAME_MS);
  }
  await sleep(3500); // let Deepgram finalise
}

async function session(fn) {
  finals = { interviewer: [], candidate: [] };
  await fetch(`${base}/api/diag/audio/reset`, { method: 'POST' });
  send({ type: 'session_control', payload: { action: 'start' } });
  await sleep(2000);
  try {
    await fn();
  } finally {
    send({ type: 'session_control', payload: { action: 'stop' } });
    await sleep(1000);
  }
}

(async () => {
  ws = new WebSocket(`ws://localhost:${port}/?view=app`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type !== 'transcript') return;
    const t = m.payload;
    if (t.isFinal && t.text?.trim() && finals[t.speaker]) finals[t.speaker].push(t.text);
  });

  console.log(`\n=== 1. Late interviewer (silent for ${idle}s before the first word) ===`);
  await session(async () => {
    await sleep(idle * 1000);
    const mid = (await diag()).counters.interviewer;
    console.log(`  after ${idle}s idle: connected=${mid.deepgramConnected} opens=${mid.deepgramOpens} closes=${mid.deepgramCloses}`);
    await speak('system', QUESTION);
    const d = (await diag()).counters.interviewer;
    check('interviewer FINAL transcript after a late join', finals.interviewer.length > 0, `"${finals.interviewer.join(' | ')}"`);
    check('no audio lost', d.deepgramDropped === 0, `dropped=${d.deepgramDropped}`);
    check('at most one socket open at a time', d.deepgramOpens - d.deepgramCloses <= 1,
      `opens=${d.deepgramOpens} closes=${d.deepgramCloses}`);
  });

  console.log(`\n=== 2. Idle recovery (speak, ${idle}s silence, speak again) ===`);
  await session(async () => {
    await speak('system', QUESTION);
    const first = finals.interviewer.length;
    check('first utterance transcribed', first > 0, `"${finals.interviewer.join(' | ')}"`);
    await sleep(idle * 1000);
    const mid = (await diag()).counters.interviewer;
    console.log(`  after ${idle}s idle: connected=${mid.deepgramConnected} opens=${mid.deepgramOpens} closes=${mid.deepgramCloses}`);
    await speak('system', QUESTION);
    const d = (await diag()).counters.interviewer;
    check('second utterance transcribed after the pause', finals.interviewer.length > first,
      `${finals.interviewer.length} final(s) total`);
    check('stream survived or reopened', d.deepgramConnected, `opens=${d.deepgramOpens} closes=${d.deepgramCloses}`);
    check('no audio lost', d.deepgramDropped === 0, `dropped=${d.deepgramDropped}`);
  });

  console.log('\n=== 3. Candidate regression ===');
  await session(async () => {
    await speak('microphone', ANSWER);
    const d = (await diag()).counters.candidate;
    check('candidate FINAL transcript', finals.candidate.length > 0, `"${finals.candidate.join(' | ')}"`);
    check('no audio lost', d.deepgramDropped === 0, `dropped=${d.deepgramDropped}`);
  });

  console.log(`\n=== 4. Independence (interviewer idles ${idle}s while the candidate talks) ===`);
  await session(async () => {
    await speak('system', QUESTION);
    await speak('microphone', ANSWER);
    await sleep(Math.max(0, idle - 14) * 1000);
    await speak('system', QUESTION);
    const i = (await diag()).counters.interviewer;
    const c = (await diag()).counters.candidate;
    check('interviewer transcribed before and after the candidate spoke', finals.interviewer.length >= 2,
      `${finals.interviewer.length} final(s)`);
    check('candidate transcribed independently', finals.candidate.length > 0, `${finals.candidate.length} final(s)`);
    check('neither stream leaked sockets', i.deepgramOpens - i.deepgramCloses <= 1 && c.deepgramOpens - c.deepgramCloses <= 1,
      `interviewer ${i.deepgramOpens}/${i.deepgramCloses}, candidate ${c.deepgramOpens}/${c.deepgramCloses}`);
  });

  console.log('\n=== 5. Unexpected disconnect → automatic reconnect ===');
  await session(async () => {
    await speak('system', QUESTION);
    const before = (await diag()).counters.interviewer;
    check('connected before the drop', before.deepgramConnected, `opens=${before.deepgramOpens}`);

    await fetch(`${base}/api/diag/audio/disconnect?speaker=interviewer`, { method: 'POST' });
    console.log('  simulated a network drop on the interviewer socket');
    await sleep(500);
    const during = (await diag()).counters.interviewer;
    check('drop observed', during.deepgramCloses > before.deepgramCloses, `closes=${during.deepgramCloses}`);

    await sleep(4000); // backoff + handshake
    const after = (await diag()).counters.interviewer;
    check('reconnected automatically', after.deepgramOpens > before.deepgramOpens,
      `opens ${before.deepgramOpens} → ${after.deepgramOpens}`);
    check('still only one live socket', after.deepgramOpens - after.deepgramCloses <= 1,
      `opens=${after.deepgramOpens} closes=${after.deepgramCloses}`);

    const spokenBefore = finals.interviewer.length;
    await speak('system', QUESTION);
    check('transcription resumed after the reconnect', finals.interviewer.length > spokenBefore,
      `"${finals.interviewer.slice(spokenBefore).join(' | ')}"`);
    check('candidate stream untouched by the interviewer drop',
      (await diag()).counters.candidate.deepgramCloses === 0);
  });

  console.log('\n=== 6. Intentional stop must NOT reconnect ===');
  await fetch(`${base}/api/diag/audio/reset`, { method: 'POST' });
  send({ type: 'session_control', payload: { action: 'start' } });
  await sleep(2000);
  const live = await diag();
  check('streams open on start', live.interviewerStreamConnected && live.candidateStreamConnected);
  send({ type: 'session_control', payload: { action: 'stop' } });
  await sleep(6000); // longer than the largest backoff would need
  const stopped = await diag();
  check('no reconnect after an intentional stop',
    !stopped.sttServiceStarted && !stopped.interviewerStreamConnected && !stopped.candidateStreamConnected,
    `opens interviewer=${stopped.counters.interviewer.deepgramOpens} candidate=${stopped.counters.candidate.deepgramOpens}`);
  check('start after stop creates clean streams', await (async () => {
    send({ type: 'session_control', payload: { action: 'start' } });
    await sleep(2500);
    const again = await diag();
    send({ type: 'session_control', payload: { action: 'stop' } });
    return again.interviewerStreamConnected && again.candidateStreamConnected;
  })());

  ws.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('crashed:', e.message); process.exit(2); });
