import type { PrismaClient, Prisma } from '@prisma/client';
import type { InterviewSession, Participant } from '../services/sessionManager';
import type { Evaluation, InterviewQuestion, ScoreOverrideRecord, TranscriptSegment } from '../services/evaluationTypes';
import type { InterviewReport } from '../services/reportTypes';

/**
 * Persists interview sessions to SQLite as normalized rows.
 *
 * The in-memory SessionManager stays the working copy used by the realtime
 * code; this repository mirrors it to the database. `sync` writes only rows
 * whose content changed since the last write (tracked per row), so it is cheap
 * to call every second. Evaluations, overrides, transcript segments, chat
 * messages and reports are insert-only: history is never overwritten.
 */

const J = (v: unknown) => JSON.stringify(v);
const P = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};
const D = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms));
const T = (d: Date | null | undefined) => (d ? d.getTime() : null);

type RowSet = {
  interview: Prisma.InterviewUncheckedCreateInput;
  participants: Prisma.ParticipantUncheckedCreateInput[];
  questions: Prisma.QuestionUncheckedCreateInput[];
  answers: Prisma.AnswerUncheckedCreateInput[];
  transcript: Prisma.TranscriptSegmentUncheckedCreateInput[];
  evaluations: Prisma.EvaluationUncheckedCreateInput[];
  overrides: Prisma.ScoreOverrideUncheckedCreateInput[];
  notes: Prisma.InterviewerNoteUncheckedCreateInput[];
  chat: Prisma.ChatMessageUncheckedCreateInput[];
  reports: Prisma.FinalReportUncheckedCreateInput[];
};

function toRows(s: InterviewSession): RowSet {
  const d = s.details;
  const rows: RowSet = {
    interview: {
      id: s.id,
      roomName: s.roomName,
      ownerId: d.ownerId,
      status: s.status,
      candidateName: d.candidateName,
      candidateEmail: d.candidateEmail,
      interviewerName: d.interviewerName,
      position: d.position,
      durationMinutes: d.durationMinutes,
      allowCandidateScreenShare: d.allowCandidateScreenShare,
      skills: J(d.skills),
      difficulty: d.difficulty,
      plannedQuestions: J(d.plannedQuestions),
      candidateKey: s.candidateKey,
      joinCode: s.joinCode || '',
      settings: J(s.settings),
      review: J(s.review),
      reportStatus: s.reportStatus,
      currentQuestionId: s.currentQuestionId,
      elapsedMs: Math.round(s.elapsedMs),
      liveSince: D(s.liveSince),
      createdAt: new Date(s.createdAt),
      startedAt: D(s.startedAt),
      endedAt: D(s.endedAt),
      lastActivity: new Date(s.lastActivity),
    },
    participants: [...s.participants.entries()].map(([keyHash, p]) => ({
      keyHash, interviewId: s.id, role: p.role, name: p.name, createdAt: new Date(p.createdAt),
    })),
    questions: [],
    answers: [],
    transcript: s.transcript.map((t) => ({
      id: t.id,
      interviewId: s.id,
      questionId: t.questionId,
      speaker: t.speaker,
      text: t.text,
      timestamp: new Date(t.timestamp),
      source: t.source,
      confidence: t.confidence,
      avgLogprob: t.avgLogprob,
      noSpeechProb: t.noSpeechProb,
      lowConfidence: t.lowConfidence,
    })),
    evaluations: [],
    overrides: [],
    notes: [],
    chat: s.messages.map((m) => ({
      id: m.id, interviewId: s.id, role: m.role, sender: m.sender, content: m.content, timestamp: new Date(m.timestamp),
    })),
    reports: s.report ? [{ id: `${s.id}:${s.report.generatedAt}`, interviewId: s.id, data: J(s.report), generatedAt: new Date(s.report.generatedAt) }] : [],
  };

  if (s.generalNotes) rows.notes.push({ id: `${s.id}:general`, interviewId: s.id, questionId: null, text: s.generalNotes, updatedAt: new Date() });

  for (const q of s.questions) {
    rows.questions.push({
      id: q.questionId,
      interviewId: s.id,
      index: q.index,
      text: q.questionText,
      expectedAnswer: q.expectedAnswer,
      expectedConcepts: J(q.expectedConcepts),
      difficulty: q.difficulty,
      skills: J(q.skills),
      scoringCriteria: q.scoringCriteria,
      rubricSource: q.rubricSource,
      plannedQuestionId: q.plannedQuestionId,
      status: q.status,
      evaluationError: q.evaluationError,
      askedAt: new Date(q.askedAt),
      answerStartedAt: D(q.answerStartedAt),
      answeredAt: D(q.answeredAt),
    });
    if (q.answer || q.editedAnswer !== null) {
      rows.answers.push({
        questionId: q.questionId,
        interviewId: s.id,
        originalTranscript: q.answer,
        editedTranscript: q.editedAnswer,
        editedBy: q.editedBy,
        editedAt: D(q.editedAt),
        lowConfidence: q.lowConfidence,
      });
    }
    for (const e of q.evaluationHistory) rows.evaluations.push(evaluationRow(s.id, q, e));
    for (const o of q.overrideHistory) {
      rows.overrides.push({
        id: o.id, interviewId: s.id, questionId: q.questionId, aiScore: o.aiScore, finalScore: o.finalScore,
        reason: o.overrideReason, overriddenBy: o.overriddenBy, createdAt: new Date(o.overriddenAt),
      });
    }
    if (q.interviewerNote) {
      rows.notes.push({ id: `${s.id}:${q.questionId}`, interviewId: s.id, questionId: q.questionId, text: q.interviewerNote, updatedAt: new Date() });
    }
  }
  return rows;
}

