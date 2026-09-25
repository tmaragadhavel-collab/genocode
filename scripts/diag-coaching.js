/**
 * Live candidate-coaching check against the REAL providers configured in .env
 * (Deepgram for speech, Groq for the LLM).
 *
 * Streams a real speech recording as the interviewer's microphone would, then
 * measures what the candidate socket actually receives. It does NOT use a
 * physical microphone — the browser half is still covered by the manual test.
 *
 * Usage: node scripts/diag-coaching.js [port]
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const port = process.argv[2] || '3001';
const base = `http://localhost:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUESTION = fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'question-python.wav')).subarray(44);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

async function api(method, url, body, cookie) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = r.headers.get('set-cookie');
  return { status: r.status, body: await r.json().catch(() => null), cookie: setCookie ? setCookie.split(';')[0] : null };
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/?view=room`);
    const all = [];
    const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      all.push(m);
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.t); w.resolve(m); }
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws, all,
      send: (o) => ws.send(JSON.stringify(o)),
      sendBinary: (b) => ws.send(b, { binary: true }),
      wait: (pred, ms = 30000) => new Promise((res, rej) => {
        const hit = all.find(pred);
        if (hit) return res(hit);
        const w = { pred, resolve: res };
        w.t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout')); }, ms);
        waiters.push(w);
      }),
    }));
  });
}

async function speak(client, pcm) {
  const frame = 3200; // 100 ms
  const audio = Buffer.concat([pcm, Buffer.alloc(1200 * 32)]);
  for (let i = 0; i < audio.length; i += frame) {
    client.sendBinary(audio.subarray(i, i + frame));
    await sleep(100); // real time, as a microphone would
  }
}

(async () => {
  const health = (await api('GET', '/health')).body;
  console.log(`Providers: stt=${health.providers.stt} ai=${health.providers.ai}`);
  check('a real LLM is configured (not demo)', health.providers.ai !== 'mock', health.providers.ai);
  check('a real STT provider is configured', health.providers.stt === 'deepgram');

  const A = (await api('POST', '/api/auth/signup', {
    email: `live.coach.${Date.now()}@example.com`, password: 'long enough password', name: 'Live Coach',
  })).cookie;
  const iv = (await api('POST', '/api/interviews', {
    candidateName: 'Live Candidate', position: 'Backend Engineer', durationMinutes: 30,
    skills: ['python'], candidateCoaching: true,
  }, A)).body;
  const Ij = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'interviewer' }, A)).body;
  const key = new URL(iv.candidateUrl).searchParams.get('key');
  const Cj = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key })).body;

  const I = await connect();
  const C = await connect();
  I.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Ij.participantKey });
  const ij = await I.wait((m) => m.type === 'session_joined');
  C.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Cj.participantKey });
  const cj = await C.wait((m) => m.type === 'session_joined');
  check('both roles see the coaching disclosure', ij.coachingEnabled === true && cj.coachingEnabled === true);

  I.send({ type: 'interview_start' });
  await I.wait((m) => m.type === 'interview_state' && m.interview.status === 'LIVE');
  I.send({ type: 'audio_start', format: 'pcm16', sampleRate: 16000, channels: 1 });
  await I.wait((m) => m.type === 'transcription_state', 20000); // 'transcribing' only arrives once Deepgram sees audio

  console.log('\nInterviewer speaks (real audio → Deepgram)…');
  const spokeAt = Date.now();
  await speak(I, QUESTION);

  const final = await I.wait((m) => m.type === 'transcript_final' && m.speaker === 'interviewer', 30000);
  check('real speech → FINAL transcript', final.text.length > 5, `"${final.text}" in ${Date.now() - spokeAt}ms`);

  const q = await C.wait((m) => m.type === 'coaching_question', 20000);
  check('transcript → question detected → coaching started', !!q.questionId, `"${q.question}"`);

  const firstDelta = await C.wait((m) => m.type === 'coaching_delta', 40000).catch((e) => {
    console.log('  candidate received:', JSON.stringify(C.all.map((m) => m.type)));
    console.log('  coaching messages:', JSON.stringify(C.all.filter((m) => m.type.startsWith('coaching')), null, 1).slice(0, 800));
    throw e;
  });
  check('hints stream to the candidate', !!firstDelta.text, `first chunk: ${firstDelta.section}`);

  const done = await C.wait((m) => m.type === 'coaching_state' && (m.state === 'complete' || m.state === 'error'), 60000);
  check('coaching completed', done.state === 'complete', done.error || '');

  const sections = {};
  for (const m of C.all.filter((x) => x.type === 'coaching_delta')) {
    sections[m.section] = (sections[m.section] || '') + m.text;
  }
  console.log('\n--- what the candidate saw ---');
  for (const [k, v] of Object.entries(sections)) console.log(`${k}:\n${v.trim()}\n`);

  check('all four sections produced', ['HINTS', 'STRUCTURE', 'GROUNDING', 'CAUTION'].every((s) => sections[s]?.trim()));
  check('hints are short, not a scripted answer', (sections.HINTS || '').length < 600, `${(sections.HINTS || '').length} chars`);
  check('exactly one coaching run for one question', C.all.filter((m) => m.type === 'coaching_question').length === 1);
  check('interviewer never received coaching content',
    !I.all.some((m) => m.type === 'coaching_delta' || m.type === 'coaching_state'));
  check('interviewer was told coaching is active', I.all.some((m) => m.type === 'coaching_activity'));

  I.send({ type: 'interview_end' });
  await sleep(500);
  I.ws.close();
  C.ws.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('crashed:', e.message); process.exit(2); });
