import { LLMError } from '../llm/errors';
import type { LLMService } from './llmService';
import { SESSION_ID_PATTERN, type ParticipantBinding, type SessionManager } from './sessionManager';

export const MAX_CHAT_MESSAGE_LENGTH = 2000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_MESSAGES = 10;
const GENERIC_LLM_ERROR = 'AI response could not be generated. Please try again.';

/** Chat messages use the flat format { type, sessionId, ...fields }. */
export type ChatOutbound = { type: string; sessionId?: string; [key: string]: unknown };

/** Per-WebSocket state the chat handler needs. */
export type ChatClient = {
  binding: ParticipantBinding | null;
  sentAt: number[]; // timestamps of recent chat messages, for rate limiting
  send: (msg: ChatOutbound) => void;
};

type SendToSession = (sessionId: string, msg: ChatOutbound) => void;

type ValidChatMessage = {
  sessionId: string;
  sender: 'candidate' | 'interviewer';
  message: string;
};

class ChatValidationError extends Error {}

// Strip control characters other than newline and tab.
function sanitize(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

function validate(raw: Record<string, unknown>): ValidChatMessage {
  const { sessionId, sender, message } = raw;

  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new ChatValidationError('Invalid session.');
  }
  if (sender !== 'candidate' && sender !== 'interviewer') {
    throw new ChatValidationError('Invalid sender.');
  }
  if (typeof message !== 'string') {
    throw new ChatValidationError('Message must be text.');
  }
  const clean = sanitize(message);
  if (!clean) {
    throw new ChatValidationError('Message cannot be empty.');
  }
  if (clean.length > MAX_CHAT_MESSAGE_LENGTH) {
    throw new ChatValidationError(`Message is too long (max ${MAX_CHAT_MESSAGE_LENGTH} characters).`);
  }
  return { sessionId, sender, message: clean };
}

export class ChatHandler {
  constructor(
    private readonly sessions: SessionManager,
    private readonly llm: LLMService,
    private readonly sendToSession: SendToSession,
    private readonly logContent: boolean
  ) {}

  async handle(client: ChatClient, raw: Record<string, unknown>): Promise<void> {
    const rawSessionId = typeof raw.sessionId === 'string' ? raw.sessionId.slice(0, 64) : undefined;
    console.log('[CHAT] Message received');

    let msg: ValidChatMessage;
    try {
      msg = validate(raw);
      this.authorize(client, msg);
      this.checkRateLimit(client);
    } catch (err) {
      if (!(err instanceof ChatValidationError)) throw err;
      console.warn(`[CHAT] Rejected: ${err.message}`);
      this.sendError(client, rawSessionId, err.message);
      return;
    }

    const { sessionId, sender, message } = msg;
    console.log(`[CHAT] Session: ${sessionId}`);
    console.log(`[CHAT] Sender: ${sender}`);
    if (this.logContent) console.log(`[CHAT] Text: ${message.slice(0, 120)}`);

    const entry = this.sessions.appendMessage(sessionId, { role: 'user', sender, content: message });
    this.sendToSession(sessionId, {
      type: 'chat_user_message',
      sessionId,
      id: entry.id,
      sender,
      message,
      timestamp: entry.timestamp,
    });

    this.sessions.setPending(sessionId, true);
    this.sendToSession(sessionId, { type: 'chat_pending', sessionId, pending: true });

    const started = Date.now();
    try {
      console.log(`[LLM] Request started (provider=${this.llm.providerName})`);
      const reply = await this.llm.generateInterviewResponse({
        sessionId,
        conversation: this.sessions.getHistory(sessionId),
        role: sender,
        message,
      });
      console.log(`[LLM] Response received (${Date.now() - started}ms, ${reply.length} chars)`);

      // The session may have been evicted while waiting; nothing to deliver then.
      if (!this.sessions.get(sessionId)) return;

      const answer = this.sessions.appendMessage(sessionId, {
        role: 'assistant',
        sender: 'ai_interviewer',
        content: reply,
      });
      this.sendToSession(sessionId, {
        type: 'chat_response',
        sessionId,
        id: answer.id,
        message: reply,
        timestamp: answer.timestamp,
      });
      console.log('[CHAT] Response sent');
    } catch (err) {
      const code = err instanceof LLMError ? err.code : 'unknown';
      console.error(`[LLM] Request failed (${code}, ${Date.now() - started}ms): ${(err as Error).message}`);
      this.sendError(client, sessionId, GENERIC_LLM_ERROR);
    } finally {
      this.sessions.setPending(sessionId, false);
      this.sendToSession(sessionId, { type: 'chat_pending', sessionId, pending: false });
    }
  }

  private authorize(client: ChatClient, msg: ValidChatMessage): void {
    const binding = client.binding;
    if (!binding) {
      throw new ChatValidationError('Join an interview session before sending messages.');
    }
    // The client's claimed session and sender must match what the server bound
    // this connection to at join time.
    if (msg.sessionId !== binding.sessionId || !this.sessions.get(msg.sessionId)) {
      throw new ChatValidationError('Invalid session.');
    }
    if (msg.sender !== binding.role) {
      throw new ChatValidationError('Sender does not match your role in this session.');
    }
    if (this.sessions.get(msg.sessionId)?.pending) {
      throw new ChatValidationError('Please wait for the current response.');
    }
  }

  private checkRateLimit(client: ChatClient): void {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    client.sentAt = client.sentAt.filter((t) => t > cutoff);
    if (client.sentAt.length >= RATE_LIMIT_MAX_MESSAGES) {
      throw new ChatValidationError('Too many messages. Please wait a moment.');
    }
    client.sentAt.push(Date.now());
  }

  private sendError(client: ChatClient, sessionId: string | undefined, message: string): void {
    // `pending` lets the UI keep or release its input lock after a rejection.
    const pending = client.binding ? this.sessions.get(client.binding.sessionId)?.pending ?? false : false;
    client.send({ type: 'chat_error', sessionId, message, pending });
  }
}
