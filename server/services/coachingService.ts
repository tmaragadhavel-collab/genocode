import { createHash } from 'crypto';
import type { LLMClient } from '../llm/llmClient';
import type { InterviewSession } from './sessionManager';

/**
 * Candidate-side interview coaching.
 *
 *   interviewer FINAL transcript ─▶ debounce ─▶ question? ─▶ dedupe ─▶ LLM (streaming)
 *                                                                        │
 *                                                              coaching_delta ─▶ candidate only
 *
 * Deliberate properties:
 *  - Partial transcripts never reach the LLM; only finals do, and only after the
 *    interviewer has stopped talking for DEBOUNCE_MS (a long question often
 *    arrives as several finals).
 *  - One detected question produces exactly one LLM request, keyed by a hash of
 *    the normalised question text.
 *  - A new question cancels the previous run, so a late response can never
 *    overwrite the coaching for the question the candidate is now being asked.
 *  - The candidate's own speech never triggers coaching.
 *  - Coaching is opt-in per interview and both roles are told when it is on;
 *    this is an assistance feature, not a concealed one.
 */

export type CoachingSection = 'HINTS' | 'STRUCTURE' | 'GROUNDING' | 'CAUTION';
export type CoachingState = 'thinking' | 'streaming' | 'complete' | 'error';

export type CoachingRecord = {
  questionId: string;
  question: string;
  detectedAt: number;
  state: CoachingState;
  sections: Record<CoachingSection, string>;
  error: string | null;
};

type Outbound = { type: string; [key: string]: unknown };
type Senders = {
  toRole: (sessionId: string, role: 'interviewer' | 'candidate', msg: Outbound) => void;
  toSession: (sessionId: string, msg: Outbound) => void;
};

type Run = { questionId: string; cancelled: boolean };

type SessionCoaching = {
  history: CoachingRecord[];
  lastQuestionId: string | null;
  active: Run | null;
  /** Interviewer finals waiting for the debounce window to close. */
  buffer: string[];
  timer: ReturnType<typeof setTimeout> | null;
};

