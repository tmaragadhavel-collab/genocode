import type { STTProvider } from './types';
import { MockSTTProvider } from './mock';
import { DeepgramSTTProvider } from './deepgram';

export type { STTProvider };

export function createSTTProvider(apiKey: string | null): STTProvider {
  if (apiKey) {
    console.log('[stt] Using Deepgram provider');
    return new DeepgramSTTProvider(apiKey);
  }
  console.log('[stt] No API key — using mock STT provider (demo mode)');
  return new MockSTTProvider();
}
