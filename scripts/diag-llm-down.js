/**
 * TEST 9 — the LLM is unreachable while speech transcription is real.
 * Verifies the interview keeps running, Deepgram keeps transcribing, and the
 * candidate is shown an honest coaching error rather than a crash or silence.
 *
 * Usage: node scripts/diag-llm-down.js [port]
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const port = process.argv[2] || '3078';
const base = `http://localhost:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!ok) failures++; };

function pcmOf(name) {
  const buf = fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', name));
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}
const Q1 = pcmOf('q-what-is-python.wav');
const Q2 = pcmOf('q-why-technology.wav');

async function api(method, url, body, cookie) {
  const r = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, body: await r.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null };
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/?view=room`);
    const all = []; const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()); all.push(m);
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.t); w.resolve(m); }
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws, all,
      send: (o) => ws.send(JSON.stringify(o)),
      sendBinary: (b) => ws.send(b, { binary: true }),
      count: (t) => all.filter((m) => m.type === t).length,
      wait: (pred, ms = 30000) => new Promise((res, rej) => {
        const hit = all.find(pred); if (hit) return res(hit);
        const w = { pred, resolve: res };
        w.t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout')); }, ms);
        waiters.push(w);
      }),
    }));
  });
}

async function speak(client, pcm) {
  const frame = 3200;
  const audio = Buffer.concat([pcm, Buffer.alloc(1500 * 32)]);
  for (let i = 0; i < audio.length; i += frame) { client.sendBinary(audio.subarray(i, i + frame)); await sleep(100); }
}

(async () => {
  const h = (await api('GET', '/health')).body;
  console.log(`Providers: stt=${h.providers.stt} ai=${h.providers.ai}\n`);

  // Preflight: verify the LLM is actually unreachable. If it works, this test
  // is meaningless — skip with an informative message.
  const probe = await api('POST', '/api/auth/signup', {
    email: `probe.${Date.now()}@example.com`, password: 'long enough password', name: 'Probe',
  });
  const probeCookie = probe.cookie;
  const probeIv = (await api('POST', '/api/interviews', {
    candidateName: 'Probe', position: 'Dev', durationMinutes: 5, candidateCoaching: true,
  }, probeCookie)).body;
  const probeIj = (await api('POST', `/api/interviews/${probeIv.sessionId}/join`, { role: 'interviewer' }, probeCookie)).body;
  const probeKey = new URL(probeIv.candidateUrl).searchParams.get('key');
  const probeCj = (await api('POST', `/api/interviews/${probeIv.sessionId}/join`, { role: 'candidate', key: probeKey })).body;
  const pI = await connect(); const pC = await connect();
  pI.send({ type: 'session_join', sessionId: probeIv.sessionId, participantKey: probeIj.participantKey });
  await pI.wait((m) => m.type === 'session_joined');
  pC.send({ type: 'session_join', sessionId: probeIv.sessionId, participantKey: probeCj.participantKey });
  await pC.wait((m) => m.type === 'session_joined');
  pI.send({ type: 'interview_start' });
  await pI.wait((m) => m.type === 'interview_state' && m.interview.status === 'LIVE');
  pI.send({ type: 'audio_start', format: 'pcm16', sampleRate: 16000, channels: 1 });
  await sleep(1500);
  await speak(pI, Q1);
  await pI.wait((m) => m.type === 'transcript_final' && m.speaker === 'interviewer', 30000);
  const probeQ = await pC.wait((m) => m.type === 'coaching_question', 25000);
  const probeState = await pC.wait(
    (m) => m.type === 'coaching_state' && m.questionId === probeQ.questionId && (m.state === 'error' || m.state === 'complete'),
    100000
  );
  pI.send({ type: 'interview_end' }); await sleep(300);
  pI.ws.close(); pC.ws.close();
  if (probeState.state === 'complete') {
    console.log('SKIP — LLM is reachable (coaching completed successfully).');
    console.log('This test requires a dead LLM endpoint. Start the server with:');
    console.log('  AI_BASE_URL=http://127.0.0.1:1 node server/index.ts');
    console.log('\nALL PASSED (skipped — LLM is live)');
    process.exit(0);
  }
  console.log('Preflight confirmed: LLM is unreachable (coaching errored). Running full test.\n');

  const A = (await api('POST', '/api/auth/signup', {
    email: `down.${Date.now()}@example.com`, password: 'long enough password', name: 'Down Owner',
  })).cookie;
  const iv = (await api('POST', '/api/interviews', {
    candidateName: 'Down Candidate', position: 'AI Engineer', durationMinutes: 30, candidateCoaching: true,
  }, A)).body;
  const Ij = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'interviewer' }, A)).body;
  const key = new URL(iv.candidateUrl).searchParams.get('key');
  const Cj = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key })).body;

  const I = await connect(); const C = await connect();
  I.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Ij.participantKey });
  await I.wait((m) => m.type === 'session_joined');
  C.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Cj.participantKey });
  await C.wait((m) => m.type === 'session_joined');
  I.send({ type: 'interview_start' });
  await I.wait((m) => m.type === 'interview_state' && m.interview.status === 'LIVE');
  I.send({ type: 'audio_start', format: 'pcm16', sampleRate: 16000, channels: 1 });
  await sleep(1500);

  await speak(I, Q1);
  const final = await I.wait((m) => m.type === 'transcript_final' && m.speaker === 'interviewer', 30000);
  check('Deepgram keeps transcribing while the LLM is down', final.text.length > 3, `"${final.text}"`);

  const q = await C.wait((m) => m.type === 'coaching_question', 25000);
  check('question still detected', !!q.questionId, `"${q.question}"`);

  const err = await C.wait((m) => m.type === 'coaching_state' && m.state === 'error', 90000);
  check('candidate shown an honest error state', err.error === 'AI coaching temporarily unavailable', err.error);
  check('no provider internals leaked to the client',
    !/api[_-]?key|sk-|gsk_|ECONNREFUSED|stack|127\.0\.0\.1/i.test(JSON.stringify(C.all)));
  check('no partial/garbled coaching rendered', C.count('coaching_delta') === 0, `${C.count('coaching_delta')} delta(s)`);

  I.send({ type: 'ping' });
  check('interview still responsive (no crash)', !!(await I.wait((m) => m.type === 'pong', 10000)));
  const state = await api('GET', '/api/interviews', undefined, A);
  check('interview still LIVE', state.body.interviews.find((x) => x.sessionId === iv.sessionId)?.status === 'LIVE');

  // Recovery path: a later question is attempted again, not permanently disabled.
  await speak(I, Q2);
  const q2 = await C.wait((m) => m.type === 'coaching_question' && m.questionId !== q.questionId, 30000);
  check('later questions are still attempted (not disabled)', !!q2.questionId, `"${q2.question}"`);
  const st2 = await C.wait((m) => m.type === 'coaching_state' && m.questionId === q2.questionId
    && (m.state === 'error' || m.state === 'complete'), 90000);
  check('second attempt also resolves cleanly', !!st2.state, st2.state);

  // Answer feedback must fail the same way: honest message, no crash.
  I.send({ type: 'question_start', questionText: 'Tell me about your most recent project.' });
  const q3 = (await I.wait((m) => m.type === 'question_started', 20000)).question;
  I.send({ type: 'transcript_final', speaker: 'candidate', text: 'I built an AI career assistant using Python and a retrieval step over job descriptions.' });
  await I.wait((m) => m.type === 'transcript_final' && m.speaker === 'candidate' && m.questionId === q3.questionId, 20000);
  I.send({ type: 'question_end' });
  const evaluating = await C.wait((m) => m.type === 'answer_evaluation' && m.state === 'evaluating' && m.questionId === q3.questionId, 20000);
  check('candidate sees "evaluating" before the failure', !!evaluating.questionText);
  const fbErr = await C.wait((m) => m.type === 'answer_evaluation' && m.questionId === q3.questionId && m.state !== 'evaluating', 90000);
  check('candidate shown an honest feedback error', fbErr.state === 'error' && fbErr.message === 'Answer evaluation unavailable.', fbErr.message);
  check('feedback failure leaks nothing', !/api[_-]?key|sk-|gsk_|ECONNREFUSED|127\.0\.0\.1/i.test(JSON.stringify(fbErr)));

  const cFinals = I.all.filter((m) => m.type === 'transcript_final').length;
  check('transcription unaffected throughout', cFinals >= 2, `${cFinals} final transcript(s)`);

  I.send({ type: 'interview_end' });
  await sleep(500);
  I.ws.close(); C.ws.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('crashed:', e.message); process.exit(2); });
