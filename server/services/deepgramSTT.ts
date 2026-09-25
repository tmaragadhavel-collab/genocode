import WebSocket from 'ws';
import type { TranscriptEntry, Speaker } from '../types';
import { v4 as uuid } from 'uuid';
import { audioDiagnostics } from '../diagnostics';

type TranscriptCallback = (entry: TranscriptEntry) => void;

interface DeepgramConfig {
  apiKey: string;
  model?: string;
  language?: string;
  sampleRate?: number;
  encoding?: string;
  channels?: number;
}

/** Deepgram closes a socket that has been idle for ~10 s. */
const KEEPALIVE_MS = 4000;
/** Audio held while the socket is connecting or reconnecting (~3 s at 16 kHz mono). */
const MAX_BUFFERED_BYTES = 32000 * 3;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 8000;
/** How long a socket must stay open before the backoff is considered recovered. */
const STABLE_MS = 5000;

class DeepgramStream {
  private ws: WebSocket | null = null;
  private speaker: Speaker;
  private onTranscript: TranscriptCallback;
  private config: DeepgramConfig;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private audioChunkCount = 0;
  private dropWarned = false;
  /** Set by stop(): an intentional stop must never reconnect. */
  private stopped = false;
  /** Set on an unrecoverable error (bad key, bad request): stop retrying. */
  private fatal = false;
  private attempts = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(speaker: Speaker, config: DeepgramConfig, onTranscript: TranscriptCallback) {
    this.speaker = speaker;
    this.config = config;
    this.onTranscript = onTranscript;
  }

  start(): void {
    this.stopped = false;
    this.fatal = false;
    this.attempts = 0;
    this.connect();
  }

  /**
   * Opens exactly one socket. Every caller funnels through here, and the guard
   * below is the single reason at most one socket per stream can exist.
   */
  private connect(): void {
    if (this.stopped || this.fatal) return;
    if (this.ws) return; // a socket is already connecting or open
    this.clearReconnect();
    this.dropWarned = false;

    const params = new URLSearchParams({
      encoding: this.config.encoding || 'linear16',
      sample_rate: String(this.config.sampleRate || 16000),
      channels: String(this.config.channels || 1),
      model: this.config.model || 'nova-2',
      language: this.config.language || 'en',
      punctuate: 'true',
      interim_results: 'true',
      utterance_end_ms: '1500',
      vad_events: 'true',
      endpointing: '300',
    });

    const url = `wss://api.deepgram.com/v1/listen?${params}`;

    try {
      this.ws = new WebSocket(url, {
        headers: { Authorization: `Token ${this.config.apiKey}` },
      });

      this.ws.on('open', () => {
        this.connected = true;
        audioDiagnostics.deepgramOpen(this.speaker);
        console.log(`[deepgram:${this.speaker}] Connected${this.attempts ? ` (reconnect attempt ${this.attempts})` : ''}`);
        this.startKeepAlive();

        // Flush whatever arrived while the socket was down.
        for (const chunk of this.pending) this.sendNow(chunk);
        this.pending = [];
        this.pendingBytes = 0;

        // Only a connection that survives a while counts as recovered.
        this.stableTimer = setTimeout(() => { this.attempts = 0; }, STABLE_MS);
        this.stableTimer.unref?.();
      });

      // A 401/403/400 handshake rejection will never succeed on retry.
      this.ws.on('unexpected-response', (_req, res) => {
        const status = res.statusCode ?? 0;
        audioDiagnostics.deepgramError(this.speaker);
        if (status === 401 || status === 403 || status === 400) {
          this.fatal = true;
          console.error(`[deepgram:${this.speaker}] Fatal: Deepgram rejected the connection (HTTP ${status}) — not retrying`);
        } else {
          console.warn(`[deepgram:${this.speaker}] Connection rejected (HTTP ${status})`);
        }
      });

      this.ws.on('message', (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString());

          if (msg.type === 'Results') {
            const alt = msg.channel?.alternatives?.[0];
            if (alt?.transcript && alt.transcript.trim()) {
              audioDiagnostics.transcript(this.speaker, msg.is_final === true);
              const entry: TranscriptEntry = {
                id: uuid(),
                speaker: this.speaker,
                text: alt.transcript,
                timestamp: Date.now(),
                isFinal: msg.is_final === true,
                confidence: alt.confidence,
              };
              this.onTranscript(entry);
            }
          }

          if (msg.type === 'UtteranceEnd') {
            const entry: TranscriptEntry = {
              id: uuid(),
              speaker: this.speaker,
              text: '',
              timestamp: Date.now(),
              isFinal: true,
              confidence: 1,
            };
            entry.id = `utterance-end-${entry.id}`;
            this.onTranscript(entry);
          }
        } catch {
          // ignore parse errors
        }
      });

