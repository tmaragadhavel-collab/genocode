import { randomBytes } from 'crypto';
import { DeepgramStreamingService } from './deepgramSTT';
import { EvaluationError, type EvaluationService } from './evaluationService';
import type { Difficulty, Evaluation, InterviewQuestion, Rubric, TranscriptSegment } from './evaluationTypes';
import type { InterviewSession, ParticipantBinding, ParticipantRole, SessionManager } from './sessionManager';
import type { SttConfig, TranscriptEntry } from '../types';
import type { PlannedQuestion } from './reportTypes';
import { WhisperSTT, pcm16ToWav, SAMPLE_RATE, SttError } from '../stt/whisper';

type Outbound = { type: string; sessionId?: string; [key: string]: unknown };

export type QuestionFlowClient = {
  binding: ParticipantBinding | null;
  send: (msg: Outbound) => void;
};

type Senders = {
  toSession: (sessionId: string, msg: Outbound) => void;
  toRole: (sessionId: string, role: ParticipantRole, msg: Outbound) => void;
};

const MAX_QUESTION_LENGTH = 1000;
const MAX_ANSWER_LENGTH = 8000;
const MAX_SEGMENT_LENGTH = 2000;
const MAX_AUDIO_B64 = 96 * 1024; // one streaming chunk (Deepgram mode)
const MAX_SEGMENT_B64 = 700 * 1024; // ~15s of 16 kHz PCM16 as base64
const MIN_SEGMENT_BYTES = SAMPLE_RATE * 2 * 0.3; // 300 ms
const MAX_SEGMENT_BYTES = SAMPLE_RATE * 2 * 16; // 16 s
const MAX_QUEUED_SEGMENTS = 4; // per participant

export type TranscriptQuality = {
  source: 'stt' | 'manual';
  avgLogprob: number | null;
  noSpeechProb: number | null;
  lowConfidence: boolean;
};
const MANUAL: TranscriptQuality = { source: 'manual', avgLogprob: null, noSpeechProb: null, lowConfidence: false };
const RUBRIC_WAIT_MS = 20_000;
const MAX_NOTE_LENGTH = 4000;
const UNAVAILABLE = 'AI evaluation temporarily unavailable.';
const QUESTION_ID = /^q_\d{3}_[0-9a-f]{6}$/;
const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max) : '';
}

function cleanList(value: unknown, max = 10): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\n]/) : [];
  return items.map((v) => clean(v, 120)).filter(Boolean).slice(0, max);
}

// Heuristic: does an interviewer utterance look like a new question?
const QUESTION_START = /^(what|why|how|when|where|which|who|whose|can you|could you|would you|will you|do you|did you|have you|is there|are there|is it|explain|describe|tell me|walk me|give me|compare|let's talk|how about|what about)\b/i;
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  return t.split(/\s+/).length >= 4 && (t.endsWith('?') || QUESTION_START.test(t));
}

/** What the candidate may see about a question: never the rubric or evaluation. */
function publicQuestion(q: InterviewQuestion) {
  return { questionId: q.questionId, index: q.index, questionText: q.questionText };
}

/**
 * Tracks the interviewer's questions, maps final candidate transcript to the
 * current question, and runs AI evaluations in the background. Evaluation data
 * is only ever sent to interviewer connections.
 */
export class QuestionFlow {
  private rubricJobs = new Map<string, Promise<void>>();
  private evalJobs = new Map<string, Set<Promise<void>>>(); // by session, for the final report
  private stt = new Map<string, DeepgramStreamingService>(); // Deepgram streaming mode
  private sttCheckedAt = new Map<string, number>();
  private sttWarned = new Set<string>();
  private readonly whisper: WhisperSTT | null;
  private segmentQueues = new Map<string, { chain: Promise<void>; size: number }>(); // per participant
  private transcriptionDown = new Set<string>();
  // Answer-boundary assistance, per session.
  private candidateActivity = new Map<string, { speaking: boolean; lastAt: number; prompted: boolean }>(); // sessions currently told "Transcription unavailable"

  constructor(
    private readonly sessions: SessionManager,
    private readonly evaluator: EvaluationService,
    private readonly send: Senders,
    private readonly sttConfig: SttConfig
  ) {
    this.whisper = sttConfig.provider === 'groq' ? new WhisperSTT(sttConfig) : null;
    setInterval(() => this.checkSilence(), 1000).unref();
  }