const SECTIONS: CoachingSection[] = ['HINTS', 'STRUCTURE', 'GROUNDING', 'CAUTION'];
/** A section heading on its own line: "### HINTS", "**HINTS**" or "HINTS:". */
const MARKER = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(HINTS|STRUCTURE|GROUNDING|CAUTION)\s*(?:\*\*|__)?\s*:?\s*$/i;
/** Strips inline emphasis so the panel renders plain text. */
const clean = (line: string) => line.replace(/\*\*|__|`/g, '').trimEnd();
/** A long question arrives as several finals; wait for the interviewer to stop. */
const DEBOUNCE_MS = 1500;
const MAX_QUESTION_CHARS = 400;
const MAX_HISTORY = 20;
const CONTEXT_TURNS = 6;

const SYSTEM_PROMPT = `You are an interview coach helping a candidate during a live technical interview.
The candidate must read your guidance in a couple of seconds while being watched, so be extremely concise.

Give hints, never a scripted answer. Never write sentences for the candidate to read aloud.

Ground every claim in the CONTEXT you are given. If the context does not say the
candidate has used a technology, built a project, or held a role, do NOT claim they did.
Never invent experience, employers, metrics or project names. When you have no
grounding, say what the candidate should draw on instead (for example "use any
project where you handled retries").

Reply in exactly these four sections, in this order:

### HINTS
- 3 to 5 bullets, max 12 words each. The points the answer must hit.

### STRUCTURE
One line, arrow-separated. Example: Problem → Approach → Your contribution → Result

### GROUNDING
One line naming what from the context to draw on, or "No background on file — speak from your own experience."

### CAUTION
One line: the most likely way this answer goes wrong.`;

const blankSections = (): Record<CoachingSection, string> => ({ HINTS: '', STRUCTURE: '', GROUNDING: '', CAUTION: '' });

/** Used when no LLM provider is configured. Generic on purpose: it invents nothing. */
const demoCoaching = (): string[] => [
  '### HINTS\n',
  '- Name the problem before the solution\n',
  '- Say what you personally did\n',
  '- Give one concrete detail\n',
  '- Finish with the outcome\n',
  '### STRUCTURE\n',
  'Problem → Approach → Your contribution → Result\n',
  '### GROUNDING\n',
  'No background on file — speak from your own experience.\n',
  '### CAUTION\n',
  'Do not describe implementation before the problem is clear.',
];

/** Same question asked twice in a row must not produce a second LLM request. */
const questionIdOf = (text: string): string =>
  `q_${createHash('sha256').update(text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)}`;

export class CoachingService {
  private readonly bySession = new Map<string, SessionCoaching>();

  private readonly debounceMs: number;

  constructor(
    private readonly llm: LLMClient,
    private readonly send: Senders,
    options: { debounceMs?: number } = {}
  ) {
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  }

  get available(): boolean {
    return !this.llm.demoMode;
  }

  /** Coaching is off unless the interviewer switched it on when creating the interview. */
  enabledFor(session: InterviewSession): boolean {
    return session.settings.candidateCoaching === true;
  }

  /** History for session_joined, so a reconnecting candidate keeps its coaching. */
  joinData(session: InterviewSession): Record<string, unknown> {
    const state = this.bySession.get(session.id);
    return {
      coachingEnabled: this.enabledFor(session),
      coachingAvailable: this.available,
      coachingHistory: state ? state.history.slice(-MAX_HISTORY) : [],
    };
  }

  /**
   * A FINAL interviewer transcript. Buffered, then assessed once the interviewer
   * pauses. Candidate speech must never reach this method.
   */
  onInterviewerFinal(session: InterviewSession, text: string, isQuestion: (t: string) => boolean): void {
    if (!this.enabledFor(session) || session.status !== 'LIVE') return;
    const state = this.state(session.id);
    state.buffer.push(text.trim());
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      const combined = state.buffer.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_CHARS);
      state.buffer = [];
      if (combined && isQuestion(combined)) this.startCoaching(session, combined);
    }, this.debounceMs);
    state.timer.unref?.();
  }

  onInterviewEnded(sessionId: string): void {
    const state = this.bySession.get(sessionId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (state.active) state.active.cancelled = true;
    state.active = null;
    state.buffer = [];
  }

  forget(sessionId: string): void {
    this.onInterviewEnded(sessionId);
    this.bySession.delete(sessionId);
  }

  // --- internals ---

  private state(sessionId: string): SessionCoaching {
    let s = this.bySession.get(sessionId);
    if (!s) {
      s = { history: [], lastQuestionId: null, active: null, buffer: [], timer: null };
      this.bySession.set(sessionId, s);
    }
    return s;
  }

  private startCoaching(session: InterviewSession, question: string): void {
    const state = this.state(session.id);
    const questionId = questionIdOf(question);
    if (questionId === state.lastQuestionId) return; // the same question, asked again
    state.lastQuestionId = questionId;

    // A new question invalidates whatever is still streaming for the old one.
    if (state.active) state.active.cancelled = true;
    const run: Run = { questionId, cancelled: false };
    state.active = run;

    const record: CoachingRecord = {
      questionId, question, detectedAt: Date.now(), state: 'thinking', sections: blankSections(), error: null,
    };
    state.history.push(record);
    if (state.history.length > MAX_HISTORY) state.history.shift();

    // The interviewer sees that a question was picked up, never the coaching itself.
    this.send.toRole(session.id, 'candidate', { type: 'coaching_question', sessionId: session.id, questionId, question });
    this.send.toRole(session.id, 'interviewer', { type: 'coaching_activity', sessionId: session.id, questionId, question });
    this.emitState(session.id, record);

    void this.run(session, record, run);
  }

  private async run(session: InterviewSession, record: CoachingRecord, run: Run): Promise<void> {
    const started = Date.now();
    let firstTokenAt: number | null = null;
    let section: CoachingSection | null = null;
    let buffer = '';

    const emit = (text: string) => {
      if (!section || !text) return;
      record.sections[section] += text;
      this.send.toRole(session.id, 'candidate', {
        type: 'coaching_delta', sessionId: session.id, questionId: record.questionId, section, text,
      });
    };

    /**
     * Markers occupy a whole line, so the buffer is split on newlines and the
     * trailing incomplete line is held back. Models drift between "### HINTS",
     * "**HINTS**" and "HINTS:", so all three are accepted — matching only one
     * form means a formatting change silently produces no coaching at all.
     */
    const push = (delta: string) => {
      if (run.cancelled) return;
      if (firstTokenAt === null) {
        firstTokenAt = Date.now();
        record.state = 'streaming';
        this.emitState(session.id, record);
        console.log(`[COACH] ${session.id} first token in ${firstTokenAt - started}ms`);
      }
      buffer += delta;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        takeLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    };

    const takeLine = (line: string) => {
      const m = MARKER.exec(line);
      if (m) {
        section = m[1].toUpperCase() as CoachingSection;
        return;
      }
      emit(`${clean(line)}\n`);
    };

    try {
      if (this.llm.demoMode) {
        // No provider configured: give the same shape deterministically, so the
        // feature degrades to something honest instead of an error.
        console.log(`[COACH] ${session.id} question detected → demo coaching (no LLM configured)`);
        for (const part of demoCoaching()) {
          if (run.cancelled) return;
          push(part);
          await new Promise((r) => setTimeout(r, 15));
        }
        if (buffer.trim()) takeLine(buffer);
        buffer = '';
        record.state = 'complete';
        this.emitState(session.id, record);
        return;
      }
      console.log(`[COACH] ${session.id} question detected → 1 LLM request (${record.questionId})`);
      await this.llm.stream(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: this.buildContext(session, record.question) },
        ],
        push,
        { purpose: 'coaching', maxTokens: 400 }
      );
      if (run.cancelled) return;
      if (buffer.trim()) takeLine(buffer);
      buffer = '';
      record.state = 'complete';
      this.emitState(session.id, record);
      console.log(`[COACH] ${session.id} coaching complete in ${Date.now() - started}ms`);
    } catch (err) {
      if (run.cancelled) return;
      record.state = 'error';
      record.error = 'AI coaching temporarily unavailable';
      // The provider's message may name internals; it is logged, never sent.
      console.warn(`[COACH] ${session.id} coaching failed: ${(err as Error).message}`);
      this.emitState(session.id, record);
    } finally {
      if (SECTIONS.length && !run.cancelled) {
        const s = this.bySession.get(session.id);
        if (s?.active === run) s.active = null;
      }
    }
  }

  private emitState(sessionId: string, record: CoachingRecord): void {
    this.send.toRole(sessionId, 'candidate', {
      type: 'coaching_state', sessionId, questionId: record.questionId, state: record.state, error: record.error,
    });
  }

  /**
   * A bounded context window: the interview's own setup plus the last few turns.
   * The whole transcript is never sent.
   */
  private buildContext(session: InterviewSession, question: string): string {
    const d = session.details;
    const recent = session.transcript
      .slice(-CONTEXT_TURNS)
      .map((t) => `${t.speaker === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${t.text}`)
      .join('\n');

    const background = [
      d.position ? `Role applied for: ${d.position}` : '',
      d.skills?.length ? `Skills this interview covers: ${d.skills.join(', ')}` : '',
      d.difficulty ? `Level: ${d.difficulty}` : '',
    ].filter(Boolean).join('\n');

    return [
      'CONTEXT',
      background || 'No role details on file.',
      '',
      'No resume or job description has been provided for this candidate.',
      'Do not state what the candidate has built or worked with; suggest what kind of example to reach for instead.',
      '',
      recent ? `RECENT CONVERSATION\n${recent}` : 'RECENT CONVERSATION\n(none yet)',
      '',
      `QUESTION THE INTERVIEWER JUST ASKED\n"${question}"`,
      '',
      'Give the four sections now.',
    ].join('\n');
  }
}
