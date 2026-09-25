// Restart recovery: a LIVE interview must come back with status, timer,
// questions, transcript, evaluations, overrides, notes and credentials.
// Phase "before" runs against server #1, phase "after" against server #2
// (started on the same database after a hard kill). Usage:
//   node tests/e2e/restore.e2e.js <port> before|after <stateFile>
const fs = require('fs');
const { createChecker, http, wsClient, type, keyOf, sleep, finish } = require('./helpers');

const [port, phase, stateFile] = process.argv.slice(2);
const api = http(`http://localhost:${port}`);
const c = createChecker();

async function before() {
  const email = `restore.${Date.now()}@example.com`;
  const A = (await api('POST', '/api/auth/signup', { email, password: 'long enough password', name: 'Restore Tester' })).cookie;
  const iv = (await api('POST', '/api/interviews', {
    candidateName: 'Rita Restore', position: 'SRE', durationMinutes: 30,
    plannedQuestions: [{ text: 'What is the difference between a process and a thread?', skills: ['OS'],
      expectedConcepts: ['process is an independent program in execution', 'threads share the memory of their process', 'context switching cost'] }],
  }, A)).body;
  const Ij = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'interviewer' }, A)).body;
  const Cj = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key: keyOf(iv.candidateUrl) })).body;
  const I = await wsClient(port);
  I.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Ij.participantKey });
  const ij = await I.wait(type('session_joined'));
  I.send({ type: 'interview_start' });
  await I.wait((m) => m.type === 'interview_state' && m.interview.status === 'LIVE');

  I.send({ type: 'question_start', plannedQuestionId: ij.plannedQuestions[0].id });
  const q1 = (await I.wait(type('question_started'))).question;
  I.send({ type: 'transcript_final', speaker: 'candidate', text: 'A process is an executing program; threads share the memory of their process.' });
  await I.wait((m) => m.type === 'transcript_final');
  I.send({ type: 'question_end' });
  const ev = await I.wait((m) => m.type === 'evaluation_completed' || m.type === 'evaluation_error');
  c.check('before: Q1 evaluated', ev.type === 'evaluation_completed', `score ${ev.score}`);
  I.send({ type: 'evaluation_override', questionId: q1.questionId, score: 81, reason: 'Good verbal follow-up' });
  await I.wait(type('evaluation_updated'));
  I.send({ type: 'note_save', text: 'Strong on OS fundamentals.' });
  await I.wait((m) => m.type === 'notes_updated');

  // Q2 left open with a partial answer when the server dies.
  I.send({ type: 'question_start', questionText: 'Explain virtual memory.' });
  const q2 = (await I.wait(type('question_started'))).question;
  I.send({ type: 'transcript_final', speaker: 'candidate', text: 'Virtual memory maps addresses to physical pages.' });
  await I.wait((m) => m.type === 'transcript_final');

  I.send({ type: 'ping' });
  await I.wait(type('pong'));
  await sleep(1500); // > one autosave interval
  fs.writeFileSync(stateFile, JSON.stringify({
    cookie: A, sessionId: iv.sessionId, candidateKey: keyOf(iv.candidateUrl),
    oldCandidateParticipantKey: Cj.participantKey, q1: q1.questionId, q2: q2.questionId,
    aiScore: ev.score, savedAt: Date.now(),
  }));
  I.ws.close();
}

async function after() {
  const s = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  const r = await api('GET', '/api/interviews', undefined, s.cookie);
  c.check('after: login session restored', r.status === 200);
  c.check('after: interview listed as LIVE', r.body?.interviews?.some((x) => x.sessionId === s.sessionId && x.status === 'LIVE'));

  // A participant key issued before the restart still authenticates (hashed in the DB).
  const old = await wsClient(port);
  old.send({ type: 'session_join', sessionId: s.sessionId, participantKey: s.oldCandidateParticipantKey });
  const oj = await old.wait((m) => m.type === 'session_joined' || m.type === 'error');
  c.check('after: pre-restart participant key still valid', oj.type === 'session_joined' && oj.role === 'candidate');
  old.ws.close();

  const Ij = (await api('POST', `/api/interviews/${s.sessionId}/join`, { role: 'interviewer' }, s.cookie)).body;
  const I = await wsClient(port);
  I.send({ type: 'session_join', sessionId: s.sessionId, participantKey: Ij.participantKey });
  const j = await I.wait(type('session_joined'));
  const iv = j.interview;
  const downMs = Date.now() - s.savedAt;
  c.check('after: status LIVE', iv.status === 'LIVE');
  // Time keeps running while the server is down (the video call continues).
  const elapsedSec = Math.round(iv.elapsedMs / 1000);
  c.check('after: timer computed from stored start/elapsed', iv.remainingMs < 30 * 60000 && iv.remainingMs > 25 * 60000 && iv.elapsedMs >= downMs,
    `elapsed ${elapsedSec}s (server down ~${Math.round(downMs / 1000)}s), remaining ${Math.round(iv.remainingMs / 1000)}s`);
  const q1 = j.questions.find((q) => q.questionId === s.q1);
  const q2 = j.questions.find((q) => q.questionId === s.q2);
  c.check('after: questions restored', j.questions.length === 2 && !!q1 && !!q2);
  c.check('after: Q1 evaluation + history restored', q1.evaluation?.score === s.aiScore && q1.evaluationHistory.length === 1);
  c.check('after: override restored (AI score kept)', q1.override?.finalScore === 81 && q1.override.aiScore === s.aiScore && q1.finalScore === 81);
  c.check('after: open question still open with its answer', j.currentQuestionId === s.q2 && q2.answer.includes('Virtual memory'));
  c.check('after: transcript restored', j.transcript.length === 2);
  c.check('after: notes restored', j.generalNotes === 'Strong on OS fundamentals.');

  // The interview carries on normally.
  I.send({ type: 'question_end' });
  const ev2 = await I.wait((m) => m.type === 'evaluation_completed' || m.type === 'evaluation_error');
  c.check('after: open answer evaluated after restart', ev2.type === 'evaluation_completed' && ev2.questionId === s.q2);
  I.send({ type: 'interview_end' });
  const rs = await I.wait((m) => m.type === 'report_status' && m.reportStatus !== 'generating', 60000);
  c.check('after: report generated', rs.reportStatus === 'ready');
  I.ws.close();
}

(phase === 'before' ? before() : after()).then(() => finish(c)).catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
