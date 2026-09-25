// Transcript correction + re-evaluation: interviewer/owner only, original kept,
// every evaluation run kept as history, report refreshed after the interview.
// Usage: node tests/e2e/corrections.e2e.js <port> <fakeWhisperControlUrl>
const fs = require('fs');
const path = require('path');
const { createChecker, http, wsClient, type, keyOf, sleep, finish } = require('./helpers');

const [port, controlUrl] = process.argv.slice(2);
const api = http(`http://localhost:${port}`);
const c = createChecker();
const setMode = (mode) => fetch(controlUrl, { method: 'POST', body: mode });
const segment = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'process-vs-thread.wav')).subarray(44).toString('base64');
const settled = (qid) => (m) => (m.type === 'evaluation_completed' || m.type === 'evaluation_error') && m.questionId === qid;

(async () => {
  const A = (await api('POST', '/api/auth/signup', { email: `fix.${Date.now()}@example.com`, password: 'long enough password', name: 'Correction Tester' })).cookie;
  const B = (await api('POST', '/api/auth/signup', { email: `other.${Date.now()}@example.com`, password: 'long enough password', name: 'Other' })).cookie;
  const iv = (await api('POST', '/api/interviews', { candidateName: 'Cora Rection', position: 'Backend', durationMinutes: 30 }, A)).body;
  const Ij = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'interviewer' }, A)).body;
  const Cj = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key: keyOf(iv.candidateUrl) })).body;
  const I = await wsClient(port);
  const C = await wsClient(port);
  I.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Ij.participantKey });
  await I.wait(type('session_joined'));
  C.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Cj.participantKey });
  await C.wait(type('session_joined'));
  I.send({ type: 'interview_start' });
  await I.wait((m) => m.type === 'interview_state' && m.interview.status === 'LIVE');

  I.send({ type: 'question_start', questionText: 'What is the difference between a process and a thread?',
    expectedConcepts: ['process is an independent program in execution', 'threads share the memory of their process', 'context switching cost'] });
  const q = (await I.wait(type('question_started'))).question;
  await setMode('low');
  C.send({ type: 'audio_segment', data: segment });
  await I.wait((m) => m.type === 'transcript_final' && m.speaker === 'candidate');
  await setMode('ok');

  I.send({ type: 'answer_edit', questionId: q.questionId, text: 'x' });
  c.check('cannot edit while the question is open', (await I.wait(type('error'))).code === 'invalid_edit');
  I.send({ type: 'question_end' });
  const first = await I.wait(settled(q.questionId));
  c.check('first evaluation; answer flagged low-confidence', first.type === 'evaluation_completed' && first.question.lowConfidence === true, `score ${first.score}`);

  C.send({ type: 'answer_edit', questionId: q.questionId, text: 'hacked' });
  c.check('candidate cannot edit answers', (await C.wait(type('error'))).code === 'forbidden');
  C.send({ type: 'evaluation_reevaluate', questionId: q.questionId });
  c.check('candidate cannot re-evaluate', (await C.wait(type('error'))).code === 'forbidden');

  const corrected = 'A process is an independent program in execution with its own memory space. Threads share the memory of their process, and switching between threads has a lower context switching cost.';
  I.send({ type: 'answer_edit', questionId: q.questionId, text: corrected });
  const edited = (await I.wait((m) => m.type === 'evaluation_updated' && m.question.editedAnswer)).question;
  c.check('edit stored with original kept + editor recorded', edited.editedAnswer === corrected && edited.answer.startsWith('A process is an executing')
    && edited.editedBy === 'Correction Tester' && edited.editedAt > 0);

  I.send({ type: 'evaluation_reevaluate', questionId: q.questionId });
  const second = await I.wait(settled(q.questionId));
  const h = second.question.evaluationHistory;
  c.check('re-evaluation adds a history row (never overwrites)', h.length === 2 && h[0].id !== h[1].id && h[0].score === first.score);
  c.check('latest run used the edited text', h[1].answerSource === 'edited' && h[1].trigger === 'reevaluate' && h[1].answerText === corrected
    && h[0].answerSource === 'original', `scores ${h[0].score} → ${h[1].score}`);
  c.check('corrected answer covers more concepts', h[1].score > h[0].score);

  I.send({ type: 'answer_edit', questionId: q.questionId, text: null });
  const reverted = (await I.wait((m) => m.type === 'evaluation_updated' && m.question.editedAnswer === null)).question;
  c.check('revert to the original transcript', reverted.editedBy === null && reverted.evaluationHistory.length === 2);

  await sleep(300);
  const leaked = C.all.filter((m) => /^evaluation_|editedAnswer/.test(m.type + JSON.stringify(m)));
  c.check('candidate saw none of it', leaked.length === 0, leaked.map((m) => m.type).join(','));

  // After the interview: REST path from the report page.
  I.send({ type: 'interview_end' });
  await I.wait((m) => m.type === 'report_status' && m.reportStatus === 'ready', 30000);
  const url = `/api/interviews/${iv.sessionId}/questions/${q.questionId}`;
  c.check('report API: other interviewer blocked', (await api('PUT', `${url}/answer`, { text: 'x' }, B)).status === 403);
  c.check('report API: no login blocked', (await api('POST', `${url}/reevaluate`)).status === 401);
  let r = await api('PUT', `${url}/answer`, { text: corrected }, A);
  c.check('report API: owner edits answer', r.status === 200 && r.body.question.editedAnswer === corrected);
  const before = (await api('GET', `/api/interviews/${iv.sessionId}/report`, undefined, A)).body.report.generatedAt;
  r = await api('POST', `${url}/reevaluate`, undefined, A);
  c.check('report API: re-evaluate accepted', r.status === 202);
  let rep = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    rep = (await api('GET', `/api/interviews/${iv.sessionId}/report`, undefined, A)).body;
    if (rep.reportStatus === 'ready' && rep.report.generatedAt !== before) break;
  }
  const q3 = rep.questions.find((x) => x.questionId === q.questionId);
  c.check('report regenerated with the new evaluation', rep.report.generatedAt !== before && q3.evaluationHistory.length === 3
    && rep.report.questionResults[0].aiScore === q3.evaluation.score);
  I.ws.close();
  C.ws.close();
})().then(() => finish(c)).catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