  /** How browsers should capture audio: VAD segments (Whisper), a PCM stream (Deepgram), or not at all. */
  private get transcriptionMode(): 'segments' | 'stream' | 'unavailable' {
    return this.sttConfig.provider === 'groq' ? 'segments' : this.sttConfig.provider === 'deepgram' ? 'stream' : 'unavailable';
  }

  /** Extra data for session_joined, filtered by role. */
  joinData(session: InterviewSession, role: ParticipantRole): Record<string, unknown> {
    const current = session.questions.find((q) => q.questionId === session.currentQuestionId) ?? null;
    if (role === 'interviewer') {
      return {
        questions: session.questions,
        currentQuestionId: session.currentQuestionId,
        plannedQuestions: session.details.plannedQuestions,
        settings: session.settings,
        generalNotes: session.generalNotes,
        transcript: session.transcript.slice(-100),
        evaluator: this.evaluator.demoMode ? 'demo-heuristic' : 'llm',
        transcription: this.transcriptionMode,
        transcriptionStatus: this.transcriptionDown.has(session.id) ? 'unavailable' : 'ok',
      };
    }
    // The candidate is told whether the conversation is transcribed, never how it is scored.
    return {
      currentQuestion: current ? publicQuestion(current) : null,
      transcription: this.transcriptionMode,
      transcriptionStatus: this.transcriptionDown.has(session.id) ? 'unavailable' : 'ok',
      // The shared transcript only: no question metadata, rubric or scores.
      transcript: session.transcript.slice(-100).map(({ id, speaker, text, timestamp }) => ({ id, speaker, text, timestamp })),
    };
  }

  // --- Interviewer commands ---

  handleQuestionStart(client: QuestionFlowClient, msg: Record<string, unknown>): void {
    const session = this.interviewerSession(client);
    if (!session) return;
    if (session.status !== 'LIVE') {
      this.error(client, 'invalid_state', 'Start or resume the interview before asking a question.');
      return;
    }

    // A question prepared when the interview was created.
    const planned = typeof msg.plannedQuestionId === 'string'
      ? session.details.plannedQuestions.find((p) => p.id === msg.plannedQuestionId)
      : undefined;
    if (msg.plannedQuestionId !== undefined && !planned) {
      this.error(client, 'invalid_question', 'That planned question does not exist.');
      return;
    }

    let questionText = planned?.text ?? clean(msg.questionText, MAX_QUESTION_LENGTH);
    if (!questionText) {
      // Fall back to what the interviewer just said aloud.
      const since = session.questions.at(-1)?.askedAt ?? 0;
      questionText = session.transcript
        .filter((s) => s.speaker === 'interviewer' && s.timestamp > since)
        .slice(-3)
        .map((s) => s.text)
        .join(' ')
        .slice(0, MAX_QUESTION_LENGTH);
    }
    if (!questionText) {
      this.error(client, 'no_question', 'Type the question, or ask it aloud first so it is transcribed.');
      return;
    }
    this.startQuestion(session, questionText, msg, planned);
  }

  private startQuestion(session: InterviewSession, questionText: string, msg: Record<string, unknown>, planned?: PlannedQuestion): void {
    const current = this.current(session);
    if (current) this.finishQuestion(session, current, 'next_question');

    const concepts = planned?.expectedConcepts.length ? planned.expectedConcepts : cleanList(msg.expectedConcepts);
    const difficulty = planned?.difficulty
      ?? ((['easy', 'medium', 'hard'] as const).includes(msg.difficulty as Difficulty) ? msg.difficulty as Difficulty : session.details.difficulty);
    const index = session.questions.length + 1;
    const question: InterviewQuestion = {
      questionId: `q_${String(index).padStart(3, '0')}_${randomBytes(3).toString('hex')}`,
      index,
      questionText,
      expectedAnswer: clean(msg.expectedAnswer, 1500),
      expectedConcepts: concepts,
      difficulty,
      skills: planned?.skills.length ? planned.skills : cleanList(msg.skills, 4),
      scoringCriteria: 'Correctness 40%, Completeness 25%, Relevance 15%, Technical depth 10%, Clarity 10%.',
      rubricSource: concepts.length ? 'interviewer' : 'none',
      plannedQuestionId: planned?.id ?? null,
      askedAt: Date.now(),
      answerStartedAt: null,
      answeredAt: null,
      answer: '',
      editedAnswer: null,
      editedBy: null,
      editedAt: null,
      lowConfidence: false,
      status: 'not_started',
      evaluation: null,
      evaluationHistory: [],
      evaluationError: null,
      override: null,
      overrideHistory: [],
      finalScore: null,
      interviewerNote: '',
    };
    if (planned) planned.askedQuestionId = question.questionId;
    session.questions.push(question);
    session.currentQuestionId = question.questionId;
    console.log(`[QUESTION] ${session.id} Q${index} started: "${questionText.slice(0, 80)}"`);

    this.send.toRole(session.id, 'interviewer', { type: 'question_started', sessionId: session.id, question, plannedQuestionId: planned?.id ?? null });
    this.send.toRole(session.id, 'candidate', { type: 'question_started', sessionId: session.id, question: publicQuestion(question) });

    if (!concepts.length) this.startRubric(session, question);
  }

