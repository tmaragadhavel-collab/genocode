// Speech → STT → question → LLM over the WebSocket, with real audio (TTS WAV).
// Each participant streams its own mic as binary PCM after audio_start; the
// server labels speakers from the authenticated socket.
// Usage:
//   node tests/e2e/stt.e2e.js <port> <fakeWhisperControlUrl>   (runner: fake Whisper, deterministic)
//   node tests/e2e/stt.e2e.js <port> real                      (real provider from .env, e.g. Deepgram)
const { createChecker, http, wsClient, type, keyOf, sleep, finish, speak, startAudio } = require('./helpers');

const [port, control] = process.argv.slice(2);
const real = control === 'real';
const api = http(`http://localhost:${port}`);
const c = createChecker();
const setMode = (mode) => (real ? Promise.resolve() : fetch(control, { method: 'POST', body: mode }));
const pace = real ? 100 : 0; // real providers get real-time audio
const isFinal = (speaker) => (m) => m.type === 'transcript_final' && m.speaker === speaker;
const stateOf = (role, state) => (m) => m.type === 'transcription_state' && m.role === role && m.state === state;

(async () => {
  await setMode('ok');
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
  c.check('both roles told to stream their mic', ij.transcription === 'stream' && cj.transcription === 'stream');

  // Security: audio needs a joined socket and an audio_start; format is validated.
  const stranger = await wsClient(port);
  stranger.send({ type: 'audio_start', format: 'pcm16', sampleRate: 16000, channels: 1 });
  c.check('unjoined socket cannot start a stream', (await stranger.wait(type('error'))).code === 'not_joined');
  stranger.ws.close();
  C.send({ type: 'audio_start', format: 'opus', sampleRate: 48000, channels: 2 });
  c.check('unsupported audio format rejected', (await C.wait(type('error'))).code === 'invalid_audio');
  startAudio(C);
  c.check('no stream before the interview is LIVE', (await C.wait(type('transcription_state'))).state === 'stopped');

  I.send({ type: 'interview_start' });
  await I.wait((m) => m.type === 'interview_state' && m.interview.status === 'LIVE');

  // Interviewer speaks → transcript → "use as question".
  startAudio(I);
  await I.wait(stateOf('INTERVIEWER', 'connecting'));
  await speak(I, { paceMs: pace });
  const iFinal = await I.wait(isFinal('interviewer'), 30000);
  c.check('interviewer speech → final transcript, labelled interviewer', iFinal.role === 'INTERVIEWER'
    && iFinal.participantId === `interviewer_${iv.sessionId}` && iFinal.text.length > 10, `"${iFinal.text}"`);
  c.check('interviewer stream reached "transcribing"', I.all.some(stateOf('INTERVIEWER', 'transcribing')));
  I.send({ type: 'question_start', questionText: 'What is the difference between a process and a thread?' });
  const q = (await I.wait(type('question_started'))).question;

  // Candidate answers → partial then final (same segment) → linked to the question.
  startAudio(C);
  startAudio(C); // duplicate start → still one stream
  const candState = await I.wait(stateOf('CANDIDATE', 'connecting'));
  c.check("interviewer sees the candidate's transcription state", candState.participantId === `candidate_${iv.sessionId}`);
  await speak(C, { paceMs: pace });
  const cFinal = await I.wait(isFinal('candidate'), 30000);
  const partial = I.all.find((m) => m.type === 'transcript_partial' && m.speaker === 'candidate');
  c.check('partial transcript before the final', !!partial && I.all.indexOf(partial) < I.all.indexOf(cFinal),
    partial ? `"${partial.text.slice(0, 40)}"` : 'none');
  c.check('partial and final share a segment id (UI replaces, no duplicate)', I.all.some((m) => m.type === 'transcript_partial' && m.segmentId === cFinal.segmentId));
  c.check('candidate final: speaker from authenticated socket', cFinal.role === 'CANDIDATE' && cFinal.participantId === `candidate_${iv.sessionId}`);
  c.check('candidate answer linked to the active question', cFinal.questionId === q.questionId, `"${cFinal.text}"`);
  await sleep(real ? 3000 : 1500);
  // One final per detected utterance: a duplicated stream would double them.
  const finals = I.all.filter(isFinal('candidate'));
  const utterances = I.all.filter((m) => m.type === 'speech_activity' && m.speaker === 'candidate' && m.speaking).length;
  c.check('no duplicate transcripts after a duplicate audio_start', new Set(finals.map((m) => m.segmentId)).size === finals.length
    && (real ? (finals.map((m) => m.text).join(' ').match(/share memory/gi) || []).length === 1 : finals.length === utterances),
  `${finals.length} final(s), ${utterances} utterance(s)`);

  // Evaluation of the spoken answer (text, not audio, goes to the LLM).
  I.send({ type: 'question_end' });
  const started = await I.wait((m) => m.type === 'evaluation_started' && m.questionId === q.questionId);
  const ev = await I.wait((m) => (m.type === 'evaluation_completed' || m.type === 'evaluation_error') && m.questionId === q.questionId, 60000);
  c.check('answer completion → evaluation_started → evaluation_completed', !!started && ev.type === 'evaluation_completed', `score ${ev.score}`);
  c.check('evaluated text is the transcribed answer', /process/i.test(ev.question.evaluation.answerText) && ev.question.answer === ev.question.evaluation.answerText);
  c.check('score is the backend-weighted value', ev.score >= 0 && ev.score <= 100 && typeof ev.breakdown.correctness === 'number');
  c.check('candidate received no evaluation data', !C.all.some((m) => /^evaluation_/.test(m.type) || JSON.stringify(m).includes('breakdown')));

  // A second socket for the same participant replaces the stream; the old socket's audio is ignored.
  const Cj2 = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key: keyOf(iv.candidateUrl) })).body;
  const C2 = await wsClient(port);
  C2.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Cj2.participantKey });
  await C2.wait(type('session_joined'));
  I.send({ type: 'question_start', questionText: 'What is a mutex?' });
  const q2 = (await I.wait(type('question_started'))).question;
  startAudio(C2);
  await C2.wait(stateOf('CANDIDATE', 'connecting'));
  const before = I.all.filter(isFinal('candidate')).length;
  await speak(C, { paceMs: pace }); // old socket: must be ignored
  await sleep(real ? 4000 : 1500);
  c.check("replaced socket's audio is ignored (no duplicate stream)", I.all.filter(isFinal('candidate')).length === before);
  await speak(C2, { paceMs: pace });
  const f2 = await I.wait((m) => isFinal('candidate')(m) && m.questionId === q2.questionId, 30000).catch(() => null);
  c.check('new socket streams normally', !!f2);

  if (!real) {
    // Provider failures → reconnecting → unavailable; the call continues; Retry recovers.
    await setMode('fail');
    // Speak repeatedly, pausing like a person would (the stream reconnects between failures).
    let down = null;
    for (let i = 0; i < 8 && !down; i++) {
      await speak(C2, { silenceMs: 900 });
      down = await C2.wait(stateOf('CANDIDATE', 'unavailable'), 4500).catch(() => null);
    }
    c.check('repeated STT failure → "unavailable" (after reconnect attempts)', !!down && C2.all.some(stateOf('CANDIDATE', 'reconnecting')));
    I.send({ type: 'ping' });
    c.check('interview continues while STT is down', !!(await I.wait(type('pong'))));
    await setMode('ok');
    C2.send({ type: 'transcription_retry' });
    await speak(C2);
    const back = await I.wait(isFinal('candidate'), 30000).catch(() => null);
    c.check('Retry transcription recovers', !!back && C2.all.filter(stateOf('CANDIDATE', 'transcribing')).length >= 2);

    await setMode('low');
    await speak(C2);
    c.check('low-confidence segment flagged', !!(await I.wait((m) => isFinal('candidate')(m) && m.lowConfidence === true, 15000).catch(() => null)));
    await setMode('ok');
  }

  // Closing the socket stops the stream; the interview continues.
  C2.ws.close();
  C.ws.close();
  await sleep(500);
  const list = await api('GET', '/api/interviews', undefined, A);
  c.check('interview still LIVE after candidate sockets closed', list.body.interviews.find((x) => x.sessionId === iv.sessionId)?.status === 'LIVE');
  await sleep(1500); // > one database sync
  I.send({ type: 'interview_end' });
  await I.wait((m) => m.type === 'report_status' && m.reportStatus !== 'generating', 60000);
  const rep = (await api('GET', `/api/interviews/${iv.sessionId}/report`, undefined, A)).body;
  c.check('final transcripts and evaluations persisted', rep.transcript.some((t) => t.speaker === 'candidate' && t.source === 'stt')
    && rep.transcript.some((t) => t.speaker === 'interviewer') && rep.questions[0].evaluationHistory.length === 1);
  I.ws.close();
})().then(() => finish(c)).catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
