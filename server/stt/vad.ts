import { SAMPLE_RATE } from './types';

// Energy-based voice-activity detection on 16 kHz PCM16, run on the server
// for every participant stream. It drives the "candidate seems done"
// suggestion and cuts utterances for batch providers (Whisper).

const FRAME_SAMPLES = SAMPLE_RATE / 50; // 20 ms
const FRAME_BYTES = FRAME_SAMPLES * 2;
const FRAME_MS = 20;

export type VadOptions = {
  startFrames?: number; // consecutive speech frames to start an utterance
  endSilenceMs?: number; // silence that ends an utterance
  maxSegmentMs?: number; // cut long utterances (Whisper latency)
  prerollMs?: number; // audio kept from before speech started
  minSpeechMs?: number; // shorter bursts are ignored (clicks, coughs)
  collectAudio?: boolean; // keep segment audio (needed for batch STT)
};

export type VadEvent =
  | { type: 'speech_start' }
  | { type: 'speech_end'; audio: Buffer | null; speechMs: number; reason: 'silence' | 'max_length' };

export class Vad {
  private readonly o: Required<VadOptions>;
  private rest = Buffer.alloc(0);
  private noise = 0.003; // adaptive background level (normalized RMS)
  private speaking = false;
  private run = 0; // consecutive speech frames while idle
  private silentMs = 0;
  private speechMs = 0;
  private segmentMs = 0;
  private preroll: Buffer[] = [];
  private frames: Buffer[] = [];

  constructor(opts: VadOptions = {}) {
    this.o = {
      startFrames: 4,
      endSilenceMs: 700,
      maxSegmentMs: 12_000,
      prerollMs: 300,
      minSpeechMs: 250,
      collectAudio: false,
      ...opts,
    };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  process(chunk: Buffer): VadEvent[] {
    const events: VadEvent[] = [];
    let buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    let offset = 0;
    for (; offset + FRAME_BYTES <= buf.length; offset += FRAME_BYTES) {
      const frame = buf.subarray(offset, offset + FRAME_BYTES);
      const ev = this.frame(frame);
      if (ev) events.push(ev);
    }
    this.rest = Buffer.from(buf.subarray(offset));
    buf = Buffer.alloc(0);
    return events;
  }

  /** Ends any utterance in progress (e.g. when the stream stops). */
  flush(): VadEvent[] {
    if (!this.speaking) return [];
    return [this.endSegment('silence')];
  }

  private frame(frame: Buffer): VadEvent | null {
    let sum = 0;
    for (let i = 0; i < frame.length; i += 2) {
      const s = frame.readInt16LE(i) / 32768;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / FRAME_SAMPLES);
    // Speech must stand clearly above the background, with an absolute floor.
    const isSpeech = rms > Math.max(0.01, this.noise * 3.5);

    if (!this.speaking) {
      // Track the background level only while idle.
      this.noise = this.noise * 0.995 + Math.min(rms, 0.05) * 0.005;
      if (this.o.collectAudio) {
        this.preroll.push(Buffer.from(frame));
        if (this.preroll.length * FRAME_MS > this.o.prerollMs) this.preroll.shift();
      }
      this.run = isSpeech ? this.run + 1 : 0;
      if (this.run >= this.o.startFrames) {
        this.speaking = true;
        this.frames = this.o.collectAudio ? [...this.preroll] : [];
        this.preroll = [];
        this.speechMs = this.run * FRAME_MS;
        this.segmentMs = this.frames.length * FRAME_MS;
        this.silentMs = 0;
        this.run = 0;
        return { type: 'speech_start' };
      }
      return null;
    }

    if (this.o.collectAudio) this.frames.push(Buffer.from(frame));
    this.segmentMs += FRAME_MS;
    if (isSpeech) {
      this.speechMs += FRAME_MS;
      this.silentMs = 0;
    } else {
      this.silentMs += FRAME_MS;
      // Very slow adaptation during long "speech" so a noisy room can't lock us in.
      this.noise = this.noise * 0.9995 + Math.min(rms, 0.05) * 0.0005;
    }
    if (this.silentMs >= this.o.endSilenceMs) return this.endSegment('silence');
    if (this.segmentMs >= this.o.maxSegmentMs) return this.endSegment('max_length');
    return null;
  }

  private endSegment(reason: 'silence' | 'max_length'): VadEvent {
    const audio = this.o.collectAudio && this.speechMs >= this.o.minSpeechMs ? Buffer.concat(this.frames) : null;
    const speechMs = this.speechMs;
    this.speaking = reason === 'max_length'; // a cut long utterance continues
    this.frames = [];
    this.speechMs = 0;
    this.segmentMs = 0;
    this.silentMs = 0;
    return { type: 'speech_end', audio, speechMs, reason };
  }
}
