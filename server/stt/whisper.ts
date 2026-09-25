import OpenAI, { toFile } from 'openai';
import type { SttConfig } from '../types';
import { redact } from '../llm/errors';

export const SAMPLE_RATE = 16000;

export type SttResult = {
  text: string;
  avgLogprob: number | null;
  noSpeechProb: number | null;
  lowConfidence: boolean;
  /** Whisper's likely hallucination on silence/noise: not worth showing. */
  discard: boolean;
};

export class SttError extends Error {
  constructor(readonly code: 'timeout' | 'rate_limit' | 'auth' | 'network' | 'provider' | 'invalid_audio', message: string) {
    super(redact(message));
  }
}

// Heuristic thresholds on Whisper's per-segment signals.
const LOW_CONFIDENCE_LOGPROB = -0.8;
const LOW_CONFIDENCE_NO_SPEECH = 0.4;
// Phrases Whisper tends to invent on near-silent audio.
const SILENCE_HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+)$/i;

/** Wraps raw 16 kHz mono PCM16 in a WAV container. */
export function pcm16ToWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

type VerboseSegment = { avg_logprob?: number; no_speech_prob?: number; start?: number; end?: number };

/**
 * Speech-to-text on Groq Whisper (OpenAI-compatible transcription endpoint).
 * Takes complete speech segments cut by the browser's voice-activity detection.
 */
export class WhisperSTT {
  private readonly client: OpenAI;

  constructor(private readonly cfg: SttConfig, private readonly timeoutMs = 20_000) {
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 0 });
  }

  get model(): string {
    return this.cfg.model;
  }

  async transcribe(audio: Buffer, filename = 'segment.wav'): Promise<SttResult> {
    let lastError: SttError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.client.audio.transcriptions.create({
          file: await toFile(audio, filename, { type: 'audio/wav' }),
          model: this.cfg.model,
          response_format: 'verbose_json',
          temperature: 0,
          ...(process.env.STT_LANGUAGE ? { language: process.env.STT_LANGUAGE } : {}),
        }, { timeout: this.timeoutMs });
        return this.toResult(res as unknown as { text?: string; segments?: VerboseSegment[] });
      } catch (err) {
        lastError = this.toError(err);
        // One retry for transient failures only.
        if (!['timeout', 'rate_limit', 'network', 'provider'].includes(lastError.code)) break;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    throw lastError!;
  }

  private toResult(res: { text?: string; segments?: VerboseSegment[] }): SttResult {
    const text = (res.text ?? '').trim();
    const segs = res.segments ?? [];
    let avgLogprob: number | null = null;
    let noSpeechProb: number | null = null;
    if (segs.length) {
      // Duration-weighted averages across Whisper's internal segments.
      const weight = (s: VerboseSegment) => Math.max(0.01, (s.end ?? 0) - (s.start ?? 0));
      const total = segs.reduce((a, s) => a + weight(s), 0);
      avgLogprob = segs.reduce((a, s) => a + (s.avg_logprob ?? 0) * weight(s), 0) / total;
      noSpeechProb = segs.reduce((a, s) => a + (s.no_speech_prob ?? 0) * weight(s), 0) / total;
    }
    const lowConfidence = (avgLogprob !== null && avgLogprob < LOW_CONFIDENCE_LOGPROB)
      || (noSpeechProb !== null && noSpeechProb > LOW_CONFIDENCE_NO_SPEECH);
    const discard = !text
      || (noSpeechProb !== null && noSpeechProb > 0.6 && (avgLogprob ?? 0) < -0.7)
      || (SILENCE_HALLUCINATIONS.test(text) && (noSpeechProb ?? 0) > 0.3);
    return {
      text,
      avgLogprob: avgLogprob === null ? null : Math.round(avgLogprob * 1000) / 1000,
      noSpeechProb: noSpeechProb === null ? null : Math.round(noSpeechProb * 1000) / 1000,
      lowConfidence,
      discard,
    };
  }

  private toError(err: unknown): SttError {
    if (err instanceof OpenAI.APIConnectionTimeoutError) return new SttError('timeout', `STT timed out after ${this.timeoutMs}ms`);
    if (err instanceof OpenAI.APIConnectionError) return new SttError('network', `STT network error: ${err.message}`);
    if (err instanceof OpenAI.APIError) {
      const status = err.status ?? 0;
      const detail = `STT HTTP ${status}: ${(err.message || '').slice(0, 200)}`;
      if (status === 401 || status === 403) return new SttError('auth', detail);
      if (status === 429) return new SttError('rate_limit', detail);
      if (status >= 500) return new SttError('provider', detail);
      return new SttError('invalid_audio', detail);
    }
    return new SttError('provider', (err as Error)?.message ?? String(err));
  }
}
