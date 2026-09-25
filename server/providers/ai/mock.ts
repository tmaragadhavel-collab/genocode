import type { AIProvider, ChatOptions, LLMMessage } from './types';
import type { StreamChunk, ContextWindow } from '../../types';

const MOCK_INSIGHTS: Record<string, {
  answer: string;
  keyPoints: string[];
  context: string;
  followUp: string;
}> = {
  database: {
    answer: 'Explain the architectural tradeoff: PostgreSQL for ACID transactions and relational consistency, MongoDB for flexible schemas and horizontal scaling. Focus on why your use case needed one over the other.',
    keyPoints: [
      'ACID transactions and data consistency',
      'Relational data model with joins',
      'Schema constraints prevent data corruption',
      'Mature query optimizer for complex queries',
    ],
    context: 'The interviewer is evaluating your ability to reason about database architecture tradeoffs.',
    followUp: 'How would you handle a scenario where you need both relational and document-based storage?',
  },
  system_design: {
    answer: 'Start with requirements clarification, then outline the high-level architecture before diving into component details. Show you can think about scale, reliability, and tradeoffs.',
    keyPoints: [
      'Clarify functional and non-functional requirements first',
      'Start with a high-level diagram and major components',
      'Discuss data flow and storage decisions',
      'Address scalability, reliability, and monitoring',
    ],
    context: 'The interviewer wants to see structured thinking about large-scale system design.',
    followUp: 'What monitoring and alerting would you set up for this system?',
  },
  default: {
    answer: 'Structure your answer with a clear framework: state the concept, explain the rationale, give a concrete example from your experience, and mention tradeoffs.',
    keyPoints: [
      'Lead with the core concept or principle',
      'Connect to practical experience',
      'Mention relevant tradeoffs',
      'Be concise — the interviewer will ask follow-ups',
    ],
    context: 'Technical interview — demonstrate both knowledge depth and practical reasoning.',
    followUp: 'Can you walk through a specific example from a project you worked on?',
  },
};

function matchTopic(context: ContextWindow): string {
  const text = [
    context.currentQuestion?.question || '',
    context.topic,
    ...context.transcript.slice(-5).map(t => t.text),
  ].join(' ').toLowerCase();

  if (text.includes('database') || text.includes('sql') || text.includes('postgres') || text.includes('mongo'))
    return 'database';
  if (text.includes('design') || text.includes('scalab') || text.includes('architect'))
    return 'system_design';
  return 'default';
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class MockAIProvider implements AIProvider {
  async chat(messages: LLMMessage[], _options: ChatOptions): Promise<string> {
    await sleep(600);
    const last = messages[messages.length - 1]?.content.toLowerCase() ?? '';
    if (last.includes('python')) {
      return '(Demo mode) Sure. In Python, what is the difference between a list and a tuple, and when would you pick one over the other?';
    }
    if (last.includes('rest')) {
      return '(Demo mode) Good topic. How would you design the endpoints for a REST API that manages user accounts?';
    }
    return '(Demo mode) Thanks. To start, could you walk me through a recent technical project you are proud of?';
  }

  readonly name = 'mock-ai';

  async generateStream(
    context: ContextWindow,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<void> {
    const topic = matchTopic(context);
    const data = MOCK_INSIGHTS[topic] || MOCK_INSIGHTS.default;

    await sleep(300);

    onChunk({ type: 'section_start', section: 'ANSWER' });
    for (const word of data.answer.split(' ')) {
      onChunk({ type: 'content', section: 'ANSWER', content: word + ' ' });
      await sleep(30 + Math.random() * 40);
    }
    onChunk({ type: 'section_end', section: 'ANSWER' });

    await sleep(150);

    onChunk({ type: 'section_start', section: 'KEY_POINTS' });
    for (const point of data.keyPoints) {
      onChunk({ type: 'content', section: 'KEY_POINTS', content: `• ${point}\n` });
      await sleep(80 + Math.random() * 60);
    }
    onChunk({ type: 'section_end', section: 'KEY_POINTS' });

    await sleep(150);

    onChunk({ type: 'section_start', section: 'CONTEXT' });
    onChunk({ type: 'content', section: 'CONTEXT', content: data.context });
    onChunk({ type: 'section_end', section: 'CONTEXT' });

    await sleep(150);

    onChunk({ type: 'section_start', section: 'FOLLOW_UP' });
    onChunk({ type: 'content', section: 'FOLLOW_UP', content: data.followUp });
    onChunk({ type: 'section_end', section: 'FOLLOW_UP' });

    await sleep(100);
    onChunk({ type: 'done' });
  }
}
