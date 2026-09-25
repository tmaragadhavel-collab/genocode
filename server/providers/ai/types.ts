import type { StreamChunk, ContextWindow } from '../../types';

export type LLMMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ChatOptions = {
  timeoutMs: number;
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a single JSON object response. */
  json?: boolean;
};

export type LLMErrorCode =
  | 'timeout'
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'network'
  | 'provider'
  | 'empty_response';

/** Provider failure with a coarse category. `message` is for server logs only. */
export class LLMError extends Error {
  constructor(readonly code: LLMErrorCode, message: string) {
    super(message);
    this.name = 'LLMError';
  }
}

export interface AIProvider {
  readonly name: string;
  generateStream(
    context: ContextWindow,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<void>;
  /** Single request/response completion. Throws LLMError on failure. */
  chat(messages: LLMMessage[], options: ChatOptions): Promise<string>;
}