function evaluationRow(interviewId: string, q: InterviewQuestion, e: Evaluation): Prisma.EvaluationUncheckedCreateInput {
  return {
    id: e.id,
    interviewId,
    questionId: q.questionId,
    score: e.score,
    ...e.breakdown,
    coveredConcepts: J(e.coveredConcepts),
    missingConcepts: J(e.missingConcepts),
    factualErrors: J(e.factualErrors),
    strengths: J(e.strengths),
    improvements: J(e.improvements),
    confidence: e.confidence,
    followUpQuestion: e.followUpQuestion,
    evaluator: e.evaluator,
    model: e.model,
    answerSource: e.answerSource,
    answerText: e.answerText, // exactly what was evaluated, for auditability
    trigger: e.trigger,
    createdAt: new Date(e.evaluatedAt),
  };
}

// Rows whose content changes over time; everything else is insert-only.
const MUTABLE = new Set(['interview', 'questions', 'answers', 'notes']);
// Notes rows carry updatedAt=now; compare them without it.
const signature = (table: string, row: Record<string, unknown>) =>
  J(table === 'notes' ? { ...row, updatedAt: undefined } : row);

export class InterviewRepository {
  private written = new Map<string, string>(); // `${table}:${id}` → signature
  private syncing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  async loadAll(): Promise<InterviewSession[]> {
    const rows = await this.prisma.interview.findMany({
      where: { ownerId: { not: null } },
      include: {
        participants: true,
        questions: { orderBy: { index: 'asc' } },
        answers: true,
        transcript: { orderBy: { timestamp: 'asc' } },
        evaluations: { orderBy: { createdAt: 'asc' } },
        overrides: { orderBy: { createdAt: 'asc' } },
        notes: true,
        chat: { orderBy: { timestamp: 'asc' } },
        reports: { orderBy: { generatedAt: 'desc' }, take: 1 },
      },
    });

    const sessions = rows.map((r) => {
      const notes = new Map(r.notes.map((n) => [n.questionId ?? 'general', n.text]));
      const answers = new Map(r.answers.map((a) => [a.questionId, a]));
      const questions: InterviewQuestion[] = r.questions.map((qr) => {
        const a = answers.get(qr.id);
        const evaluationHistory: Evaluation[] = r.evaluations.filter((e) => e.questionId === qr.id).map((e) => ({
          id: e.id,
          questionId: qr.id,
          score: e.score,
          breakdown: { correctness: e.correctness, completeness: e.completeness, relevance: e.relevance, technicalDepth: e.technicalDepth, clarity: e.clarity },
          coveredConcepts: P(e.coveredConcepts, []),
          missingConcepts: P(e.missingConcepts, []),
          factualErrors: P(e.factualErrors, []),
          strengths: P(e.strengths, []),
          improvements: P(e.improvements, []),
          confidence: e.confidence,
          followUpQuestion: e.followUpQuestion,
          evaluator: e.evaluator as Evaluation['evaluator'],
          model: e.model,
          evaluatedAt: e.createdAt.getTime(),
          answerSource: e.answerSource as Evaluation['answerSource'],
          answerText: e.answerText,
          trigger: e.trigger as Evaluation['trigger'],
        }));
        const overrideHistory: ScoreOverrideRecord[] = r.overrides.filter((o) => o.questionId === qr.id).map((o) => ({
          id: o.id, aiScore: o.aiScore, finalScore: o.finalScore, overrideReason: o.reason, overriddenBy: o.overriddenBy, overriddenAt: o.createdAt.getTime(),
        }));
        const lastOverride = overrideHistory.at(-1);
        const override = lastOverride && lastOverride.finalScore !== null ? { ...lastOverride, finalScore: lastOverride.finalScore } : null;
        const evaluation = evaluationHistory.at(-1) ?? null;
        return {
          questionId: qr.id,
          index: qr.index,
          questionText: qr.text,
          expectedAnswer: qr.expectedAnswer,
          expectedConcepts: P(qr.expectedConcepts, []),
          difficulty: qr.difficulty as InterviewQuestion['difficulty'],
          skills: P(qr.skills, []),
          scoringCriteria: qr.scoringCriteria,
          rubricSource: qr.rubricSource as InterviewQuestion['rubricSource'],
          plannedQuestionId: qr.plannedQuestionId,
          askedAt: qr.askedAt.getTime(),
          answerStartedAt: T(qr.answerStartedAt),
          answeredAt: T(qr.answeredAt),
          answer: a?.originalTranscript ?? '',
          editedAnswer: a?.editedTranscript ?? null,
          editedBy: a?.editedBy ?? null,
          editedAt: T(a?.editedAt),
          lowConfidence: a?.lowConfidence ?? false,
          status: qr.status as InterviewQuestion['status'],
          evaluation,
          evaluationHistory,
          evaluationError: qr.evaluationError,
          override,
          overrideHistory,
          finalScore: evaluation ? (override?.finalScore ?? evaluation.score) : null,
          interviewerNote: notes.get(qr.id) ?? '',
        };
      });

      const participants = new Map<string, Participant>(r.participants.map((p) => [
        p.keyHash, { role: p.role as Participant['role'], name: p.name, createdAt: p.createdAt.getTime(), connected: 0 },
      ]));
      const transcript: TranscriptSegment[] = r.transcript.map((t) => ({
        id: t.id, sessionId: r.id, questionId: t.questionId, speaker: t.speaker as TranscriptSegment['speaker'], text: t.text,
        timestamp: t.timestamp.getTime(), source: t.source as TranscriptSegment['source'],
        confidence: t.confidence, avgLogprob: t.avgLogprob, noSpeechProb: t.noSpeechProb, lowConfidence: t.lowConfidence,
      }));

      const session: InterviewSession = {
        id: r.id,
        roomName: r.roomName,
        status: r.status as InterviewSession['status'],
        details: {
          ownerId: r.ownerId,
          candidateName: r.candidateName,
          candidateEmail: r.candidateEmail,
          interviewerName: r.interviewerName,
          position: r.position,
          durationMinutes: r.durationMinutes,
          allowCandidateScreenShare: r.allowCandidateScreenShare,
          skills: P(r.skills, []),
          difficulty: r.difficulty as InterviewSession['details']['difficulty'],
          plannedQuestions: P(r.plannedQuestions, []),
        },
        candidateKey: r.candidateKey,
        joinCode: r.joinCode || '',
        participants,
        settings: P(r.settings, { autoEndOnSilence: false, silenceSeconds: 5, candidateCoaching: false }),
        messages: r.chat.map((m) => ({ id: m.id, role: m.role as 'user' | 'assistant', sender: m.sender as InterviewSession['messages'][number]['sender'], content: m.content, timestamp: m.timestamp.getTime() })),
        pending: false,
        questions,
        currentQuestionId: r.currentQuestionId,
        transcript,
        generalNotes: notes.get('general') ?? '',
        report: r.reports[0] ? P<InterviewReport | null>(r.reports[0].data, null) : null,
        reportStatus: r.reportStatus as InterviewSession['reportStatus'],
        review: P(r.review, { decision: 'undecided', finalScore: null, notes: '', comments: '', updatedAt: null, updatedBy: null }),
        createdAt: r.createdAt.getTime(),
        startedAt: T(r.startedAt),
        endedAt: T(r.endedAt),
        elapsedMs: r.elapsedMs,
        liveSince: T(r.liveSince),
        lastActivity: r.lastActivity.getTime(),
      };
      return session;
    });

    // Seed the change tracker so loading doesn't trigger a full rewrite.
    for (const s of sessions) this.markWritten(toRows(s));
    return sessions;
  }

