// Answer boundaries: silence prompt, auto-end setting, spoken-new-question
// suggestion. Manual controls stay authoritative; candidates see none of it.
// Usage: node tests/e2e/boundaries.e2e.js <port> <fakeWhisperControlUrl>
const fs = require('fs');
const path = require('path');
const { createChecker, http, wsClient, type, keyOf, sleep, finish } = require('./helpers');

const [port, controlUrl] = process.argv.slice(2);
const api = http(`http://localhost:${port}`);
const c = createChecker();
const setMode = (mode) => fetch(controlUrl, { method: 'POST', body: mode });
const segment = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'process-vs-thread.wav')).subarray(44).toString('base64');

(async () => {
  await setMode('ok');
  const A = (await api('POST', '/api/auth/signup', { email: `bnd.${Date.now()}@example.com`, password: 'long enough password', name: 'Boundary Tester' })).cookie;
  const iv = (await api('POST', '/api/interviews', { candidateName: 'Bo Undary', position: 'Backend', durationMinutes: 30 }, A)).body;
  const Ij = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'interviewer' }, A)).body;
  const Cj = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key: keyOf(iv.candidateUrl) })).body;
  const I = await wsClient(port);
  const C = await wsClient(port);
  I.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Ij.participantKey });
  const ij = await I.wait(type('session_joined'));
  C.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Cj.participantKey });
  await C.wait(type('session_joined'));
  c.check('auto-end is OFF by default', ij.settings.autoEndOnSilence === false && ij.settings.silenceSeconds === 5);

  C.send({ type: 'interview_settings', autoEndOnSilence: true });
  c.check('candidate cannot change interview settings', (await C.wait(type('error'))).code === 'forbidden');
  I.send({ type: 'interview_settings', silenceSeconds: 1 });
  c.check('silence below 2s rejected', (await I.wait(type('error'))).code === 'invalid_settings');
  I.send({ type: 'interview_settings', silenceSeconds: 2 });
  await I.wait(type('settings_updated'));

  I.send({ type: 'interview_start' });
  await I.wait((m) => m.type === 'interview_state' && m.interview.status === 'LIVE');

  // 1) Silence prompt (auto-end off): the question stays open.
  I.send({ type: 'question_start', questionText: 'What is the difference between a process and a thread?' });
  const q1 = (await I.wait(type('question_started'))).question;
  C.send({ type: 'speech_activity', speaking: true });
  C.send({ type: 'audio_segment', data: segment });
  await I.wait((m) => m.type === 'transcript_final' && m.speaker === 'candidate');
  C.send({ type: 'speech_activity', speaking: false });
  const t0 = Date.now();
  const prompt = await I.wait(type('answer_silence_prompt'), 8000);
  c.check('silence prompt after ~2s of candidate silence', prompt.questionId === q1.questionId && Date.now() - t0 >= 1500,
    `after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  c.check('prompt sent once per silence period', !(await I.wait(type('answer_silence_prompt'), 3500).catch(() => null)));
  c.check('question still open (no automatic close when auto-end is off)', !I.inbox.some((m) => m.type === 'answer_completed'));

  // 2) Interviewer speaks a new question while the answered one is open → suggestion only.
  await setMode('question');
  I.send({ type: 'audio_segment', data: segment });
  const sug = await I.wait(type('new_question_detected'), 10000);
  c.check('spoken new question → suggestion to close previous answer', sug.openQuestionId === q1.questionId && /\?$/.test(sug.text), `"${sug.text}"`);
  c.check('previous answer not auto-closed', !I.inbox.some((m) => m.type === 'answer_completed'));

  // Manual control remains authoritative.
  I.send({ type: 'question_end' });
  await I.wait((m) => m.type === 'answer_completed' && m.questionId === q1.questionId);

  // 3) Auto-end ON: silence ends the answer and evaluation starts.
  await setMode('ok');
  I.send({ type: 'interview_settings', autoEndOnSilence: true });
  await I.wait(type('settings_updated'));
  I.send({ type: 'question_start', questionText: 'Explain what a mutex is.' });
  const q2 = (await I.wait(type('question_started'))).question;
  C.send({ type: 'speech_activity', speaking: true });
  C.send({ type: 'audio_segment', data: segment });
  await I.wait((m) => m.type === 'transcript_final' && m.speaker === 'candidate');
  C.send({ type: 'speech_activity', speaking: false });
  const auto = await I.wait(type('answer_auto_ended'), 8000);
  c.check('auto-end ON: answer closed after silence', auto.questionId === q2.questionId && auto.reason === 'silence');
  c.check('auto-ended answer is evaluated', !!(await I.wait((m) => m.type === 'evaluation_started' && m.questionId === q2.questionId, 8000).catch(() => null)));

  // 4) Auto-end ON + spoken new question → previous closed, new one started.
  I.send({ type: 'question_start', questionText: 'What is a deadlock?' });
  const q3 = (await I.wait(type('question_started'))).question;
  C.send({ type: 'audio_segment', data: segment });
  await I.wait((m) => m.type === 'transcript_final' && m.speaker === 'candidate');
  await setMode('question');
  I.send({ type: 'audio_segment', data: segment });
  const closed = await I.wait((m) => m.type === 'answer_auto_ended' && m.reason === 'new_question', 10000);
  const next = await I.wait(type('question_started'));
  c.check('auto-end ON: spoken question closes previous and starts new', closed.questionId === q3.questionId && next.question.questionText.endsWith('?'));

  await sleep(500);
  const leaked = C.all.filter((m) => /silence_prompt|auto_ended|new_question_detected|settings_updated/.test(m.type));
  c.check('candidate receives no boundary prompts or settings', leaked.length === 0, leaked.map((m) => m.type).join(','));
  await setMode('ok');
  I.ws.close();
  C.ws.close();
})().then(() => finish(c)).catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
