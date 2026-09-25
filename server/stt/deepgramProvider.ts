import { randomBytes } from 'crypto';
import WebSocket from 'ws';
import { redact } from '../llm/errors';
import type { SpeechToTextProvider, SttProviderConfig, SttStream, SttStreamEvents } from './types';
import { BYTES_PER_SECOND, SAMPLE_RATE } from './types';

const newSegmentId = () => `seg_${randomBytes(8).toString('hex')}`;
const MAX_BUFFERED_BYTES = BYTES_PER_SECOND * 3; // audio held while (re)connecting

/**
 * Deepgram live transcription: true streaming with interim (partial) results,
 * finals with confidence, and endpointing. One WebSocket per participant.
 */
export class DeepgramProvider implements SpeechToTextProvider {
  readonly name = 'deepgram' as const;

  constructor(private readonly cfg: SttProviderConfig) {}

  get model(): string {
    return this.cfg.model;
  }

  startStream(events: SttStreamEvents): SttStream {
    return new DeepgramStream(this.cfg, events);
  }
}

class DeepgramStream implements SttStream {
  private ws: WebSocket;
  private open = false;
  private acknowledged = false;
  private stopped = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private segmentId = newSegmentId();
  private keepAlive: ReturnType<typeof setInterval>;

  constructor(cfg: SttProviderConfig, private readonly events: SttStreamEvents) {
    const params = new URLSearchParams({
      model: cfg.model || 'nova-3',
      encoding: 'linear16',
      sample_rate: String(SAMPLE_RATE),
      channels: '1',
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'true',
      endpointing: '300',
      utterance_end_ms: '1000',
      vad_events: 'true',
    });
    this.ws = new WebSocket(`${cfg.baseURL || 'wss://api.deepgram.com'}/v1/listen?${params}`, {
      headers: { Authorization: `Token ${cfg.apiKey}` },
      handshakeTimeout: 10_000,
    });

    this.ws.on('open', () => {
      this.open = true;
      for (const chunk of this.pending) this.ws.send(chunk);
      this.pending = [];
      this.pendingBytes = 0;
    });

    this.ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      this.stopped = true;
      this.events.onError({
        code: status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limit' : 'provider',
        message: `Deepgram HTTP ${status}`,
        fatal: status === 401 || status === 403 || status === 400,
      });
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      let msg: { type?: string; is_final?: boolean; channel?: { alternatives?: { transcript?: string; confidence?: number }[] } };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== 'Results') return;
      // Any Results message means Deepgram is processing our audio.
      if (!this.acknowledged) {
        this.acknowledged = true;
        this.events.onReady();
      }
      const alt = msg.channel?.alternatives?.[0];
      const text = alt?.transcript?.trim() ?? '';
      if (!text) return;
      const confidence = typeof alt?.confidence === 'number' ? alt.confidence : null;
      this.events.onTranscript({
        segmentId: this.segmentId,
        text,
        isFinal: msg.is_final === true,
        confidence,
        avgLogprob: null,
        noSpeechProb: null,
        lowConfidence: confidence !== null && confidence < 0.6,
      });
      if (msg.is_final) this.segmentId = newSegmentId();
    });

    this.ws.on('error', (err: Error) => {
      if (this.stopped) return;
      this.events.onError({ code: 'network', message: redact(`Deepgram: ${err.message}`), fatal: false });
    });

    this.ws.on('close', () => {
      clearInterval(this.keepAlive);
      this.open = false;
      if (!this.stopped) this.events.onClosed();
    });

    // Deepgram closes idle sockets after ~10s without audio.
    this.keepAlive = setInterval(() => {
      if (this.open) this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
    }, 4000);
    this.keepAlive.unref();
  }

  sendAudio(pcm: Buffer): void {
    if (this.stopped) return;
    if (this.open) {
      this.ws.send(pcm);
      return;
    }
    if (this.pendingBytes + pcm.length <= MAX_BUFFERED_BYTES) {
      this.pending.push(pcm);
      this.pendingBytes += pcm.length;
    }
  }

  stopStream(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.keepAlive);
    try {
      if (this.open) {
        this.ws.send(JSON.stringify({ type: 'Finalize' }));
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        setTimeout(() => this.ws.close(), 1500).unref();
      } else {
        this.ws.terminate();
      }
    } catch { /* already closed */ }
  }
}
