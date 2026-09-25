import { randomBytes } from 'crypto';
import { EvaluationError, type EvaluationService } from './evaluationService';
import type { Difficulty, Evaluation, InterviewQuestion, Rubric, TranscriptSegment } from './evaluationTypes';
import type { InterviewSession, ParticipantBinding, ParticipantRole, SessionManager } from './sessionManager';
import type { PlannedQuestion } from './reportTypes';
import type { CoachingService } from './coachingService';

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

export type TranscriptQuality = {
  source: 'stt' | 'manual';
  confidence: number | null;
  avgLogprob: number | null;
  noSpeechProb: number | null;
  lowConfidence: boolean;
};
const MANUAL: TranscriptQuality = { source: 'manual', confidence: null, avgLogprob: null, noSpeechProb: null, lowConfidence: false };

/** Identifies an STT utterance: partials and the final share segmentId. */
export type TranscriptMeta = { segmentId: string; participantId: string };
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
  const words = t.split(/\s+/).length;
  // An explicit question mark is strong evidence, so short ones count too
  // ("What is Python?"). Without one, require a longer interrogative opening.
  return t.endsWith('?') ? words >= 3 : words >= 4 && QUESTION_START.test(t);
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

  // Answer-boundary assistance, per session.
  private candidateActivity = new Map<string, { speaking: boolean; lastAt: number; prompted: boolean }>(); // sessions currently told "Transcription unavailable"

  constructor(
    private readonly sessions: SessionManager,
    private readonly evaluator: EvaluationService,
    private readonly send: Senders,
    /** 'stream' when a speech-to-text provider is configured. */
    private readonly transcriptionMode: () => 'stream' | 'unavailable',
    /** Candidate coaching, when the feature is wired in. */
    private readonly coaching?: CoachingService
  ) {
    setInterval(() => this.checkSilence(), 1000).unref();
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
        transcription: this.transcriptionMode(),
        // The interviewer is told coaching is on, but never sees its content.
        coachingEnabled: this.coaching?.enabledFor(session) ?? false,
      };
    }
    // The candidate is told whether the conversation is transcribed, never how it is scored.
    return {
      currentQuestion: current ? publicQuestion(current) : null,
      transcription: this.transcriptionMode(),
      ...(this.coaching?.joinData(session) ?? { coachingEnabled: false }),
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
    console.log(`[QUESTION] ${session.id} Q${index} question started: "${questionText.slice(0, 80)}"`);

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

  /** The interviewer asked something new while an answered question is still open — auto-end and start the new one. */
  private onSpokenQuestion(session: InterviewSession, open: InterviewQuestion, text: string): void {
    console.log(`[QUESTION] ${open.questionId} auto-closed: interviewer asked a new question`);
    this.send.toRole(session.id, 'interviewer', { type: 'answer_auto_ended', sessionId: session.id, questionId: open.questionId, reason: 'new_question' });
    this.startQuestion(session, text.slice(0, MAX_QUESTION_LENGTH), {});
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
   * Voice activity from the server-side VAD on a participant's stream: drives
   * the "speaking…" indicator and the candidate-silence answer suggestion.
   */
  onSpeechActivity(sessionId: string, role: ParticipantRole, speaking: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'LIVE') return;
    if (role === 'candidate') this.noteCandidateActivity(sessionId, speaking);
    this.send.toSession(sessionId, { type: 'speech_activity', sessionId, speaker: role, role: role.toUpperCase(), speaking });
  }

  /** Entry point for STT results (partials are shown, only finals are stored). */
  ingestTranscript(sessionId: string, role: ParticipantRole, text: string, isFinal: boolean, quality: TranscriptQuality, meta: TranscriptMeta): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.ingest(session, role, text.slice(0, MAX_SEGMENT_LENGTH), isFinal, quality, meta);
  }

  private ingest(session: InterviewSession, speaker: 'interviewer' | 'candidate', text: string, isFinal: boolean,
    quality: TranscriptQuality = MANUAL, meta?: TranscriptMeta): void {
    // Paused or finished interviews accept no new transcript or answers.
    if (session.status !== 'LIVE') return;
    const current = this.current(session);
    const questionId = current?.questionId ?? null;

    const participantId = meta?.participantId ?? `${speaker}_${session.id}`;
    if (!isFinal) {
      // Partial: the person is still speaking. Displayed only, never stored or evaluated.
      this.send.toSession(session.id, {
        type: 'transcript_partial', sessionId: session.id, segmentId: meta?.segmentId ?? null,
        participantId, speaker, role: speaker.toUpperCase(), text, questionId,
      });
      return;
    }

    const segment: TranscriptSegment = {
      id: meta?.segmentId ?? newId('seg'),
      sessionId: session.id,
      questionId,
      speaker,
      text,
      timestamp: Date.now(),
      ...quality,
    };
    session.transcript.push(segment);
    if (session.transcript.length > 2000) session.transcript = session.transcript.slice(-2000);
    this.send.toSession(session.id, {
      type: 'transcript_final', ...segment, segmentId: segment.id, participantId, role: speaker.toUpperCase(),
    });

    if (speaker === 'candidate') this.noteCandidateActivity(session.id, null);
    if (speaker === 'interviewer' && quality.source === 'stt' && looksLikeQuestion(text)) {
      if (current?.answerStartedAt) {
        // A new question while the candidate is answering: auto-end and start the new one.
        this.onSpokenQuestion(session, current, text);
      } else if (!current) {
        // No active question: auto-start tracking this spoken question.
        this.startQuestion(session, text.slice(0, MAX_QUESTION_LENGTH), {});
      }
    }
    // Candidate coaching, when the interview has it switched on. Only the
    // interviewer's spoken words can trigger it, and only finals get this far.
    if (speaker === 'interviewer' && quality.source === 'stt') {
      this.coaching?.onInterviewerFinal(session, text, looksLikeQuestion);
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
    this.coaching?.onInterviewEnded(session.id);
    const current = this.current(session);
    if (current) this.finishQuestion(session, current, 'interview_ended');
  }

  private finishQuestion(session: InterviewSession, q: InterviewQuestion, reason: string): void {
    session.currentQuestionId = null;
    this.candidateActivity.delete(session.id);
    q.answeredAt = Date.now();
    const hasAnswer = q.answer.trim().length > 0;
    console.log(`[ANSWER] ${q.questionId} answer completed (${reason}); ${hasAnswer ? `${q.answer.length} chars` : 'empty'}`);

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

  /**
   * The candidate's own answer feedback. Only in practice interviews (the same
   * opt-in flag as coaching), so an assessed interview still shows the candidate
   * nothing. This is a separate, narrower payload than the interviewer's: no
   * rubric, no expected answer, no override or note fields, no other question.
   */
  private sendCandidateFeedback(
    session: InterviewSession,
    q: InterviewQuestion,
    opts: { state: 'evaluating' | 'ready' | 'error'; evaluation?: Evaluation }
  ): void {
    if (!session.settings.candidateCoaching) return;
    const base = {
      type: 'answer_evaluation',
      sessionId: session.id,
      questionId: q.questionId,
      questionText: q.questionText,
      state: opts.state,
    };
    if (opts.state !== 'ready' || !opts.evaluation) {
      this.send.toRole(session.id, 'candidate', {
        ...base,
        ...(opts.state === 'error' ? { message: 'Answer evaluation unavailable.' } : {}),
      });
      return;
    }
    const e = opts.evaluation;
    this.send.toRole(session.id, 'candidate', {
      ...base,
      answer: e.answerText,
      score: e.score, // 0–100, exactly as the evaluator computed it
      breakdown: e.breakdown,
      strengths: e.strengths,
      improvements: e.improvements,
      missingConcepts: e.missingConcepts,
      followUpQuestion: e.followUpQuestion,
      evaluatedAt: e.evaluatedAt,
    });
  }

  private async runEvaluation(session: InterviewSession, q: InterviewQuestion, trigger: Evaluation['trigger'] = 'auto'): Promise<void> {
    q.status = 'evaluating';
    q.evaluationError = null;
    this.send.toRole(session.id, 'interviewer', { type: 'evaluation_started', sessionId: session.id, questionId: q.questionId });
    this.sendCandidateFeedback(session, q, { state: 'evaluating' });
    console.log(`[AI] ${q.questionId} evaluation started`);
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
      console.log(`[AI] ${q.questionId} evaluation completed: ${evaluation.score}/100 (${evaluation.evaluator}, ${Date.now() - started}ms)`);
      this.send.toRole(session.id, 'interviewer', {
        type: 'evaluation_completed',
        sessionId: session.id,
        questionId: q.questionId,
        score: evaluation.score,
        breakdown: evaluation.breakdown,
        question: q,
      });
      this.sendCandidateFeedback(session, q, { state: 'ready', evaluation });
    } catch (err) {
      const code = err instanceof EvaluationError ? err.code : 'unknown';
      console.error(`[AI] ${q.questionId} evaluation failed (${code}, ${Date.now() - started}ms): ${(err as Error).message}`);
      q.status = 'error';
      q.evaluationError = UNAVAILABLE;
      this.send.toRole(session.id, 'interviewer', {
        type: 'evaluation_error',
        sessionId: session.id,
        questionId: q.questionId,
        message: UNAVAILABLE,
        retryable: true,
      });
      this.sendCandidateFeedback(session, q, { state: 'error' });
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