  handleQuestionEnd(client: QuestionFlowClient): void {
    const session = this.interviewerSession(client);
    if (!session) return;
    const current = this.current(session);
    if (!current) {
      this.error(client, 'no_question', 'No question is in progress.');
      return;
    }
    this.finishQuestion(session, current, 'interviewer');
  }

  handleRetry(client: QuestionFlowClient, msg: Record<string, unknown>): void {
    const session = this.interviewerSession(client);
    const q = this.findQuestion(session, msg.questionId, client);
    if (!session || !q) return;
    if (q.status !== 'error') {
      this.error(client, 'invalid_state', 'Only failed evaluations can be retried.');
      return;
    }
    this.trackEvaluation(session, q, 'retry');
  }

  handleOverride(client: QuestionFlowClient, msg: Record<string, unknown>): void {
    const session = this.interviewerSession(client);
    const q = this.findQuestion(session, msg.questionId, client);
    if (!session || !q) return;
    if (!q.evaluation) {
      this.error(client, 'invalid_state', 'There is no AI score to override yet.');
      return;
    }
    if (msg.score === null) {
      if (q.override) {
        q.overrideHistory.push({ ...q.override, id: newId('ov'), finalScore: null, overriddenAt: Date.now() });
      }
      q.override = null;
      q.finalScore = q.evaluation.score;
    } else {
      const score = Number(msg.score);
      const reason = clean(msg.reason, 500);
      if (!Number.isInteger(score) || score < 0 || score > 100) {
        this.error(client, 'invalid_override', 'Score must be a whole number from 0 to 100.');
        return;
      }
      if (reason.length < 3) {
        this.error(client, 'invalid_override', 'Please give a short reason for the override.');
        return;
      }
      q.override = {
        id: newId('ov'),
        aiScore: q.evaluation.score,
        finalScore: score,
        overrideReason: reason,
        overriddenBy: session.details.interviewerName,
        overriddenAt: Date.now(),
      };
      q.overrideHistory.push(q.override);
      q.finalScore = score;
    }
    console.log(`[EVAL] ${q.questionId} override → ${q.finalScore} (AI ${q.evaluation.score})`);
    this.send.toRole(session.id, 'interviewer', { type: 'evaluation_updated', sessionId: session.id, question: q });
  }

  /** Private interviewer notes: general, or attached to one question. Never sent to candidates. */
  handleNote(client: QuestionFlowClient, msg: Record<string, unknown>): void {
    const session = this.interviewerSession(client);
    if (!session) return;
    if (typeof msg.text !== 'string' || msg.text.length > MAX_NOTE_LENGTH) {
      this.error(client, 'invalid_note', `Notes can be up to ${MAX_NOTE_LENGTH} characters.`);
      return;
    }
    const text = msg.text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
    if (msg.questionId === undefined || msg.questionId === null) {
      session.generalNotes = text;
      this.send.toRole(session.id, 'interviewer', { type: 'notes_updated', sessionId: session.id, questionId: null, text });
      return;
    }
    const q = this.findQuestion(session, msg.questionId, client);
    if (!q) return;
    q.interviewerNote = text;
    this.send.toRole(session.id, 'interviewer', { type: 'notes_updated', sessionId: session.id, questionId: q.questionId, text });
  }

  // --- Transcript correction + re-evaluation (interviewer/owner only) ---

  handleAnswerEdit(client: QuestionFlowClient, msg: Record<string, unknown>): void {
    const session = this.interviewerSession(client);
    const q = this.findQuestion(session, msg.questionId, client);
    if (!session || !q) return;
    const result = this.editAnswer(session, q, msg.text);
    if (result !== true) this.error(client, 'invalid_edit', result);
  }

