import type { AssistantSection, ContextWindow, StreamChunk } from '../types';
import type { LLMClient } from './llmClient';
import { demoAssistantStream } from './demo';

// Live guidance for the candidate desktop app's private assistant window.

const SYSTEM_PROMPT = `You are an AI interview assistant helping a candidate during a live technical interview.
Analyze the interviewer's question and give concise guidance the candidate can glance at.
Keep it SHORT and practical. Format your response in exactly these sections:

### ANSWER
A 2-3 sentence answer direction. Explain the approach, not a word-for-word script.

### KEY_POINTS
- Point 1
- Point 2
- Point 3
- Point 4

### CONTEXT
One sentence about what the interviewer is evaluating.

### FOLLOW_UP
One likely follow-up question the interviewer might ask.`;

const SECTIONS: AssistantSection[] = ['ANSWER', 'KEY_POINTS', 'CONTEXT', 'FOLLOW_UP'];
const MARKER = /###\s*(ANSWER|KEY_POINTS|CONTEXT|FOLLOW_UP)[^\S\n]*\n?/;

/**
 * Splits streamed text into section chunks. Markers can arrive split across
 * deltas, so a possible partial marker at the end of the buffer is held back.
 */
export class SectionParser {
  private buffer = '';
  private section: AssistantSection | null = null;

  constructor(private readonly emit: (chunk: StreamChunk) => void) {}

  push(delta: string): void {
    this.buffer += delta;
    for (;;) {
      const m = MARKER.exec(this.buffer);
      if (!m) break;
      this.flushText(this.buffer.slice(0, m.index));
      if (this.section) this.emit({ type: 'section_end', section: this.section });
      this.section = m[1] as AssistantSection;
      this.emit({ type: 'section_start', section: this.section });
      this.buffer = this.buffer.slice(m.index + m[0].length);
    }
    const hash = this.buffer.lastIndexOf('#');
    const holdFrom = hash >= 0 && this.buffer.length - hash < 16 ? hash : this.buffer.length;
    this.flushText(this.buffer.slice(0, holdFrom));
    this.buffer = this.buffer.slice(holdFrom);
  }

  end(): void {
    this.flushText(this.buffer);
    this.buffer = '';
    if (this.section) this.emit({ type: 'section_end', section: this.section });
    this.emit({ type: 'done' });
  }

  private flushText(text: string): void {
    if (text && this.section && SECTIONS.includes(this.section)) {
      this.emit({ type: 'content', section: this.section, content: text });
    }
  }
}

export async function generateAssistantStream(llm: LLMClient, context: ContextWindow, onChunk: (chunk: StreamChunk) => void): Promise<void> {
  if (llm.demoMode) return demoAssistantStream(context, onChunk);

  const conversation = context.transcript
    .slice(-8)
    .map((t) => `${t.speaker === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${t.text}`)
    .join('\n');
  const user = context.currentQuestion
    ? `Current question: "${context.currentQuestion.question}"\n\nRecent conversation:\n${conversation}\n\nTopic area: ${context.topic}\n\nProvide interview guidance for this question.`
    : `Conversation so far:\n${conversation}\n\nProvide guidance based on the conversation context.`;

  const parser = new SectionParser(onChunk);
  await llm.stream([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }], (d) => parser.push(d), {
    purpose: 'assistant',
    maxTokens: 700,
  });
  parser.end();
}