      this.ws.on('error', (err: Error) => {
        audioDiagnostics.deepgramError(this.speaker);
        // err.message can echo the request URL; the key travels in a header, not the URL.
        console.error(`[deepgram:${this.speaker}] Socket error: ${err.message}`);
        this.connected = false;
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        audioDiagnostics.deepgramClose(this.speaker);
        this.connected = false;
        this.ws = null;
        this.clearKeepAlive();
        if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }

        const why = reason?.toString().slice(0, 120) || 'no reason given';
        if (this.stopped) {
          console.log(`[deepgram:${this.speaker}] Closed after an intentional stop (code ${code})`);
          return;
        }
        console.warn(`[deepgram:${this.speaker}] Closed unexpectedly (code ${code}, ${why})`);
        this.scheduleReconnect();
      });
    } catch (err) {
      this.ws = null;
      this.connected = false;
      console.error(`[deepgram:${this.speaker}] Failed to open a socket:`, (err as Error).message);
      this.scheduleReconnect();
    }
  }

  private startKeepAlive(): void {
    this.clearKeepAlive(); // never two timers for one stream
    this.keepAliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, KEEPALIVE_MS);
    this.keepAliveTimer.unref?.();
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** At most one pending reconnect per stream; exponential backoff, capped. */
  private scheduleReconnect(): void {
    if (this.stopped || this.fatal) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempts, RECONNECT_MAX_MS);
    this.attempts++;
    console.log(`[deepgram:${this.speaker}] Reconnecting in ${delay}ms (attempt ${this.attempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private sendNow(data: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.audioChunkCount++;
    audioDiagnostics.sentToDeepgram(this.speaker, data.length);
    if (this.audioChunkCount === 1 || this.audioChunkCount % 100 === 0) {
      console.log(`[deepgram:${this.speaker}] Audio chunks sent: ${this.audioChunkCount} (${data.length} bytes)`);
    }
    this.ws.send(data);
  }

  sendAudio(data: Buffer): void {
    if (this.stopped || this.fatal) return;

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendNow(data);
      return;
    }

    // Socket is down or still connecting: hold a short tail so the first words
    // after a reconnect are not lost, and make sure a reconnect is on its way.
    // This never opens a socket directly — scheduleReconnect() is the only path.
    if (this.pendingBytes + data.length <= MAX_BUFFERED_BYTES) {
      this.pending.push(data);
      this.pendingBytes += data.length;
    } else {
      audioDiagnostics.droppedByDeepgram(this.speaker);
      if (!this.dropWarned) {
        this.dropWarned = true;
        console.warn(`[deepgram:${this.speaker}] Buffer full while reconnecting — dropping audio until the socket is back`);
      }
    }

    if (!this.ws) this.scheduleReconnect();
  }

  /** Intentional shutdown: releases every timer and blocks all future reconnects. */
  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.clearKeepAlive();
    if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
    this.pending = [];
    this.pendingBytes = 0;
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'CloseStream' }));
          this.ws.close();
        } else {
          this.ws.terminate();
        }
      } catch { /* already closing */ }
      this.ws = null;
    }
    this.connected = false;
  }

  /**
   * Diagnostics only: drops the socket the way a network failure would, without
   * setting `stopped`, so the reconnect path can be exercised deliberately.
   */
  forceDisconnect(): void {
    this.ws?.terminate();
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * True while this stream is still responsible for transcription — open,
   * connecting, or waiting to reconnect. False only after an intentional stop
   * or an unrecoverable error, which is when ensureStreams() replaces it.
   */
  isAlive(): boolean {
    return !this.stopped && !this.fatal;
  }
}

export class DeepgramStreamingService {
  private interviewerStream: DeepgramStream | null = null;
  private candidateStream: DeepgramStream | null = null;
  private config: DeepgramConfig;
  private onTranscript: TranscriptCallback;

  constructor(config: DeepgramConfig, onTranscript: TranscriptCallback) {
    this.config = config;
    this.onTranscript = onTranscript;
  }

  startInterviewerStream(): void {
    this.interviewerStream?.stop(); // never leave an orphaned socket behind
    this.interviewerStream = new DeepgramStream('interviewer', this.config, this.onTranscript);
    this.interviewerStream.start();
  }

  startCandidateStream(): void {
    this.candidateStream?.stop();
    this.candidateStream = new DeepgramStream('candidate', this.config, this.onTranscript);
    this.candidateStream.start();
  }

  sendInterviewerAudio(chunk: Buffer): void {
    this.interviewerStream?.sendAudio(chunk);
  }

  sendCandidateAudio(chunk: Buffer): void {
    this.candidateStream?.sendAudio(chunk);
  }

  stopInterviewerStream(): void {
    this.interviewerStream?.stop();
    this.interviewerStream = null;
  }

  stopCandidateStream(): void {
    this.candidateStream?.stop();
    this.candidateStream = null;
  }

  isInterviewerConnected(): boolean {
    return this.interviewerStream?.isConnected() ?? false;
  }

  isCandidateConnected(): boolean {
    return this.candidateStream?.isConnected() ?? false;
  }

  /**
   * Central lifecycle guard, safe to call as often as you like (it is a no-op
   * while both streams are healthy, including while one is mid-reconnect).
   * Each speaker is considered independently: a dead interviewer stream never
   * restarts a healthy candidate stream.
   */
  ensureStreams(): void {
    if (!this.interviewerStream?.isAlive()) this.startInterviewerStream();
    if (!this.candidateStream?.isAlive()) this.startCandidateStream();
  }

  /** Diagnostics only — simulates a network drop so recovery can be verified. */
  forceDisconnect(speaker: 'interviewer' | 'candidate'): boolean {
    const stream = speaker === 'interviewer' ? this.interviewerStream : this.candidateStream;
    if (!stream) return false;
    stream.forceDisconnect();
    return true;
  }

  stop(): void {
    this.stopInterviewerStream();
    this.stopCandidateStream();
  }
}
