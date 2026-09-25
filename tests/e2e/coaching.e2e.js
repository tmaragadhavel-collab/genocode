// Candidate coaching over the real WebSocket: interviewer speech → STT → question
// → one LLM request → streamed hints to the candidate only.
// Usage: node tests/e2e/coaching.e2e.js <port> <fakeWhisperControlUrl>
const { createChecker, http, wsClient, type, keyOf, sleep, finish, speak, startAudio } = require('./helpers');

const [port, controlUrl] = process.argv.slice(2);
const api = http(`http://localhost:${port}`);
const c = createChecker();
// Earlier suites leave the fake STT in whatever mode they finished in.
const setMode = (mode) => fetch(controlUrl, { method: 'POST', body: mode });

/** Names the step in the failure, so a hang says which stage never happened. */
const waitFor = (label, client, pred, ms = 30000) => client.wait(pred, ms).catch((e) => {
  console.log(`  (timed out waiting for ${label}; saw: ${[...new Set(client.all.map((m) => m.type))].join(', ')})`);
  throw e;
});

const settled = (m) => m.type === 'coaching_state' && (m.state === 'complete' || m.state === 'error');

async function newInterview(cookie, coaching) {
  const iv = (await api('POST', '/api/interviews', {
    candidateName: 'Coach Test', position: 'Backend', durationMinutes: 30, candidateCoaching: coaching,
  }, cookie)).body;
  const Ij = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'interviewer' }, cookie)).body;
  const Cj = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key: keyOf(iv.candidateUrl) })).body;
  const I = await wsClient(port);
  const C = await wsClient(port);
  I.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Ij.participantKey });
  const ij = await I.wait(type('session_joined'));
  C.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Cj.participantKey });
  const cj = await C.wait(type('session_joined'));
  I.send({ type: 'interview_start' });
  await I.wait((m) => m.type === 'interview_state' && m.interview.status === 'LIVE');
  startAudio(I);
  startAudio(C);
  return { iv, I, C, ij, cj };
}

(async () => {
  await setMode('ok');
  const A = (await api('POST', '/api/auth/signup', { email: `coach.${Date.now()}@example.com`, password: 'long enough password', name: 'Coach Owner' })).cookie;

  // --- Coaching ON ---
  const { I, C, ij, cj } = await newInterview(A, true);
  c.check('both roles told coaching is on (disclosure)', ij.coachingEnabled === true && cj.coachingEnabled === true);

  await setMode('question'); // the interviewer's speech transcribes as a question
  await speak(I);
  await waitFor('interviewer transcript_final', I, (m) => m.type === 'transcript_final' && m.speaker === 'interviewer');

  const q = await waitFor('coaching_question', C, type('coaching_question'), 20000);
  c.check('interviewer speech became a coaching question', !!q.questionId && q.question.length > 10, `"${q.question}"`);

  const delta = await waitFor('coaching_delta', C, type('coaching_delta'), 40000);
  c.check('hints stream to the candidate', !!delta.text && ['HINTS', 'STRUCTURE', 'GROUNDING', 'CAUTION'].includes(delta.section),
    `${delta.section}`);

  const done = await waitFor('coaching_state complete', C, settled, 60000);
  c.check('coaching completes', done.state === 'complete', done.error || '');

  const hints = C.all.filter((m) => m.type === 'coaching_delta' && m.section === 'HINTS').map((m) => m.text).join('');
  c.check('hints are bullets, not a scripted answer', hints.includes('-') && hints.length < 600, `${hints.length} chars`);

  // Exactly one LLM run per detected question.
  const questions = C.all.filter((m) => m.type === 'coaching_question');
  c.check('one question → one coaching run', questions.length === 1, `${questions.length} run(s)`);

  // Privacy: the interviewer is told coaching is active but sees no content.
  c.check('interviewer sees coaching activity, never its content',
    I.all.some((m) => m.type === 'coaching_activity')
    && !I.all.some((m) => m.type === 'coaching_delta' || m.type === 'coaching_state'));

  // The interviewer repeating the same question must not start a second run.
  await speak(I);
  await sleep(5000);
  c.check('the same question again → still one run',
    C.all.filter((m) => m.type === 'coaching_question').length === 1,
    `${C.all.filter((m) => m.type === 'coaching_question').length} run(s)`);

  // Candidate speech must not trigger coaching.
  await setMode('ok'); // candidate speech transcribes as an answer
  const before = C.all.filter((m) => m.type === 'coaching_question').length;
  await speak(C);
  await sleep(5000);
  c.check('candidate speech does not trigger coaching',
    C.all.filter((m) => m.type === 'coaching_question').length === before);

  // A different question gets its own run and its own id.
  await setMode('question2');
  await speak(I);
  const q2 = await waitFor('second coaching_question', C, (m) => m.type === 'coaching_question' && m.questionId !== q.questionId, 30000);
  c.check('a different question starts a new run with a new id', q2.questionId !== q.questionId, `"${q2.question}"`);
  await waitFor('second coaching settles', C, (m) => settled(m) && m.questionId === q2.questionId, 60000);
  I.ws.close();
  C.ws.close();

  // --- Coaching OFF (the default) ---
  const off = await newInterview(A, false);
  c.check('coaching off by default', off.ij.coachingEnabled === false && off.cj.coachingEnabled === false);
  await setMode('question');
  await speak(off.I);
  await waitFor('interviewer transcript (coaching off)', off.I, (m) => m.type === 'transcript_final' && m.speaker === 'interviewer');
  await sleep(4000);
  c.check('no coaching when the interview did not enable it',
    !off.C.all.some((m) => m.type.startsWith('coaching_')));
  c.check('transcription still works with coaching off',
    off.I.all.some((m) => m.type === 'transcript_final'));
  off.I.ws.close();
  off.C.ws.close();
})().then(() => finish(c)).catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
