// Full workflow E2E. Usage: node tests/e2e/workflow.e2e.js <port> [phase=main|persist] [stateFile]
const path = require('path');
const fs = require('fs');
const WebSocket = require(path.join(process.cwd(), 'node_modules', 'ws'));

const PORT = process.argv[2] || '3099';
const PHASE = process.argv[3] || 'main';
const STATE_FILE = process.argv[4] || path.join(process.env.TEMP || '.', 'final_e2e_state.json');
const BASE = `http://localhost:${PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body, cookie) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = r.headers.get('set-cookie');
  return { status: r.status, body: await r.json().catch(() => null), cookie: setCookie ? setCookie.split(';')[0] : null, headers: r.headers };
}

function client() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/?view=room`);
    const inbox = [];
    const all = [];
    const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      all.push(m);
      const w = waiters.find((x) => x.pred(m));
      if (w) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(m); } else inbox.push(m);
    });
    ws.on('open', () => resolve({
      ws, inbox, all,
      send: (o) => ws.send(JSON.stringify(o)),
      wait: (pred, ms = 20000) => new Promise((res, rej) => {
        const i = inbox.findIndex(pred);
        if (i >= 0) return res(inbox.splice(i, 1)[0]);
        const w = { pred, resolve: res };
        w.t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout waiting')); }, ms);
        waiters.push(w);
      }),
    }));
    ws.on('error', reject);
  });
}
const type = (t) => (m) => m.type === t;
const keyOf = (u) => new URL(u).searchParams.get('key');

