import type { ContextWindow, StreamChunk } from '../types';

// Labelled demo content used only when no LLM provider is configured.

const INSIGHTS: Record<string, { answer: string; keyPoints: string[]; context: string; followUp: string }> = {
  database: {
    answer: 'Explain the architectural tradeoff: PostgreSQL for ACID transactions and relational consistency, MongoDB for flexible schemas and horizontal scaling. Focus on why your use case needed one over the other.',
    keyPoints: ['ACID transactions and data consistency', 'Relational data model with joins', 'Schema constraints prevent data corruption', 'Mature query optimizer for complex queries'],
    context: 'The interviewer is evaluating your ability to reason about database architecture tradeoffs.',
    followUp: 'How would you handle a scenario where you need both relational and document-based storage?',
  },
  system_design: {
    answer: 'Start with requirements clarification, then outline the high-level architecture before diving into component details. Show you can think about scale, reliability, and tradeoffs.',
    keyPoints: ['Clarify functional and non-functional requirements first', 'Start with a high-level diagram and major components', 'Discuss data flow and storage decisions', 'Address scalability, reliability, and monitoring'],
    context: 'The interviewer wants to see structured thinking about large-scale system design.',
    followUp: 'What monitoring and alerting would you set up for this system?',
  },
  default: {
    answer: 'Structure your answer: define the concept, explain how it works, then give a concrete example from your experience.',
    keyPoints: ['Start with a clear definition', 'Explain the underlying mechanism', 'Give a concrete example', 'Mention trade-offs or limitations'],
    context: 'The interviewer is checking both understanding and communication.',
    followUp: 'Can you give an example of when you applied this in a project?',
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function demoChatReply(lastUserMessage: string): Promise<string> {
  await sleep(600);
  const last = lastUserMessage.toLowerCase();
  if (last.includes('python')) {
    return '(Demo mode) Sure. In Python, what is the difference between a list and a tuple, and when would you pick one over the other?';
  }
  if (last.includes('rest')) {
    return '(Demo mode) Good topic. How would you design the endpoints for a REST API that manages user accounts?';
  }
  return '(Demo mode) Thanks. To start, could you walk me through a recent technical project you are proud of?';
}

export async function demoAssistantStream(context: ContextWindow, onChunk: (chunk: StreamChunk) => void): Promise<void> {
  const text = [context.currentQuestion?.question || '', context.topic, ...context.transcript.slice(-5).map((t) => t.text)].join(' ').toLowerCase();
  const key = /database|sql|postgres|mongo/.test(text) ? 'database' : /design|scalab|architect/.test(text) ? 'system_design' : 'default';
  const data = INSIGHTS[key];

  onChunk({ type: 'section_start', section: 'ANSWER' });
  for (const word of data.answer.split(' ')) {
    onChunk({ type: 'content', section: 'ANSWER', content: `${word} ` });
    await sleep(40);
  }
  onChunk({ type: 'section_end', section: 'ANSWER' });
  onChunk({ type: 'section_start', section: 'KEY_POINTS' });
  for (const point of data.keyPoints) onChunk({ type: 'content', section: 'KEY_POINTS', content: `• ${point}\n` });
  onChunk({ type: 'section_end', section: 'KEY_POINTS' });
  onChunk({ type: 'section_start', section: 'CONTEXT' });
  onChunk({ type: 'content', section: 'CONTEXT', content: data.context });
  onChunk({ type: 'section_end', section: 'CONTEXT' });
  onChunk({ type: 'section_start', section: 'FOLLOW_UP' });
  onChunk({ type: 'content', section: 'FOLLOW_UP', content: data.followUp });
  onChunk({ type: 'section_end', section: 'FOLLOW_UP' });
  onChunk({ type: 'done' });
}