  handleReevaluate(client: QuestionFlowClient, msg: Record<string, unknown>): void {
    const session = this.interviewerSession(client);
    const q = this.findQuestion(session, msg.questionId, client);
    if (!session || !q) return;
    const result = this.reevaluate(session, q);
    if (result !== true) this.error(client, 'invalid_state', result);
  }

  /**
   * Stores an interviewer correction of the candidate's answer (the original
   * STT text is kept). `text: null` reverts to the original. Returns true or
   * a user-facing reason it was refused.
   */
  editAnswer(session: InterviewSession, q: InterviewQuestion, text: unknown): true | string {
    if (q.questionId === session.currentQuestionId) return 'End the question before editing its answer.';
    if (text === null) {
      q.editedAnswer = null;
      q.editedBy = null;
      q.editedAt = null;
    } else {
      const clean = typeof text === 'string' ? text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim() : '';
      if (!clean) return 'The corrected answer cannot be empty.';
      if (clean.length > MAX_ANSWER_LENGTH) return `The answer can be up to ${MAX_ANSWER_LENGTH} characters.`;
      q.editedAnswer = clean;
      q.editedBy = session.details.interviewerName;
      q.editedAt = Date.now();
    }
    console.log(`[QUESTION] ${q.questionId} answer ${q.editedAnswer === null ? 'reverted to original' : 'edited'}`);
    this.send.toRole(session.id, 'interviewer', { type: 'evaluation_updated', sessionId: session.id, question: q });
    return true;
  }

  /** Runs a new evaluation on the current (possibly edited) answer; adds a history row. */
  reevaluate(session: InterviewSession, q: InterviewQuestion): true | string {
    if (q.questionId === session.currentQuestionId) return 'End the question before re-evaluating it.';
    if (q.status === 'evaluating') return 'An evaluation is already running for this question.';
    if (!(q.editedAnswer ?? q.answer).trim()) return 'There is no answer to evaluate.';
    this.trackEvaluation(session, q, 'reevaluate');
    return true;
  }

  /** Resolves when the given question's running evaluation finishes. */
  async waitForQuestion(sessionId: string): Promise<void> {
    await this.waitForEvaluations(sessionId);
  }

  /** Interviewer setting: auto-end the answer after candidate silence (default off). */
  handleSettings(client: QuestionFlowClient, msg: Record<string, unknown>): void {
    const session = this.interviewerSession(client);
    if (!session) return;
    if (msg.autoEndOnSilence !== undefined) {
      if (typeof msg.autoEndOnSilence !== 'boolean') {
        this.error(client, 'invalid_settings', 'autoEndOnSilence must be true or false.');
        return;
      }
      session.settings.autoEndOnSilence = msg.autoEndOnSilence;
    }
    if (msg.silenceSeconds !== undefined) {
      const n = Number(msg.silenceSeconds);
      if (!Number.isInteger(n) || n < 2 || n > 60) {
        this.error(client, 'invalid_settings', 'Silence must be a whole number of seconds from 2 to 60.');
        return;
      }
      session.settings.silenceSeconds = n;
    }
    console.log(`[QUESTION] ${session.id} settings: auto-end ${session.settings.autoEndOnSilence ? 'on' : 'off'}, ${session.settings.silenceSeconds}s`);
    this.send.toRole(session.id, 'interviewer', { type: 'settings_updated', sessionId: session.id, settings: session.settings });
  }

  // --- Answer-boundary assistance ---

  /** speaking=null means "just produced speech" (a final transcript). */
  private noteCandidateActivity(sessionId: string, speaking: boolean | null): void {
    const a = this.candidateActivity.get(sessionId) ?? { speaking: false, lastAt: Date.now(), prompted: false };
    if (speaking !== null) a.speaking = speaking;
    a.lastAt = Date.now();
    a.prompted = false; // new speech → a later silence may prompt again
    this.candidateActivity.set(sessionId, a);
  }

