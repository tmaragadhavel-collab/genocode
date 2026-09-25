/**
 * End-to-end regression for the meeting site, against the REAL providers in
 * .env (Deepgram + Groq). Two authenticated WebSocket sessions, one per role.
 *
 * Audio is real recorded speech streamed as 16 kHz PCM exactly as the browser's
 * AudioWorklet sends it. It is NOT captured from a physical microphone, so the
 * mic → LiveKit → PCM stages are reported separately as BLOCKED.
 *
 * Usage: node scripts/diag-regression.js [port]
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const port = process.argv[2] || '3001';
const base = `http://localhost:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail: String(detail).slice(0, 160) });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return ok;
};

/** Reads the data chunk of a RIFF/WAVE file (the header is not always 44 bytes). */
function pcmOf(name) {
  const buf = fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', name));
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${name}`);
}

const Q_PYTHON = pcmOf('q-what-is-python.wav');
const Q_WHY = pcmOf('q-why-technology.wav');
const A_CAREER = pcmOf('a-career-assistant.wav');

async function api(method, url, body, cookie) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, body: await r.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null };
}

function connect(label) {
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
      label, ws, all,
      send: (o) => ws.send(JSON.stringify(o)),
      sendBinary: (b) => ws.send(b, { binary: true }),
      count: (type) => all.filter((m) => m.type === type).length,
      wait: (pred, ms = 30000) => new Promise((res, rej) => {
        const hit = all.find(pred);
        if (hit) return res(hit);
        const w = { pred, resolve: res };
        w.t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`timeout (${label})`)); }, ms);
        waiters.push(w);
      }),
    }));
  });
}

/** Streams PCM in real time, then silence so the endpointer closes the utterance. */
async function speak(client, pcm) {
  const frame = 3200;
  const audio = Buffer.concat([pcm, Buffer.alloc(1500 * 32)]);
  for (let i = 0; i < audio.length; i += frame) {
    client.sendBinary(audio.subarray(i, i + frame));
    await sleep(100);
  }
}

(async () => {
  const health = (await api('GET', '/health')).body;
  console.log(`Providers: stt=${health.providers.stt} ai=${health.providers.ai} livekit=${health.providers.livekit}\n`);

  const A = (await api('POST', '/api/auth/signup', {
    email: `reg.${Date.now()}@example.com`, password: 'long enough password', name: 'Regression Owner',
  })).cookie;
  const iv = (await api('POST', '/api/interviews', {
    candidateName: 'Reg Candidate', position: 'AI Engineer', durationMinutes: 30,
    skills: ['python'], candidateCoaching: true,
  }, A)).body;
  const Ij = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'interviewer' }, A)).body;
  const key = new URL(iv.candidateUrl).searchParams.get('key');
  const Cj = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key })).body;

  const I = await connect('interviewer');
  const C = await connect('candidate');
  I.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Ij.participantKey });
  await I.wait((m) => m.type === 'session_joined');
  C.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Cj.participantKey });
  await C.wait((m) => m.type === 'session_joined');
  I.send({ type: 'interview_start' });
  await I.wait((m) => m.type === 'interview_state' && m.interview.status === 'LIVE');
  I.send({ type: 'audio_start', format: 'pcm16', sampleRate: 16000, channels: 1 });
  C.send({ type: 'audio_start', format: 'pcm16', sampleRate: 16000, channels: 1 });
  await sleep(1500);

  // ---- TEST 2: interviewer question → STT → detection → one LLM call → UI payload
  console.log('TEST 2 — interviewer question');
  await speak(I, Q_PYTHON);
  const iFinal = await I.wait((m) => m.type === 'transcript_final' && m.speaker === 'interviewer', 30000);
  check('interviewer FINAL transcript', iFinal.text.length > 3, `"${iFinal.text}"`);
  const askedAt = Date.now();
  const q1 = await C.wait((m) => m.type === 'coaching_question', 25000);
  check('question detected → coaching started', !!q1.questionId, `id ${q1.questionId} "${q1.question}"`);
  const d1 = await C.wait((m) => m.type === 'coaching_delta', 40000);
  const firstToken = Date.now() - askedAt;
  check('coaching streams to candidate', !!d1.text, `first token ~${firstToken}ms after final`);
  const done1 = await C.wait((m) => m.type === 'coaching_state' && m.questionId === q1.questionId
    && (m.state === 'complete' || m.state === 'error'), 60000);
  check('coaching completed', done1.state === 'complete', done1.error || '');
  check('exactly ONE coaching run for one question', C.count('coaching_question') === 1, `${C.count('coaching_question')}`);

  const sectionsOf = (qid) => {
    const out = {};
    for (const m of C.all.filter((x) => x.type === 'coaching_delta' && x.questionId === qid)) {
      out[m.section] = (out[m.section] || '') + m.text;
    }
    return out;
  };
  const s1 = sectionsOf(q1.questionId);
  check('all four coaching sections present', ['HINTS', 'STRUCTURE', 'GROUNDING', 'CAUTION'].every((k) => s1[k]?.trim()),
    Object.keys(s1).join(','));
  console.log(`    HINTS: ${(s1.HINTS || '').trim().replace(/\n/g, ' | ').slice(0, 150)}`);

  // ---- TEST 3: the same question again must not regenerate
  console.log('\nTEST 3 — duplicate protection');
  await speak(I, Q_PYTHON);
  await sleep(6000);
  check('repeat question → still one coaching run', C.count('coaching_question') === 1, `${C.count('coaching_question')} run(s)`);
  check('no second question id', new Set(C.all.filter((m) => m.type === 'coaching_question').map((m) => m.questionId)).size === 1);

  // ---- TEST 5 (interviewer-side evaluation, which is what exists)
  console.log('\nTEST 5 — answer evaluation (interviewer-side)');
  I.send({ type: 'question_start', questionText: 'What is Python?' });
  const started = await I.wait((m) => m.type === 'question_started', 20000);

  // ---- TEST 4: candidate speech
  console.log('\nTEST 4 — candidate speech');
  const coachingBefore = C.count('coaching_question');
  await speak(C, A_CAREER);
  const cFinal = await I.wait((m) => m.type === 'transcript_final' && m.speaker === 'candidate', 30000);
  check('candidate FINAL transcript', cFinal.text.length > 3, `"${cFinal.text}"`);
  await sleep(6000);
  check('candidate speech does NOT trigger coaching', C.count('coaching_question') === coachingBefore,
    `${C.count('coaching_question')} run(s)`);
  check('candidate answer linked to the active question', cFinal.questionId === started.question.questionId);

  I.send({ type: 'question_end' });
  const ev = await I.wait((m) => (m.type === 'evaluation_completed' || m.type === 'evaluation_error')
    && m.questionId === started.question.questionId, 60000);
  check('answer evaluated', ev.type === 'evaluation_completed', ev.type === 'evaluation_completed' ? `score ${ev.score}` : ev.message);
  if (ev.type === 'evaluation_completed') {
    const e = ev.question.evaluation;
    check('evaluation has score + breakdown', typeof ev.score === 'number' && typeof ev.breakdown.correctness === 'number',
      `score ${ev.score}`);
    check('evaluation has strengths / improvements / concepts',
      Array.isArray(e.strengths) && Array.isArray(e.improvements) && (Array.isArray(e.missedConcepts) || Array.isArray(e.coveredConcepts)),
      `strengths ${e.strengths?.length}, improvements ${e.improvements?.length}`);
    check('evaluation suggests a follow-up', typeof e.followUpQuestion === 'string' && e.followUpQuestion.length > 0,
      (e.followUpQuestion || '').slice(0, 60));
  }

  // ---- Candidate answer feedback (practice mode)
  console.log('\nTEST 5b — candidate answer feedback');
  const fbPending = C.all.find((m) => m.type === 'answer_evaluation' && m.state === 'evaluating');
  check('candidate saw "evaluating" while it ran', !!fbPending);
  const fb = await C.wait((m) => m.type === 'answer_evaluation' && m.questionId === started.question.questionId
    && m.state !== 'evaluating', 60000);
  check('candidate received their own feedback', fb.state === 'ready', fb.state === 'ready' ? `score ${fb.score}/100` : fb.message);
  if (fb.state === 'ready') {
    check('candidate score matches the evaluator exactly', fb.score === ev.score, `candidate ${fb.score} vs interviewer ${ev.score}`);
    check('feedback has answer + breakdown + strengths + improvements',
      !!fb.answer && typeof fb.breakdown.correctness === 'number' && Array.isArray(fb.strengths) && Array.isArray(fb.improvements),
      `strengths ${fb.strengths.length}, improvements ${fb.improvements.length}`);
    console.log(`    strengths:    ${(fb.strengths || []).join(' | ').slice(0, 130)}`);
    console.log(`    improvements: ${(fb.improvements || []).join(' | ').slice(0, 130)}`);
  }
  check('interviewer did NOT receive answer_evaluation', !I.all.some((m) => m.type === 'answer_evaluation'));

  // ---- TEST 6: role privacy
  console.log('\nTEST 6 — role privacy');
  const iBad = I.all.filter((m) => m.type === 'coaching_delta' || m.type === 'coaching_state');
  check('interviewer received NO coaching content', iBad.length === 0, iBad.map((m) => m.type).join(','));
  check('interviewer WAS told coaching is active', I.all.some((m) => m.type === 'coaching_activity'));
  // The candidate may see its own answer_evaluation; nothing else scored.
  const cBad = C.all.filter((m) => m.type !== 'answer_evaluation'
    && (/^evaluation_/.test(m.type) || /"breakdown"|"finalScore"|"override"/.test(JSON.stringify(m))));
  check('candidate received no evaluation data beyond its own feedback', cBad.length === 0, cBad.map((m) => m.type).join(','));
  const cFb = C.all.filter((m) => m.type === 'answer_evaluation');
  check('candidate feedback excludes interviewer-only fields',
    cFb.every((m) => !('expectedAnswer' in m) && !('override' in m) && !('interviewerNote' in m)
      && !('evaluationHistory' in m) && !('scoringCriteria' in m)), `${cFb.length} message(s)`);
  check('both sides receive the transcript', I.all.some((m) => m.type === 'transcript_final') && C.all.some((m) => m.type === 'transcript_final'));

  // ---- TEST 7: a different question
  console.log('\nTEST 7 — next question');
  await speak(I, Q_WHY);
  const q2 = await C.wait((m) => m.type === 'coaching_question' && m.questionId !== q1.questionId, 30000);
  check('new question → new id', q2.questionId !== q1.questionId, `"${q2.question}"`);
  await C.wait((m) => m.type === 'coaching_state' && m.questionId === q2.questionId
    && (m.state === 'complete' || m.state === 'error'), 60000);
  check('exactly two coaching runs in total', C.count('coaching_question') === 2, `${C.count('coaching_question')}`);
  const s2 = sectionsOf(q2.questionId);
  check('second coaching has its own content', (s2.HINTS || '').trim().length > 0 && s2.HINTS !== s1.HINTS,
    (s2.HINTS || '').trim().replace(/\n/g, ' | ').slice(0, 120));

  check('previous evaluation survived the next question',
    ev.type === 'evaluation_completed' && ev.question.evaluationHistory?.length >= 1,
    `${ev.question?.evaluationHistory?.length ?? 0} run(s) on Q1`);

  // ---- Interview stays healthy
  I.send({ type: 'ping' });
  check('interview still responsive', !!(await I.wait((m) => m.type === 'pong', 10000)));

  console.log('\n--- counters ---');
  console.log(`questions detected (coaching):  ${C.count('coaching_question')}`);
  console.log(`coaching generations completed: ${C.all.filter((m) => m.type === 'coaching_state' && m.state === 'complete').length}`);
  console.log(`coaching errors:                ${C.all.filter((m) => m.type === 'coaching_state' && m.state === 'error').length}`);
  console.log(`answer evaluations:             ${I.all.filter((m) => m.type === 'evaluation_completed').length}`);
  console.log(`evaluation errors:              ${I.all.filter((m) => m.type === 'evaluation_error').length}`);
  console.log(`interviewer final transcripts:  ${I.all.filter((m) => m.type === 'transcript_final' && m.speaker === 'interviewer').length}`);
  console.log(`candidate final transcripts:    ${I.all.filter((m) => m.type === 'transcript_final' && m.speaker === 'candidate').length}`);

  // The report is the durable record: it must still carry Q1's evaluation.
  I.send({ type: 'interview_end' });
  await I.wait((m) => m.type === 'report_status' && m.reportStatus !== 'generating', 60000).catch(() => null);
  const rep = (await api('GET', `/api/interviews/${iv.sessionId}/report`, undefined, A)).body;
  const q1rec = rep?.questions?.find((x) => x.questionId === started.question.questionId);
  check('previous evaluation persisted to the report', !!q1rec && q1rec.evaluationHistory.length >= 1,
    `${q1rec?.evaluationHistory?.length ?? 0} evaluation(s) on Q1`);

  I.ws.close();
  C.ws.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? `${failed.length} FAILED` : 'ALL PASSED'} (${results.length} checks)`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('crashed:', e.message); process.exit(2); });