  /** Writes changed rows for one session in a single transaction. */
  async sync(session: InterviewSession): Promise<number> {
    const rows = toRows(session);
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    const pending: [string, string][] = [];
    const take = (table: string, id: string, row: Record<string, unknown>) => {
      const key = `${table}:${id}`;
      const sig = signature(table, row);
      if (this.written.get(key) === sig) return false;
      if (!MUTABLE.has(table) && this.written.has(key)) return false; // insert-only
      pending.push([key, sig]);
      return true;
    };

    if (take('interview', rows.interview.id, rows.interview)) {
      ops.push(this.prisma.interview.upsert({ where: { id: rows.interview.id }, create: rows.interview, update: rows.interview }));
    }
    for (const p of rows.participants) {
      if (take('participants', p.keyHash, p)) ops.push(this.prisma.participant.upsert({ where: { keyHash: p.keyHash }, create: p, update: {} }));
    }
    for (const q of rows.questions) {
      if (take('questions', q.id, q)) ops.push(this.prisma.question.upsert({ where: { id: q.id }, create: q, update: q }));
    }
    for (const a of rows.answers) {
      if (take('answers', a.questionId, a)) ops.push(this.prisma.answer.upsert({ where: { questionId: a.questionId }, create: a, update: a }));
    }
    for (const t of rows.transcript) {
      if (take('transcript', t.id, t)) ops.push(this.prisma.transcriptSegment.upsert({ where: { id: t.id }, create: t, update: {} }));
    }
    for (const e of rows.evaluations) {
      if (take('evaluations', e.id, e)) ops.push(this.prisma.evaluation.upsert({ where: { id: e.id }, create: e, update: {} }));
    }
    for (const o of rows.overrides) {
      if (take('overrides', o.id, o)) ops.push(this.prisma.scoreOverride.upsert({ where: { id: o.id }, create: o, update: {} }));
    }
    for (const n of rows.notes) {
      if (take('notes', n.id, n)) ops.push(this.prisma.interviewerNote.upsert({ where: { id: n.id }, create: n, update: n }));
    }
    for (const c of rows.chat) {
      if (take('chat', c.id, c)) ops.push(this.prisma.chatMessage.upsert({ where: { id: c.id }, create: c, update: {} }));
    }
    for (const r of rows.reports) {
      if (take('reports', r.id, r)) ops.push(this.prisma.finalReport.upsert({ where: { id: r.id }, create: r, update: {} }));
    }
    // A cleared note must not linger in the database.
    if (!session.generalNotes && this.written.has(`notes:${session.id}:general`)) {
      ops.push(this.prisma.interviewerNote.deleteMany({ where: { id: `${session.id}:general` } }));
      this.written.delete(`notes:${session.id}:general`);
    }

    if (!ops.length) return 0;
    await this.prisma.$transaction(ops);
    for (const [key, sig] of pending) this.written.set(key, sig);
    return ops.length;
  }