  /**
   * After the candidate has answered and then stayed silent for the configured
   * time, either ask the interviewer to end the answer or (auto-end ON) end it.
   * The interviewer's manual controls always remain authoritative.
   */
  private checkSilence(): void {
    const now = Date.now();
    for (const [sessionId, a] of this.candidateActivity) {
      const session = this.sessions.get(sessionId);
      const q = session && this.current(session);
      if (!session || !q || session.status !== 'LIVE') {
        this.candidateActivity.delete(sessionId);
        continue;
      }
      const silentMs = now - a.lastAt;
      // A "speaking" flag with no update for 20s (segments are ≤15s) is stale, e.g. a dropped browser.
      const speaking = a.speaking && silentMs < 20_000;
      if (speaking || a.prompted || !q.answerStartedAt || silentMs < session.settings.silenceSeconds * 1000) continue;
      a.prompted = true;
      if (session.settings.autoEndOnSilence) {
        console.log(`[QUESTION] ${q.questionId} auto-ended after ${Math.round(silentMs / 1000)}s of silence`);
        this.send.toRole(sessionId, 'interviewer', { type: 'answer_auto_ended', sessionId, questionId: q.questionId, reason: 'silence' });
        this.finishQuestion(session, q, 'auto_silence');
      } else {
        this.send.toRole(sessionId, 'interviewer', {
          type: 'answer_silence_prompt', sessionId, questionId: q.questionId, silentSeconds: Math.round(silentMs / 1000),
        });
      }
    }
  }

  /** The interviewer asked something new while an answered question is still open. */
  private onSpokenQuestion(session: InterviewSession, open: InterviewQuestion, text: string): void {
    if (session.settings.autoEndOnSilence) {
      console.log(`[QUESTION] ${open.questionId} closed: interviewer asked a new question (auto-end on)`);
      this.send.toRole(session.id, 'interviewer', { type: 'answer_auto_ended', sessionId: session.id, questionId: open.questionId, reason: 'new_question' });
      this.startQuestion(session, text.slice(0, MAX_QUESTION_LENGTH), {});
      return;
    }
    this.send.toRole(session.id, 'interviewer', {
      type: 'new_question_detected', sessionId: session.id, openQuestionId: open.questionId, text: text.slice(0, MAX_QUESTION_LENGTH),
    });
  }

  /** Resolves once every evaluation running for the session has settled. */
  async waitForEvaluations(sessionId: string): Promise<void> {
    await Promise.allSettled([...(this.evalJobs.get(sessionId) ?? [])]);
  }

  // --- Transcripts ---

  /** Transcript pushed by the interviewer client (manual entry or browser STT). */
  handleClientTranscript(client: QuestionFlowClient, msg: Record<string, unknown>, isFinal: boolean): void {
    const session = this.interviewerSession(client);
    if (!session) return;
    const speaker = msg.speaker === 'candidate' ? 'candidate' : msg.speaker === 'interviewer' ? 'interviewer' : null;
    const text = clean(msg.text, MAX_SEGMENT_LENGTH);
    if (!speaker || !text) {
      this.error(client, 'invalid_transcript', 'Transcript needs a speaker and text.');
      return;
    }
    if (session.status !== 'LIVE') {
      this.error(client, 'invalid_state', 'Answers are only accepted while the interview is live.');
      return;
    }
    this.ingest(session, speaker, text, isFinal);
  }

  /**
   * One speech segment (16 kHz mono PCM16, base64) cut by the sender's browser
   * VAD. Any joined participant may send their own microphone's audio; the
   * speaker label comes from the authenticated participant, never the message.
   */
  handleAudioSegment(client: QuestionFlowClient, msg: Record<string, unknown>): void {
    const binding = client.binding;
    const session = binding ? this.sessions.get(binding.sessionId) : undefined;
    if (!binding || !session || session.status !== 'LIVE' || !this.whisper) return;
    if (typeof msg.data !== 'string' || msg.data.length > MAX_SEGMENT_B64) return;
    const pcm = Buffer.from(msg.data, 'base64');
    if (pcm.length < MIN_SEGMENT_BYTES || pcm.length > MAX_SEGMENT_BYTES || pcm.length % 2) return;

    // Transcribe each participant's segments in order, with a small bounded queue.
    const key = binding.participantId;
    const queue = this.segmentQueues.get(key) ?? { chain: Promise.resolve(), size: 0 };
    if (queue.size >= MAX_QUEUED_SEGMENTS) {
      console.warn(`[STT] ${binding.role} segment dropped: transcription queue full`);
      return;
    }
    queue.size++;
    const speaker = binding.role;
    queue.chain = queue.chain
      .then(() => this.transcribeSegment(session, speaker, pcm))
      .finally(() => { queue.size--; });
    this.segmentQueues.set(key, queue);
  }

