import WebSocket from 'ws';
import type { TranscriptEntry, Speaker } from '../types';
import { v4 as uuid } from 'uuid';

type TranscriptCallback = (entry: TranscriptEntry) => void;

interface DeepgramConfig {
  apiKey: string;
  model?: string;
  language?: string;
  sampleRate?: number;
  encoding?: string;
  channels?: number;
}

class DeepgramStream {
  private ws: WebSocket | null = null;
  private speaker: Speaker;
  private onTranscript: TranscriptCallback;
  private config: DeepgramConfig;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private audioChunkCount = 0;

  constructor(speaker: Speaker, config: DeepgramConfig, onTranscript: TranscriptCallback) {
    this.speaker = speaker;
    this.config = config;
    this.onTranscript = onTranscript;
  }

  start(): void {
    if (this.ws) this.stop();

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
        console.log(`[deepgram:${this.speaker}] Connected`);
      });

      this.ws.on('message', (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString());

          if (msg.type === 'Results') {
            const alt = msg.channel?.alternatives?.[0];
            if (alt?.transcript && alt.transcript.trim()) {
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
        console.error(`[deepgram:${this.speaker}] Error:`, err.message);
        this.connected = false;
      });

      this.ws.on('close', () => {
        console.log(`[deepgram:${this.speaker}] Disconnected`);
        this.connected = false;
        this.ws = null;
      });
    } catch (err) {
      console.error(`[deepgram:${this.speaker}] Failed to connect:`, err);
      this.connected = false;
    }
  }

  sendAudio(data: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.audioChunkCount++;
      if (this.audioChunkCount === 1 || this.audioChunkCount % 100 === 0) {
        console.log(`[deepgram:${this.speaker}] Audio chunks sent: ${this.audioChunkCount} (${data.length} bytes)`);
      }
      this.ws.send(data);
    } else if (this.audioChunkCount === 0) {
      console.warn(`[deepgram:${this.speaker}] Dropping audio — WS not open (readyState=${this.ws?.readyState})`);
    }
  }

  stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /** False once Deepgram has closed the socket (e.g. after an idle timeout). */
  isAlive(): boolean {
    return this.ws !== null;
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
    this.interviewerStream = new DeepgramStream('interviewer', this.config, this.onTranscript);
    this.interviewerStream.start();
  }

  startCandidateStream(): void {
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

  /** Restarts any stream Deepgram has closed, so audio can keep flowing. */
  ensureStreams(): void {
    if (!this.interviewerStream?.isAlive()) this.startInterviewerStream();
    if (!this.candidateStream?.isAlive()) this.startCandidateStream();
  }

  stop(): void {
    this.stopInterviewerStream();
    this.stopCandidateStream();
  }
}