async function main() {
  const email = `priya.${Date.now()}@example.com`;
  const emailB = `other.${Date.now()}@example.com`;

  // --- Auth ---
  let r = await api('POST', '/api/interviews', { candidateName: 'x', position: 'y' });
  check('create interview requires login', r.status === 401);
  r = await api('POST', '/api/auth/signup', { email, password: 'short', name: 'Priya' });
  check('weak password rejected', r.status === 400, r.body?.error);
  r = await api('POST', '/api/auth/signup', { email, password: 'correct horse battery', name: 'Priya Shah' });
  const A = r.cookie;
  check('signup sets HttpOnly session cookie', r.status === 201 && !!A && /HttpOnly/i.test(r.headers.get('set-cookie')) && /SameSite=Lax/i.test(r.headers.get('set-cookie')));
  check('duplicate email rejected', (await api('POST', '/api/auth/signup', { email, password: 'correct horse battery', name: 'X' })).status === 409);
  check('wrong password rejected', (await api('POST', '/api/auth/login', { email, password: 'nope-nope-nope' })).status === 401);
  r = await api('POST', '/api/auth/login', { email, password: 'correct horse battery' });
  check('login works', r.status === 200 && !!r.cookie);
  const B = (await api('POST', '/api/auth/signup', { email: emailB, password: 'another long pass', name: 'Other Interviewer' })).cookie;

  // --- Create with configuration ---
  r = await api('POST', '/api/interviews', {
    candidateName: 'John Doe', candidateEmail: 'john@example.com', position: 'Backend Engineer',
    skills: ['Operating Systems', 'APIs'], difficulty: 'medium', durationMinutes: 30,
    plannedQuestions: [
      { text: 'What is the difference between a process and a thread?', skills: ['Operating Systems'],
        expectedConcepts: ['process is an independent program in execution', 'thread is a unit of execution within a process',
          'threads share the memory of their process', 'processes have separate memory spaces', 'context switching cost'] },
      { text: 'What is a REST API?', skills: ['APIs'], expectedConcepts: ['resources', 'HTTP methods', 'statelessness', 'status codes'] },
    ],
  }, A);
  const iv = r.body;
  check('interview created with planned questions', r.status === 201 && /^int_/.test(iv.sessionId) && !iv.interviewerUrl.includes('key='), iv.sessionId);
  r = await api('GET', '/api/interviews', undefined, A);
  check("dashboard lists owner's interview", r.body.interviews.some((x) => x.sessionId === iv.sessionId));
  r = await api('GET', '/api/interviews', undefined, B);
  check("other interviewer can't see it", !r.body.interviews.some((x) => x.sessionId === iv.sessionId));

  // --- Join authorization ---
  check('interviewer join without login → 401', (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'interviewer' })).status === 401);
  check("another interviewer can't join → 403", (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'interviewer' }, B)).status === 403);
  check('candidate wrong key → 403', (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key: 'x'.repeat(32) })).status === 403);
  check('unknown session → 404', (await api('POST', '/api/interviews/int_AAAAAAAAAAAAAAAAAAAAAAAA/join', { role: 'candidate', key: 'k' })).status === 404);
  check('legacy token endpoint refuses interview rooms', (await api('POST', '/livekit/token', { roomName: `interview_${iv.sessionId}`, participantName: 'x' })).status === 403);
  check("report hidden from candidate (no login)", (await api('GET', `/api/interviews/${iv.sessionId}/report`)).status === 401);
  check("report hidden from other interviewer", (await api('GET', `/api/interviews/${iv.sessionId}/report`, undefined, B)).status === 403);

  const Ij = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'interviewer' }, A)).body;
  const Cj = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key: keyOf(iv.candidateUrl) })).body;
  check('interviewer gets candidate link; candidate does not', !!Ij.candidateUrl && !('candidateUrl' in Cj));

  const I = await client();
  const C = await client();
  I.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Ij.participantKey });
  const ij = await I.wait(type('session_joined'));
  C.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Cj.participantKey });
  const cj = await C.wait(type('session_joined'));
  check('interviewer join has planned questions + notes', ij.plannedQuestions.length === 2 && ij.generalNotes === '');
  check('candidate join has no planned questions/notes/evaluator', !('plannedQuestions' in cj) && !('generalNotes' in cj) && !('evaluator' in cj) && !('questions' in cj));

  I.send({ type: 'interview_start' });
  await I.wait((m) => m.type === 'interview_state' && m.interview.status === 'LIVE');

  // --- Ask planned Q1, answer, evaluate ---
  I.send({ type: 'question_start', plannedQuestionId: ij.plannedQuestions[0].id });
  const q1 = (await I.wait(type('question_started')));
  check('planned question asked with its rubric + skills', q1.plannedQuestionId === ij.plannedQuestions[0].id
    && q1.question.expectedConcepts.length === 5 && q1.question.skills[0] === 'Operating Systems');
  const cq1 = await C.wait(type('question_started'));
  check('candidate sees only question text', Object.keys(cq1.question).sort().join() === 'index,questionId,questionText');

  C.send({ type: 'note_save', text: 'hacked' });
  check('candidate cannot write notes', (await C.wait(type('error'))).code === 'forbidden');
  I.send({ type: 'note_save', text: 'Calm, structured communicator.' });
  await I.wait((m) => m.type === 'notes_updated' && m.questionId === null);

  I.send({ type: 'transcript_final', speaker: 'candidate', text: 'A process is an executing program and a thread is a smaller execution unit inside a process. Threads in the same process share memory.' });
  await I.wait((m) => m.type === 'transcript_final' && m.speaker === 'candidate');
  I.send({ type: 'question_end' });
  await I.wait(type('evaluation_started'));
  const e1 = await I.wait((m) => m.type === 'evaluation_completed' || m.type === 'evaluation_error', 45000);
  check('Q1 evaluated', e1.type === 'evaluation_completed', `score ${e1.score}`);
  const q1id = q1.question.questionId;
  I.send({ type: 'note_save', questionId: q1id, text: 'Missed context switching.' });
  const qn = await I.wait((m) => m.type === 'notes_updated' && m.questionId === q1id);
  check('per-question note saved', qn.text === 'Missed context switching.');
  I.send({ type: 'note_save', questionId: 'q_999_zzzzzz', text: 'x' });
  check('note on invalid questionId rejected', (await I.wait(type('error'))).code === 'invalid_question');

  // --- Candidate disconnect / reconnect: same session, identity, state ---
  C.ws.close();
  await I.wait((m) => m.type === 'participant_left' && m.role === 'candidate');
  const Cj2 = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key: keyOf(iv.candidateUrl) })).body;
  check('reconnect: same LiveKit identity + room (no duplicate)', Cj2.identity === Cj.identity && Cj2.sessionId === Cj.sessionId);
  const C2 = await client();
  C2.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Cj2.participantKey });
  const cj2 = await C2.wait(type('session_joined'));
  check('reconnect: same interview state, transcript and chat', cj2.interview.status === 'LIVE' && cj2.transcript.length >= 1 && Array.isArray(cj2.history));
  r = await api('GET', '/api/interviews', undefined, A);
  check('no duplicate interview created', r.body.interviews.filter((x) => x.candidateName === 'John Doe').length === 1);

  // --- Q2 via follow-up style free text ---
  I.send({ type: 'question_start', plannedQuestionId: ij.plannedQuestions[1].id });
  const q2 = await I.wait(type('question_started'));
  I.send({ type: 'transcript_final', speaker: 'candidate', text: 'A REST API exposes resources over HTTP using methods like GET and POST, and each request is stateless.' });
  await I.wait((m) => m.type === 'transcript_final' && m.speaker === 'candidate');

  // --- End mid-question: last answer evaluated, report generated ---
  I.send({ type: 'interview_end' });
  const ended = await C2.wait((m) => m.type === 'interview_state' && m.interview.status === 'COMPLETED');
  check('LIVE → COMPLETED', !!ended);
  const gen = await I.wait((m) => m.type === 'report_status' && m.reportStatus === 'generating');
  check('report_status generating sent to interviewer', !!gen);
  const ready = await I.wait((m) => m.type === 'report_status' && m.reportStatus !== 'generating', 60000);
  check('report generated', ready.reportStatus === 'ready', ready.reportStatus);

  I.send({ type: 'transcript_final', speaker: 'candidate', text: 'late answer' });
  check('no new answers after completion', (await I.wait(type('error'))).code === 'invalid_state');
  I.send({ type: 'question_start', questionText: 'Another?' });
  check('no new questions after completion', (await I.wait(type('error'))).code === 'invalid_state');

  await sleep(500);
  const leaked = C2.all.concat(C.all).filter((m) => /^(evaluation_|question_updated|notes_updated|report_status)/.test(m.type)
    || /"breakdown"|expectedConcepts|interviewerNote|generalNotes|Calm, structured/.test(JSON.stringify(m)));
  check('candidate never received evaluation, notes or report data', leaked.length === 0, leaked.map((m) => m.type).join(','));

  // --- Report ---
  r = await api('GET', `/api/interviews/${iv.sessionId}/report`, undefined, A);
  const rep = r.body.report;
  check('report: counts', rep.questionsAsked === 2 && rep.questionsAnswered === 2 && rep.questionsEvaluated === 2,
    `${rep.questionsAsked}/${rep.questionsAnswered}/${rep.questionsEvaluated}`);
  const avg = Math.round(r.body.questions.reduce((s, q) => s + q.evaluation.score, 0) / 2);
  check('report: average = mean of question scores', rep.averageAiScore === avg && rep.averageAiScore >= 0 && rep.averageAiScore <= 100, `avg ${rep.averageAiScore}`);
  check('report: skill breakdown from question skills', rep.skillBreakdown.map((s) => s.skill).sort().join() === 'APIs,Operating Systems',
    JSON.stringify(rep.skillBreakdown));
  check('report: question scores + areas to explore', rep.questionResults.length === 2 && rep.areasToExplore.length > 0);
  check('report: AI summary labelled (demo)', rep.aiSummary === null && ['demo', 'unavailable', 'generated'].includes(rep.aiSummaryStatus), rep.aiSummaryStatus);
  check('report: notes persisted', r.body.generalNotes === 'Calm, structured communicator.' && r.body.questions[0].interviewerNote === 'Missed context switching.');

  check('review: score 150 rejected', (await api('PUT', `/api/interviews/${iv.sessionId}/review`, { finalScore: 150 }, A)).status === 400);
  check('review: unknown decision rejected', (await api('PUT', `/api/interviews/${iv.sessionId}/review`, { decision: 'auto_hire' }, A)).status === 400);
  r = await api('PUT', `/api/interviews/${iv.sessionId}/review`, { decision: 'hire', finalScore: 80, notes: 'Solid fundamentals', comments: 'Probe distributed systems next round' }, A);
  check('review: human decision saved', r.status === 200 && r.body.review.decision === 'hire' && r.body.review.updatedBy === 'Priya Shah');
  check('review: other interviewer blocked', (await api('PUT', `/api/interviews/${iv.sessionId}/review`, { decision: 'no_hire' }, B)).status === 403);
  check('candidate join after completion → 410', (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key: keyOf(iv.candidateUrl) })).status === 410);

  fs.writeFileSync(STATE_FILE, JSON.stringify({ cookie: A, sessionId: iv.sessionId, avg }));
  for (const c of [I, C2]) c.ws.close();
}

async function persist() {
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  const r = await api('GET', `/api/interviews/${s.sessionId}/report`, undefined, s.cookie);
  check('after restart: login session still valid', r.status === 200);
  check('after restart: report, review and notes persisted', r.body?.reportStatus === 'ready' && r.body.report.averageAiScore === s.avg
    && r.body.review.decision === 'hire' && r.body.generalNotes === 'Calm, structured communicator.');
}

(PHASE === 'persist' ? persist() : main())
  .then(() => {
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