  /** Mirrors all sessions every `intervalMs`; also call `flush` on shutdown. */
  start(all: () => InterviewSession[], intervalMs = 1000): void {
    this.timer = setInterval(() => void this.flush(all()), intervalMs);
    this.timer.unref();
  }

  async flush(sessions: InterviewSession[]): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      for (const s of sessions) {
        try {
          await this.sync(s);
        } catch (err) {
          console.error(`[db] Could not save interview ${s.id}: ${(err as Error).message.split('\n')[0]}`);
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  async stop(sessions: InterviewSession[]): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    while (this.syncing) await new Promise((r) => setTimeout(r, 20));
    await this.flush(sessions);
  }

  private markWritten(rows: RowSet): void {
    const mark = (table: string, id: string, row: Record<string, unknown>) => this.written.set(`${table}:${id}`, signature(table, row));
    mark('interview', rows.interview.id, rows.interview);
    rows.participants.forEach((r) => mark('participants', r.keyHash, r));
    rows.questions.forEach((r) => mark('questions', r.id, r));
    rows.answers.forEach((r) => mark('answers', r.questionId, r));
    rows.transcript.forEach((r) => mark('transcript', r.id, r));
    rows.evaluations.forEach((r) => mark('evaluations', r.id, r));
    rows.overrides.forEach((r) => mark('overrides', r.id, r));
    rows.notes.forEach((r) => mark('notes', r.id, r));
    rows.chat.forEach((r) => mark('chat', r.id, r));
    rows.reports.forEach((r) => mark('reports', r.id, r));
  }
}
