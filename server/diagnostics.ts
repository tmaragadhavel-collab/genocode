/**
 * Temporary audio-pipeline diagnostics.
 *
 * Counters only — this module must never alter audio behaviour. Every stage of
 * the two legacy-path audio journeys increments a counter here, so a failure can
 * be attributed to the FIRST broken link rather than to "transcription doesn't
 * work". Read it with `GET /api/diag/audio` or watch the periodic summary log.
 *
 * Deliberately excluded: any payload content, any credential, any transcript
 * text. Only sizes, counts and connection states.
 */

export type StageCounters = {
  /** WebSocket audio messages that reached the server for this speaker. */
  wsMessages: number;
  /** Bytes decoded from those messages. */
  wsBytes: number;
  /** Bytes actually handed to the Deepgram socket (excludes drops). */
  deepgramBytesSent: number;
  /** Frames dropped because the Deepgram socket was not OPEN. */
  deepgramDropped: number;
  /** True while the Deepgram WebSocket is open. */
  deepgramConnected: boolean;
  /** Deepgram sockets opened for this speaker (>1 means a reconnect happened). */
  deepgramOpens: number;
  /** Deepgram sockets closed for this speaker. */
  deepgramCloses: number;
  deepgramErrors: number;
  /** Non-empty interim results. */
  partials: number;
  /** Non-empty `is_final` results. */
  finals: number;
  /** Timestamps, for "did anything move in the last N seconds". */
  firstAudioAt: number | null;
  lastAudioAt: number | null;
  lastTranscriptAt: number | null;
};

const blank = (): StageCounters => ({
  wsMessages: 0,
  wsBytes: 0,
  deepgramBytesSent: 0,
  deepgramDropped: 0,
  deepgramConnected: false,
  deepgramOpens: 0,
  deepgramCloses: 0,
  deepgramErrors: 0,
  partials: 0,
  finals: 0,
  firstAudioAt: null,
  lastAudioAt: null,
  lastTranscriptAt: null,
});

export type Speakers = 'interviewer' | 'candidate';

/** `Speaker` also allows 'system'; only the two real microphones are counted. */
type SpeakerLike = Speakers | 'system';
const track = (s: SpeakerLike): Speakers | null => (s === 'system' ? null : s);

const counters: Record<Speakers, StageCounters> = {
  interviewer: blank(),
  candidate: blank(),
};

/** Seconds of 16 kHz mono PCM16 that a byte count represents. */
const seconds = (bytes: number): number => bytes / 32000;

export const audioDiagnostics = {
  reset(): void {
    counters.interviewer = blank();
    counters.candidate = blank();
  },

  wsAudioReceived(speaker: Speakers, bytes: number): void {
    const c = counters[speaker];
    c.wsMessages++;
    c.wsBytes += bytes;
    c.lastAudioAt = Date.now();
    if (c.firstAudioAt === null) c.firstAudioAt = c.lastAudioAt;
  },

  sentToDeepgram(speaker: SpeakerLike, bytes: number): void {
    const s = track(speaker);
    if (s) counters[s].deepgramBytesSent += bytes;
  },

  droppedByDeepgram(speaker: SpeakerLike): void {
    const s = track(speaker);
    if (s) counters[s].deepgramDropped++;
  },

  deepgramOpen(speaker: SpeakerLike): void {
    const s = track(speaker);
    if (!s) return;
    counters[s].deepgramConnected = true;
    counters[s].deepgramOpens++;
  },

  deepgramClose(speaker: SpeakerLike): void {
    const s = track(speaker);
    if (!s) return;
    counters[s].deepgramConnected = false;
    counters[s].deepgramCloses++;
  },

  deepgramError(speaker: SpeakerLike): void {
    const s = track(speaker);
    if (s) counters[s].deepgramErrors++;
  },

  transcript(speaker: SpeakerLike, isFinal: boolean): void {
    const s = track(speaker);
    if (!s) return;
    const c = counters[s];
    if (isFinal) c.finals++;
    else c.partials++;
    c.lastTranscriptAt = Date.now();
  },

  snapshot(): Record<Speakers, StageCounters & { audioSeconds: number; deepgramSeconds: number }> {
    const decorate = (c: StageCounters) => ({
      ...c,
      audioSeconds: Number(seconds(c.wsBytes).toFixed(1)),
      deepgramSeconds: Number(seconds(c.deepgramBytesSent).toFixed(1)),
    });
    return { interviewer: decorate(counters.interviewer), candidate: decorate(counters.candidate) };
  },

  /** One compact line per speaker, for the server console. */
  summary(): string {
    const snap = audioDiagnostics.snapshot();
    return (Object.keys(snap) as Speakers[])
      .map((s) => {
        const c = snap[s];
        return `[DIAG ${s.toUpperCase()}] ws=${c.wsMessages}msg/${c.audioSeconds}s `
          + `→ deepgram=${c.deepgramSeconds}s(drop ${c.deepgramDropped}) `
          + `conn=${c.deepgramConnected} opens=${c.deepgramOpens} closes=${c.deepgramCloses} err=${c.deepgramErrors} `
          + `partial=${c.partials} final=${c.finals}`;
      })
      .join('\n');
  },

  /** True when any counter moved since the last call — drives the periodic log. */
  changedSince(prev: string): boolean {
    return audioDiagnostics.summary() !== prev;
  },
};
