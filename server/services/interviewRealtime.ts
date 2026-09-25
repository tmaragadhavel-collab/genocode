import {
  SessionManager,
  TransitionError,
  type InterviewSession,
  type InterviewStatus,
  type ParticipantBinding,
  type ParticipantRole,
} from './sessionManager';

export type Outbound = { type: string; sessionId?: string; [key: string]: unknown };

export type MediaStatus = { mic: boolean; camera: boolean; screen: boolean };

/** The per-WebSocket state this module reads and writes. */
export type RealtimeClient = {
  binding: ParticipantBinding | null;
  media: MediaStatus | null;
  send: (msg: Outbound) => void;
};

type SendToSession = (sessionId: string, msg: Outbound) => void;
type ClientsInSession = (sessionId: string) => RealtimeClient[];

export type RealtimeHooks = {
  /** Role-filtered extras merged into session_joined. */
  joinData?: (session: InterviewSession, role: ParticipantRole) => Record<string, unknown>;
  /** Called after every lifecycle transition, including time-up. */
  onStatusChange?: (session: InterviewSession) => void;
};

// Which role may drive which lifecycle action, and the resulting status.
const CONTROLS: Record<string, { roles: ParticipantRole[]; next: InterviewStatus }> = {
  interview_start: { roles: ['interviewer'], next: 'LIVE' },
  interview_pause: { roles: ['interviewer'], next: 'PAUSED' },
  interview_resume: { roles: ['interviewer'], next: 'LIVE' },
  interview_end: { roles: ['interviewer'], next: 'COMPLETED' },
  interview_cancel: { roles: ['interviewer'], next: 'CANCELLED' },
};


export class InterviewRealtime {
  constructor(
    private readonly sessions: SessionManager,
    private readonly sendToSession: SendToSession,
    private readonly clientsInSession: ClientsInSession,
    private readonly hooks: RealtimeHooks = {}
  ) {
    sessions.setTimeUpHandler((session) => {
      console.log(`[interview] ${session.id} reached its duration → COMPLETED`);
      this.hooks.onStatusChange?.(session);
      this.broadcastState(session, 'time_up');
    });
  }

  handleJoin(client: RealtimeClient, msg: Record<string, unknown>): void {
    const { sessionId, participantKey } = msg;
    const binding = typeof sessionId === 'string' && typeof participantKey === 'string'
      ? this.sessions.authenticate(sessionId, participantKey)
      : null;
    const session = binding ? this.sessions.get(binding.sessionId) : undefined;

    if (!binding || !session) {
      console.warn('[interview] Session join rejected');
      client.send({ type: 'error', code: 'invalid_session', message: 'Could not join the interview session. Please rejoin.' });
      // Kept for chat UIs that only listen for chat_error.
      client.send({ type: 'chat_error', message: 'Could not join the interview session. Please rejoin the room.' });
      return;
    }

    if (client.binding) this.leave(client);
    client.binding = binding;
    const presenceChanged = this.sessions.markConnected(binding, 1);
    console.log(`[interview] ${binding.role} joined ${binding.sessionId} (status=${session.status})`);

    client.send({
      type: 'session_joined',
      sessionId: session.id,
      role: binding.role,
      interview: this.sessions.snapshot(session),
      participantStatus: this.participantStatus(session.id),
      pending: session.pending,
      history: this.sessions.getHistory(session.id).map((m) => ({
        id: m.id,
        sender: m.sender,
        message: m.content,
        timestamp: m.timestamp,
      })),
      ...this.hooks.joinData?.(session, binding.role),
    });

    if (presenceChanged) {
      const name = this.sessions.snapshot(session).participants[binding.role].name;
      this.sendToSession(session.id, { type: 'participant_joined', sessionId: session.id, role: binding.role, name });
    }
    // CREATED → WAITING may have happened on join; everyone gets the fresh state.
    this.broadcastState(session);
  }

  handleControl(client: RealtimeClient, type: string): void {
    const rule = CONTROLS[type];
    const binding = client.binding;
    const session = binding ? this.sessions.get(binding.sessionId) : undefined;
    if (!rule || !binding || !session) {
      client.send({ type: 'error', code: 'not_joined', message: 'Join the interview first.' });
      return;
    }
    // Role permissions are enforced here, never only in the UI.
    if (!rule.roles.includes(binding.role)) {
      console.warn(`[interview] ${binding.role} not allowed to ${type} (${session.id})`);
      client.send({ type: 'error', code: 'forbidden', message: 'Only the interviewer can do that.' });
      return;
    }
    // Resume only makes sense from PAUSED; start only from WAITING.
    if ((type === 'interview_resume' && session.status !== 'PAUSED')
      || (type === 'interview_start' && session.status !== 'WAITING')) {
      client.send({ type: 'error', code: 'invalid_transition', message: `Cannot ${type.replace('interview_', '')} while ${session.status}.` });
      return;
    }
    try {
      this.sessions.transition(session, rule.next);
    } catch (err) {
      if (!(err instanceof TransitionError)) throw err;
      client.send({ type: 'error', code: 'invalid_transition', message: err.message });
      return;
    }
    console.log(`[interview] ${session.id}: ${type} → ${session.status}`);
    this.hooks.onStatusChange?.(session);
    this.broadcastState(session, type);
  }

  handleParticipantStatus(client: RealtimeClient, msg: Record<string, unknown>): void {
    if (!client.binding) return;
    const media: MediaStatus = {
      mic: msg.mic === true,
      camera: msg.camera === true,
      screen: msg.screen === true,
    };
    client.media = media;
    this.sendToSession(client.binding.sessionId, {
      type: 'participant_status',
      sessionId: client.binding.sessionId,
      role: client.binding.role,
      ...media,
    });
  }

  /** Call when a socket closes (or re-joins elsewhere). */
  leave(client: RealtimeClient): void {
    const binding = client.binding;
    if (!binding) return;
    client.binding = null;
    const session = this.sessions.get(binding.sessionId);
    const presenceChanged = this.sessions.markConnected(binding, -1);
    if (session && presenceChanged) {
      this.sendToSession(session.id, { type: 'participant_left', sessionId: session.id, role: binding.role });
      this.broadcastState(session);
    }
  }

  broadcastState(session: InterviewSession, reason?: string): void {
    this.sendToSession(session.id, {
      type: 'interview_state',
      sessionId: session.id,
      reason,
      interview: this.sessions.snapshot(session),
    });
  }

  private participantStatus(sessionId: string): Partial<Record<ParticipantRole, MediaStatus>> {
    const status: Partial<Record<ParticipantRole, MediaStatus>> = {};
    for (const c of this.clientsInSession(sessionId)) {
      if (c.binding && c.media) status[c.binding.role] = c.media;
    }
    return status;
  }
}
