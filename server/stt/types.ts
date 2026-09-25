// Speech-to-text provider abstraction. One stream per participant microphone.
// Audio format everywhere: 16 kHz, mono, signed 16-bit little-endian PCM.

export const SAMPLE_RATE = 16000;
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;

export type SttProviderName = 'deepgram' | 'groq';

export type SttProviderConfig = {
  provider: SttProviderName;
  apiKey: string;
  model: string;
  baseURL: string;
};

export type SttSettings = {
  primary: SttProviderConfig | null; // null → transcription unavailable
  fallback: SttProviderConfig | null;
};

export type TranscriptEvent = {
  segmentId: string; // partials and the final for one utterance share an id
  text: string;
  isFinal: boolean;
  confidence: number | null; // 0–1 when the provider reports it
  avgLogprob: number | null; // Whisper only
  noSpeechProb: number | null; // Whisper only
  lowConfidence: boolean;
};

export type SttErrorInfo = {
  code: 'auth' | 'network' | 'rate_limit' | 'provider' | 'timeout' | 'invalid_audio';
  message: string; // for logs only (redacted)
  /** Retrying the same provider won't help (e.g. bad key). */
  fatal: boolean;
};

export type SttStreamEvents = {
  /** The provider has accepted and processed audio for this stream. */
  onReady(): void;
  onTranscript(event: TranscriptEvent): void;
  onError(error: SttErrorInfo): void;
  /** The provider closed the stream unexpectedly. */
  onClosed(): void;
};

export interface SttStream {
  sendAudio(pcm: Buffer): void;
  stopStream(): void;
}

export interface SpeechToTextProvider {
  readonly name: SttProviderName;
  readonly model: string;
  startStream(events: SttStreamEvents): SttStream;
}
