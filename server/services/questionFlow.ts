import { randomBytes } from 'crypto';
import { DeepgramStreamingService } from './deepgramSTT';
import { EvaluationError, type EvaluationService } from './evaluationService';
import type { Difficulty, Evaluation, InterviewQuestion, Rubric, TranscriptSegment } from './evaluationTypes';
import type { InterviewSession, ParticipantBinding, ParticipantRole, SessionManager } from './sessionManager';
import type { TranscriptEntry } from '../types';

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
const MAX_AUDIO_B64 = 96 * 1024;
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
  private stt = new Map<string, DeepgramStreamingService>();
  private sttCheckedAt = new Map<string, number>();
  private sttWarned = new Set<string>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly evaluator: EvaluationService,
    private readonly send: Senders,
    private readonly deepgramKey: string | null
  ) {}

  /** Extra data for session_joined, filtered by role. */
  joinData(session: InterviewSession, role: ParticipantRole): Record<string, unknown> {
    const current = session.questions.find((q) => q.questionId === session.currentQuestionId) ?? null;
    if (role === 'interviewer') {
      return {
        questions: session.questions,
        currentQuestionId: session.currentQuestionId,
        plannedQuestions: session.details.plannedQuestions,
        generalNotes: session.generalNotes,
        transcript: session.transcript.slice(-100),
        evaluator: this.evaluator.demoMode ? 'demo-heuristic' : 'llm',
        transcription: this.deepgramKey ? 'deepgram' : 'unavailable',
      };
    }
    // The candidate is told whether the conversation is transcribed, never how it is scored.
    return {
      currentQuestion: current ? publicQuestion(current) : null,
      transcription: this.deepgramKey ? 'deepgram' : 'unavailable',
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

  /** Audio uploaded by the interviewer client: its own mic and the candidate's remote track. */
  handleAudio(client: QuestionFlowClient, msg: Record<string, unknown>): void {
    const session = this.interviewerSession(client, false);
    if (!session || session.status !== 'LIVE') return;
    const speaker = msg.speaker === 'candidate' ? 'candidate' : msg.speaker === 'interviewer' ? 'interviewer' : null;
    if (!speaker || typeof msg.data !== 'string' || msg.data.length > MAX_AUDIO_B64) return;

    if (!this.deepgramKey) {
      if (!this.sttWarned.has(session.id)) {
        this.sttWarned.add(session.id);
        this.error(client, 'stt_unavailable', 'Speech-to-text is not configured on the server. Type questions and use manual answers.');
      }
      return;
    }

    let stt = this.stt.get(session.id);
    if (!stt) {
      stt = new DeepgramStreamingService({ apiKey: this.deepgramKey }, (entry) => this.onDeepgram(session.id, entry));
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
    if (speaker === 'candidate') stt.sendCandidateAudio(buffer);
    else stt.sendInterviewerAudio(buffer);
  }

  private onDeepgram(sessionId: string, entry: TranscriptEntry): void {
    const session = this.sessions.get(sessionId);
    if (!session || !entry.text.trim() || entry.speaker === 'system') return;
    this.ingest(session, entry.speaker, entry.text.trim(), entry.isFinal);
  }

  private ingest(session: InterviewSession, speaker: 'interviewer' | 'candidate', text: string, isFinal: boolean): void {
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
      source: 'manual',
      avgLogprob: null,
      noSpeechProb: null,
      lowConfidence: false,
    };
    session.transcript.push(segment);
    if (session.transcript.length > 2000) session.transcript = session.transcript.slice(-2000);
    this.send.toSession(session.id, { type: 'transcript_final', ...segment });

    if (speaker === 'candidate' && current) {
      if (!current.answerStartedAt) {
        current.answerStartedAt = segment.timestamp;
        current.status = 'answering';
        this.send.toSession(session.id, { type: 'answer_started', sessionId: session.id, questionId: current.questionId });
      }
      current.answer = `${current.answer} ${text}`.trim().slice(0, MAX_ANSWER_LENGTH);
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
  }

  private finishQuestion(session: InterviewSession, q: InterviewQuestion, reason: string): void {
    session.currentQuestionId = null;
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
