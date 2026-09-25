import { randomBytes } from 'crypto';
import { Vad } from './vad';
import { WhisperSTT, pcm16ToWav, SttError } from './whisper';
import type { SpeechToTextProvider, SttProviderConfig, SttStream, SttStreamEvents } from './types';

const MAX_QUEUED = 3;

/**
 * Groq Whisper (batch) behind the streaming interface: the server's VAD cuts
 * utterances from the stream and each one is transcribed. Whisper has no
 * word-level partials; a '…' partial marks "speaking" until the final arrives.
 */
export class WhisperProvider implements SpeechToTextProvider {
  readonly name = 'groq' as const;
  private readonly client: WhisperSTT;

  constructor(cfg: SttProviderConfig) {
    this.client = new WhisperSTT(cfg);
  }

  get model(): string {
    return this.client.model;
  }

  startStream(events: SttStreamEvents): SttStream {
    return new WhisperStream(this.client, events);
  }
}

class WhisperStream implements SttStream {
  private readonly vad = new Vad({ collectAudio: true, maxSegmentMs: 12_000 });
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private stopped = false;
  private ready = false;
  private segmentId = `seg_${randomBytes(8).toString('hex')}`;

  constructor(private readonly client: WhisperSTT, private readonly events: SttStreamEvents) {}

  sendAudio(pcm: Buffer): void {
    if (this.stopped) return;
    if (!this.ready) {
      // Nothing to acknowledge in batch mode: audio is flowing and will be sent per utterance.
      this.ready = true;
      this.events.onReady();
    }
    for (const ev of this.vad.process(pcm)) {
      if (ev.type === 'speech_start') {
        this.events.onTranscript({ segmentId: this.segmentId, text: '…', isFinal: false, confidence: null, avgLogprob: null, noSpeechProb: null, lowConfidence: false });
      } else if (ev.audio) {
        this.enqueue(ev.audio, this.segmentId);
        this.segmentId = `seg_${randomBytes(8).toString('hex')}`;
      }
    }
  }

  private enqueue(audio: Buffer, segmentId: string): void {
    if (this.queued >= MAX_QUEUED) {
      this.events.onError({ code: 'rate_limit', message: 'Whisper queue full; utterance dropped', fatal: false });
      return;
    }
    this.queued++;
    this.chain = this.chain
      .then(async () => {
        // Queued utterances are still transcribed after stopStream (the final words matter).
        try {
          const r = await this.client.transcribe(pcm16ToWav(audio));
          if (r.discard) return;
          this.events.onTranscript({
            segmentId, text: r.text, isFinal: true, confidence: null,
            avgLogprob: r.avgLogprob, noSpeechProb: r.noSpeechProb, lowConfidence: r.lowConfidence,
          });
        } catch (err) {
          const e = err as SttError;
          this.events.onError({ code: e.code ?? 'provider', message: e.message, fatal: e.code === 'auth' });
        }
      })
      .finally(() => { this.queued--; });
  }

  stopStream(): void {
    if (this.stopped) return;
    // Transcribe what was being said when the stream stopped.
    for (const ev of this.vad.flush()) {
      if (ev.type === 'speech_end' && ev.audio) this.enqueue(ev.audio, this.segmentId);
    }
    this.stopped = true;
  }
}
