// LLM failure: evaluation_error is emitted with a safe message, the session
// stays LIVE, retry is offered, chat fails gracefully, the report still builds.
// Run against a server whose LLM is broken (bad key or failing endpoint).
// Usage: node tests/e2e/llm-failure.e2e.js <port>
const { createChecker, http, wsClient, type, keyOf, finish } = require('./helpers');

const [port] = process.argv.slice(2);
const api = http(`http://localhost:${port}`);
const c = createChecker();

(async () => {
  const A = (await api('POST', '/api/auth/signup', { email: `llmfail.${Date.now()}@example.com`, password: 'long enough password', name: 'Failure Tester' })).cookie;
  const iv = (await api('POST', '/api/interviews', { candidateName: 'Fay Lure', position: 'Backend', durationMinutes: 30 }, A)).body;
  const Ij = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'interviewer' }, A)).body;
  const Cj = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key: keyOf(iv.candidateUrl) })).body;
  const I = await wsClient(port);
  const C = await wsClient(port);
  I.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Ij.participantKey });
  const ij = await I.wait(type('session_joined'));
  C.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Cj.participantKey });
  await C.wait(type('session_joined'));
  c.check('server reports an AI evaluator (not demo mode)', ij.evaluator === 'llm');
  I.send({ type: 'interview_start' });
  await I.wait((m) => m.type === 'interview_state' && m.interview.status === 'LIVE');

  I.send({ type: 'question_start', questionText: 'What is the difference between a process and a thread?',
    expectedConcepts: ['process is an independent program in execution', 'threads share the memory of their process'] });
  const q = (await I.wait(type('question_started'))).question;
  I.send({ type: 'transcript_final', speaker: 'candidate', text: 'A process is an executing program and a thread is a smaller execution unit inside a process. Threads in the same process share memory.' });
  await I.wait((m) => m.type === 'transcript_final');
  I.send({ type: 'question_end' });
  await I.wait(type('evaluation_started'));
  const started = Date.now();
  const res = await I.wait((m) => m.type === 'evaluation_error' || m.type === 'evaluation_completed', 90000);
  c.check('evaluation_error emitted', res.type === 'evaluation_error' && res.questionId === q.questionId,
    `after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  c.check('safe message, retry offered, no provider details', res.message === 'AI evaluation temporarily unavailable.' && res.retryable === true
    && !/groq|gemini|401|key|http/i.test(JSON.stringify(res)));

  // The interview continues: state is LIVE and new questions work.
  const list = await api('GET', '/api/interviews', undefined, A);
  c.check('session stays LIVE', list.body.interviews.find((x) => x.sessionId === iv.sessionId)?.status === 'LIVE');
  I.send({ type: 'question_start', questionText: 'What is a mutex?' });
  c.check('interview continues (next question starts)', (await I.wait(type('question_started'))).question.index === 2);
  C.send({ type: 'ping' });
  c.check('candidate connection unaffected', !!(await C.wait(type('pong'))));
  c.check('candidate received no evaluation error', !C.all.some((m) => m.type === 'evaluation_error'));

  // Chat also fails gracefully.
  C.send({ type: 'chat_message', sessionId: iv.sessionId, sender: 'candidate', message: 'Hello' });
  const chat = await C.wait((m) => m.type === 'chat_error' || m.type === 'chat_response', 90000);
  c.check('chat failure → friendly chat_error', chat.type === 'chat_error' && /could not be generated/i.test(chat.message));

  // Ending still produces a report (without AI parts).
  I.send({ type: 'question_end' });
  I.send({ type: 'interview_end' });
  const rs = await I.wait((m) => m.type === 'report_status' && m.reportStatus !== 'generating', 120000);
  const rep = (await api('GET', `/api/interviews/${iv.sessionId}/report`, undefined, A)).body;
  c.check('report still generated; data saved', rs.reportStatus === 'ready' && rep.report.questionsAsked === 2 && rep.report.aiSummaryStatus === 'unavailable'
    && rep.questions[0].answer.length > 20);
  I.ws.close();
  C.ws.close();
})().then(() => finish(c)).catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
