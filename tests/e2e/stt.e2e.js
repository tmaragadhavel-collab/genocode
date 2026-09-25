// Speech-to-text over the WebSocket: segments from each participant's own mic,
// speaker labelled from the authenticated participant, confidence flags,
// "Transcription unavailable" on failure, and the call continuing.
// Usage: node tests/e2e/stt.e2e.js <port> [controlUrl]
//   controlUrl: fake Whisper control endpoint (from run-e2e); omit to use the real provider.
const fs = require('fs');
const path = require('path');
const { createChecker, http, wsClient, type, keyOf, finish } = require('./helpers');

const [port, controlUrl] = process.argv.slice(2);
const api = http(`http://localhost:${port}`);
const c = createChecker();
const setMode = (mode) => (controlUrl ? fetch(controlUrl, { method: 'POST', body: mode }) : Promise.resolve());

// The fixture is a 16 kHz mono PCM16 WAV; strip the 44-byte header.
const wav = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'process-vs-thread.wav'));
const pcm = wav.subarray(44);
const segment = pcm.toString('base64');

(async () => {
  const A = (await api('POST', '/api/auth/signup', { email: `stt.${Date.now()}@example.com`, password: 'long enough password', name: 'STT Tester' })).cookie;
  const iv = (await api('POST', '/api/interviews', { candidateName: 'Sam Speech', position: 'Backend', durationMinutes: 30 }, A)).body;
  const Ij = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'interviewer' }, A)).body;
  const Cj = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key: keyOf(iv.candidateUrl) })).body;
  const I = await wsClient(port);
  const C = await wsClient(port);
  I.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Ij.participantKey });
  const ij = await I.wait(type('session_joined'));
  C.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Cj.participantKey });
  const cj = await C.wait(type('session_joined'));
  c.check('both roles told to capture VAD segments', ij.transcription === 'segments' && cj.transcription === 'segments');

  C.send({ type: 'audio_segment', data: segment });
  c.check('segments ignored before the interview is LIVE', !(await C.wait(type('transcript_final'), 3000).catch(() => null)));

  I.send({ type: 'interview_start' });
  await I.wait((m) => m.type === 'interview_state' && m.interview.status === 'LIVE');
  I.send({ type: 'question_start', questionText: 'What is the difference between a process and a thread?' });
  const q = (await I.wait(type('question_started'))).question;

  // A spoofed speaker field must not change the label.
  C.send({ type: 'speech_activity', speaking: true });
  const act = await I.wait(type('speech_activity'));
  c.check('speech activity relayed with authenticated speaker', act.speaker === 'candidate' && act.speaking === true);
  C.send({ type: 'audio_segment', speaker: 'interviewer', data: segment });
  const t = await I.wait((m) => m.type === 'transcript_final', 30000);
  c.check('candidate segment transcribed', /process/i.test(t.text), `"${t.text}"`);
  c.check('speaker from authenticated identity (spoof ignored)', t.speaker === 'candidate');
  c.check('segment mapped to the open question', t.questionId === q.questionId);
  c.check('segment carries STT quality signals', t.source === 'stt' && typeof t.lowConfidence === 'boolean',
    `avgLogprob ${t.avgLogprob}, noSpeechProb ${t.noSpeechProb}, low ${t.lowConfidence}`);

  I.send({ type: 'audio_segment', data: segment });
  const ti = await I.wait((m) => m.type === 'transcript_final' && m.speaker === 'interviewer', 30000);
  c.check("interviewer's own segment labelled interviewer", ti.speaker === 'interviewer');

  C.inbox.length = 0; // only consider transcripts produced after this point
  C.send({ type: 'audio_segment', data: 'A'.repeat(800 * 1024) });
  C.send({ type: 'audio_segment', data: 'AAAA' });
  c.check('oversized / too-short segments rejected', !(await C.wait((m) => m.type === 'transcript_final' && m.speaker === 'candidate', 3000).catch(() => null)));

  if (controlUrl) {
    await setMode('low');
    C.send({ type: 'audio_segment', data: segment });
    const low = await I.wait((m) => m.type === 'transcript_final' && m.lowConfidence === true, 15000).catch(() => null);
    c.check('low-confidence segment flagged', !!low);

    await setMode('fail');
    C.send({ type: 'audio_segment', data: segment });
    const down = await C.wait((m) => m.type === 'transcription_status', 15000);
    c.check('STT failure → "Transcription unavailable" to participants', down.status === 'unavailable' && down.message === 'Transcription unavailable');
    I.send({ type: 'ping' });
    c.check('call continues while STT is down', !!(await I.wait(type('pong'))));

    await setMode('ok');
    C.send({ type: 'audio_segment', data: segment });
    const up = await C.wait((m) => m.type === 'transcription_status', 15000);
    c.check('recovery → transcription resumes', up.status === 'ok');
  }

  I.send({ type: 'question_end' });
  const ev = await I.wait((m) => m.type === 'evaluation_completed' || m.type === 'evaluation_error', 45000);
  c.check('spoken answer evaluated', ev.type === 'evaluation_completed' && ev.question.answer.length > 20, `score ${ev.score}`);
  if (controlUrl) c.check('answer flagged as containing low-confidence STT', ev.question.lowConfidence === true);
  const state = await api('GET', '/api/interviews', undefined, A);
  c.check('interview still LIVE', state.body.interviews.find((x) => x.sessionId === iv.sessionId)?.status === 'LIVE');
  I.ws.close();
  C.ws.close();
})().then(() => finish(c)).catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
