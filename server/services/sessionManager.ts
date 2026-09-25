import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Difficulty, InterviewQuestion, TranscriptSegment } from './evaluationTypes';
import type { InterviewReport, InterviewerReview, PlannedQuestion, ReportStatus } from './reportTypes';

export type ParticipantRole = 'candidate' | 'interviewer';

export type ChatRole = 'user' | 'assistant';

export type ChatEntry = {
  id: string;
  role: ChatRole;
  sender: ParticipantRole | 'ai_interviewer';
  content: string;
  timestamp: number;
};

export type InterviewStatus = 'CREATED' | 'WAITING' | 'LIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

// The spec's transitions, plus PAUSED → COMPLETED/CANCELLED so an interviewer can
// end a paused interview without having to resume it first.
const TRANSITIONS: Record<InterviewStatus, InterviewStatus[]> = {
  CREATED: ['WAITING', 'CANCELLED'],
  WAITING: ['LIVE', 'CANCELLED'],
  LIVE: ['PAUSED', 'COMPLETED', 'CANCELLED'],
  PAUSED: ['LIVE', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export type Participant = {
  role: ParticipantRole;
  name: string;
  createdAt: number;
  connected: number; // open WebSocket connections bound to this participant (runtime only)
};

export type InterviewSettings = {
  autoEndOnSilence: boolean; // end the answer automatically after candidate silence
  silenceSeconds: number;
};

/** Only a hash of each participant key is kept (in memory and in the database). */
export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export type InterviewDetails = {
  ownerId: string | null; // interviewer account; null for legacy desktop-app rooms
  candidateName: string;
  candidateEmail: string | null;
  interviewerName: string;
  position: string;
  durationMinutes: number;
  allowCandidateScreenShare: boolean;
  skills: string[];
  difficulty: Difficulty;
  plannedQuestions: PlannedQuestion[];
};

export type InterviewSession = {
  id: string;
  roomName: string;
  status: InterviewStatus;
  details: InterviewDetails;
  // Secret embedded in the candidate's invite link. Interviewers authenticate by account.
  candidateKey: string;
  participants: Map<string, Participant>; // keyed by hash of the per-connection participantKey
  settings: InterviewSettings;
  messages: ChatEntry[];
  pending: boolean; // a chat LLM request is in flight for this session
  questions: InterviewQuestion[];
  currentQuestionId: string | null;
  transcript: TranscriptSegment[]; // final segments only
  generalNotes: string; // private interviewer notes
  report: InterviewReport | null;
  reportStatus: ReportStatus;
  review: InterviewerReview;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  elapsedMs: number; // LIVE time accumulated before the current LIVE stretch
  liveSince: number | null; // start of the current LIVE stretch
  lastActivity: number;
};

export type ParticipantBinding = {
  sessionId: string;
  participantId: string; // hash of the participantKey
  role: ParticipantRole;
};

/** Public view of an interview, safe to send to either participant. */
export type InterviewSnapshot = {
  sessionId: string;
  status: InterviewStatus;
  position: string;
  durationMs: number;
  remainingMs: number;
  elapsedMs: number;
  serverNow: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  allowCandidateScreenShare: boolean;
  participants: Record<ParticipantRole, { name: string; connected: boolean }>;
};

export class TransitionError extends Error {}

const MAX_STORED_MESSAGES = 200;
const SESSION_IDLE_TTL_MS = 6 * 60 * 60 * 1000;
const UNSTARTED_TTL_MS = 24 * 60 * 60 * 1000;

function secureId(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const SESSION_ID_PATTERN = /^int_[A-Za-z0-9_-]{16,64}$/;

/**
 * In-memory interview sessions. Everything goes through this class so it can be
 * swapped for Redis/database storage without touching the WebSocket or chat code.
 *
 * The server is authoritative for status and timing. Clients hold only the
 * session id plus a role-specific join key (from the invite link) or a
 * per-connection participantKey; roles are always derived server-side.
 */
export class SessionManager {
  private sessions = new Map<string, InterviewSession>();
  private roomIndex = new Map<string, string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private onTimeUp: ((session: InterviewSession) => void) | null = null;

  constructor(private readonly defaultSilenceSeconds = 5) {
    setInterval(() => this.evictIdle(), 10 * 60 * 1000).unref();
  }

  /**
   * Restores interviews loaded from the database. A LIVE interview keeps
   * running: its remaining time is derived from the stored elapsed time and the
   * start of the current LIVE stretch, and the time-up timer is rescheduled.
   */
  restore(loaded: InterviewSession[]): void {
    for (const session of loaded) {
      for (const p of session.participants.values()) p.connected = 0;
      session.pending = false;
      for (const q of session.questions) {
        if (q.status === 'evaluating') {
          q.status = 'error';
          q.evaluationError = 'AI evaluation temporarily unavailable.';
        }
      }
      if (session.reportStatus === 'generating') session.reportStatus = 'failed';
      this.sessions.set(session.id, session);
      this.roomIndex.set(session.roomName, session.id);
      this.scheduleTimeUp(session);
    }
  }

  /** Owned interviews, for persistence. Legacy desktop-app rooms are ephemeral. */
  persistable(): InterviewSession[] {
    return [...this.sessions.values()].filter((s) => s.details.ownerId);
  }

  listByOwner(ownerId: string): InterviewSession[] {
    return [...this.sessions.values()]
      .filter((s) => s.details.ownerId === ownerId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Called when a LIVE interview reaches its duration and is auto-completed. */
  setTimeUpHandler(handler: (session: InterviewSession) => void): void {
    this.onTimeUp = handler;
  }

  createInterview(details: InterviewDetails): InterviewSession {
    const id = `int_${secureId(18)}`;
    return this.insert(id, `interview_${id}`, details);
  }

  /** Legacy room-name flow used by the desktop app's LiveKit token endpoint. */
  getOrCreateForRoom(roomName: string): InterviewSession {
    const existingId = this.roomIndex.get(roomName);
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing) return existing;
    return this.insert(`int_${secureId(18)}`, roomName, {
      ownerId: null,
      candidateName: 'Candidate',
      candidateEmail: null,
      interviewerName: 'Interviewer',
      position: 'Interview',
      durationMinutes: 60,
      allowCandidateScreenShare: true,
      skills: [],
      difficulty: 'medium',
      plannedQuestions: [],
    });
  }

  private insert(id: string, roomName: string, details: InterviewDetails): InterviewSession {
    const session: InterviewSession = {
      id,
      roomName,
      status: 'CREATED',
      details,
      candidateKey: secureId(24),
      settings: { autoEndOnSilence: false, silenceSeconds: this.defaultSilenceSeconds },
      participants: new Map(),
      messages: [],
      pending: false,
      questions: [],
      currentQuestionId: null,
      transcript: [],
      generalNotes: '',
      report: null,
      reportStatus: 'none',
      review: { decision: 'undecided', finalScore: null, notes: '', comments: '', updatedAt: null, updatedBy: null },
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      elapsedMs: 0,
      liveSince: null,
      lastActivity: Date.now(),
    };
    this.sessions.set(id, session);
    this.roomIndex.set(roomName, id);
    return session;
  }

  get(sessionId: string): InterviewSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Checks the candidate invite-link key (constant-time). */
  checkCandidateKey(session: InterviewSession, key: string): boolean {
    return safeEqual(session.candidateKey, key);
  }

  isEnded(session: InterviewSession): boolean {
    return session.status === 'COMPLETED' || session.status === 'CANCELLED';
  }

  addParticipant(sessionId: string, role: ParticipantRole, name: string): string {
    const session = this.require(sessionId);
    const participantKey = secureId(24);
    session.participants.set(hashKey(participantKey), { role, name, createdAt: Date.now(), connected: 0 });
    return participantKey;
  }

  /** Validates a WebSocket join; returns null if the session or key is unknown. */
  authenticate(sessionId: string, participantKey: string): ParticipantBinding | null {
    const session = this.sessions.get(sessionId);
    const participantId = hashKey(participantKey);
    const participant = session?.participants.get(participantId);
    if (!session || !participant) return null;
    return { sessionId, participantId, role: participant.role };
  }

  /** Returns true when this changed whether the role has any live connection. */
  markConnected(binding: ParticipantBinding, delta: 1 | -1): boolean {
    const session = this.sessions.get(binding.sessionId);
    const participant = session?.participants.get(binding.participantId);
    if (!session || !participant) return false;
    const before = this.roleConnected(session, binding.role);
    participant.connected = Math.max(0, participant.connected + delta);
    session.lastActivity = Date.now();
    if (delta === 1 && session.status === 'CREATED') this.transition(session, 'WAITING');
    return before !== this.roleConnected(session, binding.role);
  }

  roleConnected(session: InterviewSession, role: ParticipantRole): boolean {
    for (const p of session.participants.values()) {
      if (p.role === role && p.connected > 0) return true;
    }
    return false;
  }

  // --- Interview lifecycle (server-authoritative) ---

  transition(session: InterviewSession, next: InterviewStatus): void {
    if (!TRANSITIONS[session.status].includes(next)) {
      throw new TransitionError(`Cannot go from ${session.status} to ${next}.`);
    }
    const now = Date.now();
    if (session.liveSince !== null) {
      session.elapsedMs += now - session.liveSince;
      session.liveSince = null;
    }
    if (next === 'LIVE') {
      session.startedAt ??= now;
      session.liveSince = now;
    }
    if (next === 'COMPLETED' || next === 'CANCELLED') session.endedAt = now;
    session.status = next;
    session.lastActivity = now;
    this.scheduleTimeUp(session);
  }

  durationMs(session: InterviewSession): number {
    return session.details.durationMinutes * 60_000;
  }

  elapsedMs(session: InterviewSession, now = Date.now()): number {
    return session.elapsedMs + (session.liveSince !== null ? now - session.liveSince : 0);
  }

  snapshot(session: InterviewSession): InterviewSnapshot {
    const now = Date.now();
    const elapsed = this.elapsedMs(session, now);
    const durationMs = this.durationMs(session);
    return {
      sessionId: session.id,
      status: session.status,
      position: session.details.position,
      durationMs,
      elapsedMs: elapsed,
      remainingMs: Math.max(0, durationMs - elapsed),
      serverNow: now,
      createdAt: session.createdAt,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      allowCandidateScreenShare: session.details.allowCandidateScreenShare,
      participants: {
        interviewer: { name: session.details.interviewerName, connected: this.roleConnected(session, 'interviewer') },
        candidate: { name: session.details.candidateName, connected: this.roleConnected(session, 'candidate') },
      },
    };
  }

  private scheduleTimeUp(session: InterviewSession): void {
    clearTimeout(this.timers.get(session.id));
    this.timers.delete(session.id);
    if (session.status !== 'LIVE') return;
    const remaining = Math.max(0, this.durationMs(session) - this.elapsedMs(session));
    const timer = setTimeout(() => {
      this.timers.delete(session.id);
      if (session.status !== 'LIVE') return;
      this.transition(session, 'COMPLETED');
      this.onTimeUp?.(session);
    }, remaining);
    timer.unref();
    this.timers.set(session.id, timer);
  }

  // --- Chat history ---

  appendMessage(sessionId: string, entry: Omit<ChatEntry, 'id' | 'timestamp'>): ChatEntry {
    const session = this.require(sessionId);
    const stored: ChatEntry = { ...entry, id: secureId(12), timestamp: Date.now() };
    session.messages.push(stored);
    if (session.messages.length > MAX_STORED_MESSAGES) {
      session.messages = session.messages.slice(-MAX_STORED_MESSAGES);
    }
    session.lastActivity = Date.now();
    return stored;
  }

  getHistory(sessionId: string): ChatEntry[] {
    return [...(this.sessions.get(sessionId)?.messages ?? [])];
  }

  setPending(sessionId: string, pending: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) session.pending = pending;
  }

  private require(sessionId: string): InterviewSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    return session;
  }

  private evictIdle(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const anyoneConnected = [...session.participants.values()].some((p) => p.connected > 0);
      if (anyoneConnected) continue;
      const idle = session.lastActivity < now - SESSION_IDLE_TTL_MS;
      const neverStarted = session.startedAt === null && session.createdAt < now - UNSTARTED_TTL_MS;
      if ((idle && session.status !== 'LIVE') || neverStarted) {
        clearTimeout(this.timers.get(id));
        this.timers.delete(id);
        this.sessions.delete(id);
        this.roomIndex.delete(session.roomName);
      }
    }
  }
}
