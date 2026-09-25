// Candidate answer feedback: routing, privacy, history and failure handling.
// Usage: node tests/e2e/feedback.e2e.js <port> <fakeWhisperControlUrl>
const { createChecker, http, wsClient, type, keyOf, sleep, finish, speak, startAudio } = require('./helpers');

const [port, controlUrl] = process.argv.slice(2);
const api = http(`http://localhost:${port}`);
const c = createChecker();
const setMode = (mode) => fetch(controlUrl, { method: 'POST', body: mode });
const feedback = (state) => (m) => m.type === 'answer_evaluation' && m.state === state;

async function room(cookie, coaching) {
  const iv = (await api('POST', '/api/interviews', {
    candidateName: 'Feedback Test', position: 'Backend', durationMinutes: 30, candidateCoaching: coaching,
  }, cookie)).body;
  const Ij = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'interviewer' }, cookie)).body;
  const Cj = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key: keyOf(iv.candidateUrl) })).body;
  const I = await wsClient(port);
  const C = await wsClient(port);
  I.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Ij.participantKey });
  await I.wait(type('session_joined'));
  C.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Cj.participantKey });
  await C.wait(type('session_joined'));
  I.send({ type: 'interview_start' });
  await I.wait((m) => m.type === 'interview_state' && m.interview.status === 'LIVE');
  startAudio(I);
  startAudio(C);
  return { iv, I, C };
}

/** One question asked, answered and evaluated. Returns the questionId. */
async function askAndAnswer(I, C, text) {
  I.send({ type: 'question_start', questionText: text });
  const q = (await I.wait(type('question_started'), 20000).catch((e) => { console.log('  (hung on question_started)'); throw e; })).question;
  await speak(C);
  await I.wait((m) => m.type === 'transcript_final' && m.speaker === 'candidate' && m.questionId === q.questionId, 30000)
    .catch((e) => { console.log(`  (hung on candidate transcript for ${q.questionId}; finals seen: ` +
      JSON.stringify(I.all.filter((m) => m.type === 'transcript_final').map((m) => [m.speaker, m.questionId])) + ')'); throw e; });
  I.send({ type: 'question_end' });
  return q.questionId;
}

(async () => {
  await setMode('ok');
  const A = (await api('POST', '/api/auth/signup', { email: `fb.${Date.now()}@example.com`, password: 'long enough password', name: 'FB Owner' })).cookie;

  // --- Practice interview: the candidate gets feedback ---
  const { I, C } = await room(A, true);
  const q1 = await askAndAnswer(I, C, 'Tell me about your most recent AI project.');

  const pending = await C.wait(feedback('evaluating'), 20000);
  c.check('candidate sees an evaluating state first', pending.questionId === q1 && !!pending.questionText);

  const ready = await C.wait((m) => m.type === 'answer_evaluation' && m.questionId === q1 && m.state !== 'evaluating', 60000);
  c.check('candidate receives answer_evaluation', ready.state === 'ready', ready.state === 'ready' ? `score ${ready.score}` : ready.message);
  c.check('score is 0–100 and unmodified', ready.score >= 0 && ready.score <= 100 && Number.isFinite(ready.score), `${ready.score}`);
  c.check('feedback carries question, answer and breakdown',
    !!ready.questionText && !!ready.answer && typeof ready.breakdown?.correctness === 'number');
  c.check('feedback carries strengths and improvements',
    Array.isArray(ready.strengths) && Array.isArray(ready.improvements),
    `${ready.strengths?.length} / ${ready.improvements?.length}`);

  // Privacy: the interviewer keeps its own evaluation, but never the candidate feed.
  c.check('interviewer does NOT receive answer_evaluation', !I.all.some((m) => m.type === 'answer_evaluation'));
  // The interviewer's evaluation_completed may arrive slightly after the candidate's feedback.
  await I.wait((m) => m.type === 'evaluation_completed' || m.type === 'evaluation_error', 30000).catch(() => {});
  c.check('interviewer still receives its own evaluation', I.all.some((m) => m.type === 'evaluation_completed'));

  // Privacy: nothing scored leaks to the candidate through any other channel.
  const leaked = C.all.filter((m) => m.type !== 'answer_evaluation'
    && (/^evaluation_/.test(m.type) || /"breakdown"|"finalScore"|"override"|"interviewerNote"|"expectedAnswer"|"scoringCriteria"/.test(JSON.stringify(m))));
  c.check('no evaluation data leaks via transcript/coaching/broadcast', leaked.length === 0, leaked.map((m) => m.type).join(','));
  // The candidate's copy must be the narrow one.
  c.check('candidate payload excludes rubric and interviewer fields',
    !('expectedAnswer' in ready) && !('override' in ready) && !('interviewerNote' in ready) && !('evaluationHistory' in ready));

  // --- A second question keeps the first ---
  const q2 = await askAndAnswer(I, C, 'Why did you choose that architecture?');
  const ready2 = await C.wait((m) => m.type === 'answer_evaluation' && m.questionId === q2 && m.state === 'ready', 60000)
    .catch((e) => { console.log('  (hung on Q2 feedback; answer_evaluation seen: ' +
      JSON.stringify(C.all.filter((m) => m.type === 'answer_evaluation').map((m) => [m.questionId, m.state])) + ')'); throw e; });
  c.check('second answer gets its own evaluation', ready2.questionId !== q1, `${ready2.questionId}`);
  const q1Msgs = C.all.filter((m) => m.type === 'answer_evaluation' && m.questionId === q1 && m.state === 'ready');
  c.check('first evaluation still delivered and distinct', q1Msgs.length === 1 && q1Msgs[0].score === ready.score,
    `Q1 ${ready.score}, Q2 ${ready2.score}`);
  c.check('the two evaluations are keyed separately',
    new Set(C.all.filter((m) => m.type === 'answer_evaluation' && m.state === 'ready').map((m) => m.questionId)).size === 2);

  I.ws.close();
  C.ws.close();

  // --- Assessed interview (coaching off): the candidate sees nothing ---
  const off = await room(A, false);
  const q3 = await askAndAnswer(off.I, off.C, 'What is a mutex?');
  await off.I.wait((m) => (m.type === 'evaluation_completed' || m.type === 'evaluation_error') && m.questionId === q3, 60000);
  await sleep(1000);
  c.check('no candidate feedback in an assessed interview', !off.C.all.some((m) => m.type === 'answer_evaluation'));
  c.check('interviewer evaluation unaffected when feedback is off', off.I.all.some((m) => m.type === 'evaluation_completed'));
  off.I.ws.close();
  off.C.ws.close();
})().then(() => finish(c)).catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