  private async transcribeSegment(session: InterviewSession, speaker: 'interviewer' | 'candidate', pcm: Buffer): Promise<void> {
    const started = Date.now();
    try {
      const r = await this.whisper!.transcribe(pcm16ToWav(pcm));
      this.setTranscriptionStatus(session, true);
      const seconds = (pcm.length / 2 / SAMPLE_RATE).toFixed(1);
      if (r.discard) {
        console.log(`[STT] ${speaker} ${seconds}s segment discarded (no speech; no_speech_prob ${r.noSpeechProb})`);
        return;
      }
      console.log(`[STT] ${speaker} ${seconds}s → ${r.text.length} chars in ${Date.now() - started}ms${r.lowConfidence ? ' (low confidence)' : ''}`);
      this.ingest(session, speaker, r.text, true, { source: 'stt', avgLogprob: r.avgLogprob, noSpeechProb: r.noSpeechProb, lowConfidence: r.lowConfidence });
    } catch (err) {
      const code = err instanceof SttError ? err.code : 'unknown';
      console.error(`[STT] ${speaker} segment failed (${code}): ${(err as Error).message}`);
      this.setTranscriptionStatus(session, false);
    }
  }

  /** Tells both participants when transcription stops or resumes working. The call is unaffected. */
  private setTranscriptionStatus(session: InterviewSession, ok: boolean): void {
    const down = this.transcriptionDown.has(session.id);
    if (ok === !down) return;
    if (ok) this.transcriptionDown.delete(session.id); else this.transcriptionDown.add(session.id);
    this.send.toSession(session.id, {
      type: 'transcription_status',
      sessionId: session.id,
      status: ok ? 'ok' : 'unavailable',
      message: ok ? 'Transcription resumed' : 'Transcription unavailable',
    });
  }

  /** Voice activity from a participant's browser (drives the "speaking" indicator). */
  handleSpeechActivity(client: QuestionFlowClient, msg: Record<string, unknown>): void {
    const binding = client.binding;
    const session = binding ? this.sessions.get(binding.sessionId) : undefined;
    if (!binding || !session || session.status !== 'LIVE' || typeof msg.speaking !== 'boolean') return;
    if (binding.role === 'candidate') this.noteCandidateActivity(session.id, msg.speaking);
    this.send.toSession(session.id, { type: 'speech_activity', sessionId: session.id, speaker: binding.role, speaking: msg.speaking });
  }

  /** Streaming PCM of the sender's own microphone (Deepgram mode). Speaker = authenticated role. */
  handleAudio(client: QuestionFlowClient, msg: Record<string, unknown>): void {
    const binding = client.binding;
    const session = binding ? this.sessions.get(binding.sessionId) : undefined;
    if (!binding || !session || session.status !== 'LIVE') return;
    if (typeof msg.data !== 'string' || msg.data.length > MAX_AUDIO_B64) return;

    if (this.sttConfig.provider !== 'deepgram') {
      if (!this.sttWarned.has(session.id)) {
        this.sttWarned.add(session.id);
        this.setTranscriptionStatus(session, false);
      }
      return;
    }

    let stt = this.stt.get(session.id);
    if (!stt) {
      stt = new DeepgramStreamingService({ apiKey: this.sttConfig.apiKey }, (entry) => this.onDeepgram(session.id, entry));
      stt.ensureStreams();
      this.stt.set(session.id, stt);
      this.sttCheckedAt.set(session.id, Date.now());
      console.log(`[STT] Deepgram streams started for ${session.id}`);
    } else if (Date.now() - (this.sttCheckedAt.get(session.id) ?? 0) > 5000) {
      // Deepgram closes idle sockets; restart at most every 5s to avoid reconnect storms.
      this.sttCheckedAt.set(session.id, Date.now());
      stt.ensureStreams();
    }

    const buffer = Buffer.from(msg.data, 'base64');
    if (binding.role === 'candidate') stt.sendCandidateAudio(buffer);
    else stt.sendInterviewerAudio(buffer);
  }

  private onDeepgram(sessionId: string, entry: TranscriptEntry): void {
    const session = this.sessions.get(sessionId);
    if (!session || !entry.text.trim() || entry.speaker === 'system') return;
    const lowConfidence = typeof entry.confidence === 'number' && entry.confidence < 0.6;
    this.ingest(session, entry.speaker, entry.text.trim(), entry.isFinal, { ...MANUAL, source: 'stt', lowConfidence });
  }

