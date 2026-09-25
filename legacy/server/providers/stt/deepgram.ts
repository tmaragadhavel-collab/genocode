import WebSocket from 'ws';
import type { STTProvider } from './types';

export class DeepgramSTTProvider implements STTProvider {
  readonly name = 'deepgram';
  private ws: WebSocket | null = null;
  private onTranscript: ((text: string, isFinal: boolean) => void) | null = null;

  constructor(private apiKey: string) {}

  start(onTranscript: (text: string, isFinal: boolean) => void): void {
    this.onTranscript = onTranscript;

    try {
      const url = 'wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&model=nova-2&punctuate=true&interim_results=true';

      this.ws = new WebSocket(url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          const alt = msg?.channel?.alternatives?.[0];
          if (alt?.transcript) {
            const isFinal = msg.is_final === true;
            this.onTranscript?.(alt.transcript, isFinal);
          }
        } catch {
          // ignore parse errors
        }
      });

      this.ws.on('error', (err: Error) => {
        console.error('[deepgram] WebSocket error:', err.message);
      });

      this.ws.on('close', () => {
        this.ws = null;
      });
    } catch (err) {
      console.error('[deepgram] Failed to connect:', err);
    }
  }

  sendAudio(data: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  stop(): void {
    if (this.ws) {
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        this.ws.close();
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
    this.onTranscript = null;
  }
}
