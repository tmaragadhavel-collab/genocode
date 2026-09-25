import type { AIProvider } from './types';
import { MockAIProvider } from './mock';
import { OpenAIProvider } from './openai';

export type { AIProvider, LLMMessage, ChatOptions } from './types';
export { LLMError } from './types';

export function createAIProvider(apiKey: string | null, model: string): AIProvider {
  if (apiKey) {
    console.log(`[ai] Using OpenAI provider (model: ${model})`);
    return new OpenAIProvider(apiKey, model);
  }
  console.log('[ai] No API key — using mock AI provider (demo mode)');
  return new MockAIProvider();
}