  private ingest(session: InterviewSession, speaker: 'interviewer' | 'candidate', text: string, isFinal: boolean, quality: TranscriptQuality = MANUAL): void {
    // Paused or finished interviews accept no new transcript or answers.
    if (session.status !== 'LIVE') return;
    const current = this.current(session);
    const questionId = current?.questionId ?? null;

    if (!isFinal) {
      // Partial: the person is still speaking. Displayed only, never evaluated.
      this.send.toSession(session.id, { type: 'transcript_partial', sessionId: session.id, speaker, text, questionId });
      return;
    }

    const segment: TranscriptSegment = {
      id: newId('seg'),
      sessionId: session.id,
      questionId,
      speaker,
      text,
      timestamp: Date.now(),
      ...quality,
    };
    session.transcript.push(segment);
    if (session.transcript.length > 2000) session.transcript = session.transcript.slice(-2000);
    this.send.toSession(session.id, { type: 'transcript_final', ...segment });

    if (speaker === 'candidate') this.noteCandidateActivity(session.id, null);
    if (speaker === 'interviewer' && current?.answerStartedAt && quality.source === 'stt' && looksLikeQuestion(text)) {
      this.onSpokenQuestion(session, current, text);
    }

    if (speaker === 'candidate' && current) {
      if (!current.answerStartedAt) {
        current.answerStartedAt = segment.timestamp;
        current.status = 'answering';
        this.send.toSession(session.id, { type: 'answer_started', sessionId: session.id, questionId: current.questionId });
      }
      current.answer = `${current.answer} ${text}`.trim().slice(0, MAX_ANSWER_LENGTH);
      if (segment.lowConfidence) current.lowConfidence = true;
    }
  }

  // --- Lifecycle ---

  /** Called when the interview ends: the last answer still gets evaluated. */
  onInterviewEnded(session: InterviewSession): void {
    const current = this.current(session);
    if (current) this.finishQuestion(session, current, 'interview_ended');
    this.stopTranscription(session.id);
  }

  stopTranscription(sessionId: string): void {
    this.stt.get(sessionId)?.stop();
    this.stt.delete(sessionId);
    this.sttCheckedAt.delete(sessionId);
    this.transcriptionDown.delete(sessionId);
  }

  private finishQuestion(session: InterviewSession, q: InterviewQuestion, reason: string): void {
    session.currentQuestionId = null;
    this.candidateActivity.delete(session.id);
    q.answeredAt = Date.now();
    const hasAnswer = q.answer.trim().length > 0;
    console.log(`[QUESTION] ${q.questionId} ended (${reason}); answer ${hasAnswer ? `${q.answer.length} chars` : 'empty'}`);

    this.send.toSession(session.id, { type: 'answer_completed', sessionId: session.id, questionId: q.questionId, hasAnswer });
    if (!hasAnswer) {
      q.status = 'no_answer';
      this.send.toRole(session.id, 'interviewer', { type: 'evaluation_updated', sessionId: session.id, question: q });
      return;
    }
    this.trackEvaluation(session, q);
  }

  private trackEvaluation(session: InterviewSession, q: InterviewQuestion, trigger: Evaluation['trigger'] = 'auto'): void {
    const jobs = this.evalJobs.get(session.id) ?? new Set<Promise<void>>();
    const job: Promise<void> = this.runEvaluation(session, q, trigger).finally(() => jobs.delete(job));
    jobs.add(job);
    this.evalJobs.set(session.id, jobs);
  }

  private startRubric(session: InterviewSession, q: InterviewQuestion): void {
    const key = `${session.id}:${q.questionId}`;
    const job = this.evaluator.generateRubric(q.questionText, session.details.position)
      .then((rubric) => {
        if (rubric.source === 'none') return;
        q.expectedAnswer = rubric.expectedAnswer;
        q.expectedConcepts = rubric.expectedConcepts;
        q.difficulty = rubric.difficulty;
        q.skills = rubric.skills;
        if (rubric.scoringCriteria) q.scoringCriteria = `${q.scoringCriteria} ${rubric.scoringCriteria}`;
        q.rubricSource = 'ai';
        this.send.toRole(session.id, 'interviewer', { type: 'question_updated', sessionId: session.id, question: q });
      })
      .catch((err) => {
        // The evaluator can still judge key concepts itself.
        console.warn(`[EVAL] Rubric generation failed for ${q.questionId}: ${(err as Error).message}`);
      })
      .finally(() => this.rubricJobs.delete(key));
    this.rubricJobs.set(key, job);
  }

  private async runEvaluation(session: InterviewSession, q: InterviewQuestion, trigger: Evaluation['trigger'] = 'auto'): Promise<void> {
    q.status = 'evaluating';
    q.evaluationError = null;
    this.send.toRole(session.id, 'interviewer', { type: 'evaluation_started', sessionId: session.id, questionId: q.questionId });
    console.log(`[EVAL] ${q.questionId} evaluation started`);
    const started = Date.now();

    try {
      const pendingRubric = this.rubricJobs.get(`${session.id}:${q.questionId}`);
      if (pendingRubric) {
        await Promise.race([pendingRubric, new Promise((r) => setTimeout(r, RUBRIC_WAIT_MS))]);
      }
      const rubric: Rubric = {
        expectedAnswer: q.expectedAnswer,
        expectedConcepts: q.expectedConcepts,
        difficulty: q.difficulty,
        skills: q.skills,
        scoringCriteria: q.scoringCriteria,
        source: q.rubricSource,
      };
      // An interviewer-corrected transcript takes precedence over the raw STT text.
      const answerSource = q.editedAnswer !== null ? 'edited' : 'original';
      const answerText = q.editedAnswer ?? q.answer;
      const result = await this.evaluator.evaluateAnswer({
        questionId: q.questionId,
        questionText: q.questionText,
        rubric,
        candidateAnswer: answerText,
        interviewContext: {
          position: session.details.position,
          questionNumber: q.index,
          previousQuestions: session.questions.filter((x) => x.index < q.index).slice(-3).map((x) => x.questionText),
        },
      });
      // Append-only history: a re-evaluation adds a run, it never replaces one.
      const evaluation: Evaluation = { ...result, id: newId('ev'), answerSource, answerText, trigger };
      q.evaluationHistory.push(evaluation);
      q.evaluation = evaluation;
      q.finalScore = q.override?.finalScore ?? evaluation.score;
      q.status = 'completed';
      console.log(`[EVAL] ${q.questionId} completed: ${evaluation.score}/100 (${evaluation.evaluator}, ${Date.now() - started}ms)`);
      this.send.toRole(session.id, 'interviewer', {
        type: 'evaluation_completed',
        sessionId: session.id,
        questionId: q.questionId,
        score: evaluation.score,
        breakdown: evaluation.breakdown,
        question: q,
      });
    } catch (err) {
      const code = err instanceof EvaluationError ? err.code : 'unknown';
      console.error(`[EVAL] ${q.questionId} failed (${code}, ${Date.now() - started}ms): ${(err as Error).message}`);
      q.status = 'error';
      q.evaluationError = UNAVAILABLE;
      this.send.toRole(session.id, 'interviewer', {
        type: 'evaluation_error',
        sessionId: session.id,
        questionId: q.questionId,
        message: UNAVAILABLE,
        retryable: true,
      });
    }
  }

  // --- Helpers ---

  private findQuestion(session: InterviewSession | undefined, questionId: unknown, client: QuestionFlowClient): InterviewQuestion | undefined {
    if (!session) return undefined;
    const q = typeof questionId === 'string' && QUESTION_ID.test(questionId)
      ? session.questions.find((x) => x.questionId === questionId)
      : undefined;
    if (!q) this.error(client, 'invalid_question', 'Unknown question.');
    return q;
  }

  private current(session: InterviewSession): InterviewQuestion | undefined {
    return session.questions.find((q) => q.questionId === session.currentQuestionId);
  }

  private interviewerSession(client: QuestionFlowClient, report = true): InterviewSession | undefined {
    const binding = client.binding;
    const session = binding ? this.sessions.get(binding.sessionId) : undefined;
    if (!binding || !session) {
      if (report) this.error(client, 'not_joined', 'Join the interview first.');
      return undefined;
    }
    // Question control, transcripts and audio are interviewer-only (server-enforced).
    if (binding.role !== 'interviewer') {
      if (report) this.error(client, 'forbidden', 'Only the interviewer can do that.');
      return undefined;
    }
    return session;
  }

  private error(client: QuestionFlowClient, code: string, message: string): void {
    client.send({ type: 'error', code, message });
  }
}
