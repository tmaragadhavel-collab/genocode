import type { ParticipantBinding, ParticipantRole, SessionManager } from '../services/sessionManager';
import { DeepgramProvider } from './deepgramProvider';
import { WhisperProvider } from './whisperProvider';
import { Vad } from './vad';
import { BYTES_PER_SECOND, SAMPLE_RATE } from './types';
import type { SpeechToTextProvider, SttErrorInfo, SttProviderConfig, SttSettings, SttStream, TranscriptEvent } from './types';

/**
 * One speech-to-text stream per participant microphone.
 *
 *   browser mic ─(audio_start + binary PCM frames)─▶ SttManager ─▶ provider stream
 *                                                        │                │
 *                                                       VAD         partial/final
 *                                                        ▼                ▼
 *                                         answer-boundary hints    QuestionFlow
 *
 * Session, participant and role come from the authenticated WebSocket binding,
 * never from the message. There is at most one stream per role per interview
 * (matching the single LiveKit identity per role): a new audio_start from the
 * same role — a reconnect or a second tab — replaces the previous stream.
 */

export type SttState = 'connecting' | 'transcribing' | 'reconnecting' | 'unavailable' | 'stopped';

export type SttClient = {
  binding: ParticipantBinding | null;
  send: (msg: { type: string; [key: string]: unknown }) => void;
};

type Hooks = {
  onTranscript: (sessionId: string, role: ParticipantRole, participantId: string, event: TranscriptEvent) => void;
  onSpeech: (sessionId: string, role: ParticipantRole, speaking: boolean) => void;
  toInterviewers: (sessionId: string, msg: { type: string; [key: string]: unknown }) => void;
};

type ParticipantStream = {
  client: SttClient;
  sessionId: string;
  role: ParticipantRole;
  key: string; // `${sessionId}:${role}`
  publicId: string; // e.g. candidate_int_…, matches the LiveKit identity
  providerIndex: number;
  stream: SttStream | null;
  state: SttState;
  failures: number; // consecutive failures on the current provider
  vad: Vad;
  timer: ReturnType<typeof setTimeout> | null;
  chunks: number;
  bytes: number;
  loggedAt: number;
  lastPartialSegment: string | null;
  stopped: boolean;
};

const streamKey = (b: ParticipantBinding) => `${b.sessionId}:${b.role}`;
const MAX_FRAME_BYTES = BYTES_PER_SECOND; // ≤ 1 s per binary frame
const MAX_FAILURES = 3;

function buildProvider(cfg: SttProviderConfig): SpeechToTextProvider {
  return cfg.provider === 'deepgram' ? new DeepgramProvider(cfg) : new WhisperProvider(cfg);
}

export class SttManager {
  private readonly providers: SpeechToTextProvider[];
  private readonly streams = new Map<string, ParticipantStream>();

  constructor(
    settings: SttSettings,
    private readonly sessions: SessionManager,
    private readonly hooks: Hooks
  ) {
    this.providers = [settings.primary, settings.fallback].filter((c): c is SttProviderConfig => !!c).map(buildProvider);
  }

  get mode(): 'stream' | 'unavailable' {
    return this.providers.length ? 'stream' : 'unavailable';
  }

  describe(): string {
    return this.providers.map((p) => `${p.name}:${p.model}`).join(' → ') || 'none';
  }

  /** { type: 'audio_start', format: 'pcm16', sampleRate: 16000, channels: 1 } */
  start(client: SttClient, msg: Record<string, unknown>): void {
    const b = client.binding;
    const session = b ? this.sessions.get(b.sessionId) : undefined;
    if (!b || !session) {
      client.send({ type: 'error', code: 'not_joined', message: 'Join the interview first.' });
      return;
    }
    if (msg.format !== 'pcm16' || msg.sampleRate !== SAMPLE_RATE || msg.channels !== 1) {
      client.send({ type: 'error', code: 'invalid_audio', message: 'Audio must be 16 kHz mono PCM16.' });
      return;
    }
    const publicId = `${b.role}_${b.sessionId}`;
    if (session.status !== 'LIVE' || !this.providers.length) {
      client.send({ type: 'transcription_state', sessionId: b.sessionId, participantId: publicId, role: b.role.toUpperCase(),
        state: this.providers.length ? 'stopped' : 'unavailable', provider: null });
      return;
    }

    const existing = this.streams.get(streamKey(b));
    if (existing) this.stopStream(existing, 'replaced by a new stream');

    const ps: ParticipantStream = {
      client, sessionId: b.sessionId, role: b.role, key: streamKey(b), publicId,
      providerIndex: 0, stream: null, state: 'connecting', failures: 0,
      vad: new Vad(), timer: null, chunks: 0, bytes: 0, loggedAt: Date.now(), lastPartialSegment: null, stopped: false,
    };
    this.streams.set(ps.key, ps);
    this.openProvider(ps);
  }

  /** A binary frame of PCM from this socket's participant. */
  audio(client: SttClient, data: Buffer): void {
    const b = client.binding;
    const ps = b ? this.streams.get(streamKey(b)) : undefined;
    // Frames from a replaced socket (e.g. an old tab) are ignored.
    if (!ps || ps.client !== client || ps.stopped) return;
    if (data.length === 0 || data.length > MAX_FRAME_BYTES || data.length % 2) return;

    ps.chunks++;
    ps.bytes += data.length;
    if (ps.chunks === 1) console.log(`[STT] ${ps.role} audio received (first frame, ${data.length} bytes)`);
    if (Date.now() - ps.loggedAt > 30_000) {
      ps.loggedAt = Date.now();
      console.log(`[STT] ${ps.role} audio: ${(ps.bytes / BYTES_PER_SECOND).toFixed(0)}s received, state ${ps.state}`);
    }

    for (const ev of ps.vad.process(data)) {
      if (ev.type === 'speech_start') this.hooks.onSpeech(ps.sessionId, ps.role, true);
      else if (ev.reason === 'silence') this.hooks.onSpeech(ps.sessionId, ps.role, false);
    }
    if (ps.state !== 'unavailable') ps.stream?.sendAudio(data);
  }

  stop(client: SttClient, reason = 'stopped by participant'): void {
    const b = client.binding;
    const ps = b ? this.streams.get(streamKey(b)) : undefined;
    if (ps && ps.client === client) this.stopStream(ps, reason);
  }

  /** "Retry transcription" from the UI. */
  retry(client: SttClient): void {
    const b = client.binding;
    const ps = b ? this.streams.get(streamKey(b)) : undefined;
    if (!ps || ps.client !== client) {
      // No stream: ask the browser to (re)start capture.
      if (b) client.send({ type: 'transcription_state', sessionId: b.sessionId, participantId: `${b.role}_${b.sessionId}`, role: b.role.toUpperCase(), state: 'stopped', provider: null });
      return;
    }
    console.log(`[STT] ${ps.role} retry requested`);
    ps.stream?.stopStream();
    ps.stream = null;
    ps.providerIndex = 0;
    ps.failures = 0;
    if (ps.timer) clearTimeout(ps.timer);
    this.openProvider(ps);
  }

  onSocketClosed(client: SttClient): void {
    for (const ps of this.streams.values()) {
      if (ps.client === client) this.stopStream(ps, 'participant disconnected');
    }
  }

  stopSession(sessionId: string): void {
    for (const ps of this.streams.values()) {
      if (ps.sessionId === sessionId) this.stopStream(ps, 'interview not live');
    }
  }

  // --- internals ---

  private openProvider(ps: ParticipantStream): void {
    const provider = this.providers[ps.providerIndex];
    this.setState(ps, ps.failures > 0 ? 'reconnecting' : 'connecting');
    console.log(`[STT] ${ps.role} stream ${ps.failures > 0 ? 'reconnecting' : 'started'} (${provider.name}:${provider.model})`);
    const stream = provider.startStream({
      onReady: () => {
        if (ps.stopped || ps.stream !== stream) return;
        if (ps.state !== 'transcribing') console.log(`[STT] ${ps.role} stream ${ps.failures > 0 ? 'reconnected' : 'ready'} (${provider.name})`);
        if (provider.name === 'deepgram') ps.failures = 0; // acknowledged by the provider
        this.setState(ps, 'transcribing');
      },
      onTranscript: (ev) => {
        if (ps.stopped && ev.isFinal === false) return;
        if (!ev.isFinal && ev.text !== '…' && ps.lastPartialSegment !== ev.segmentId) {
          ps.lastPartialSegment = ev.segmentId; // log the first partial of each utterance only
          console.log(`[STT] ${ps.role} partial transcript`);
        }
        if (ev.isFinal) {
          ps.failures = 0;
          if (ps.state === 'reconnecting') this.setState(ps, 'transcribing');
          console.log(`[STT] ${ps.role} final transcript (${ev.text.length} chars${ev.confidence !== null ? `, conf ${ev.confidence.toFixed(2)}` : ''}${ev.lowConfidence ? ', low confidence' : ''})`);
        }
        this.hooks.onTranscript(ps.sessionId, ps.role, ps.publicId, ev);
      },
      onError: (err) => {
        if (ps.stream === stream) this.fail(ps, err);
      },
      onClosed: () => {
        if (ps.stream === stream) this.fail(ps, { code: 'network', message: `${provider.name} stream closed`, fatal: false });
      },
    });
    ps.stream = stream;
  }

  private fail(ps: ParticipantStream, err: SttErrorInfo): void {
    if (ps.stopped) return;
    const provider = this.providers[ps.providerIndex];
    console.warn(`[STT] ${ps.role} stream disconnected (${provider.name}, ${err.code}): ${err.message}`);
    ps.stream?.stopStream();
    ps.stream = null;
    ps.failures++;

    if (err.fatal || ps.failures > MAX_FAILURES) {
      if (ps.providerIndex + 1 < this.providers.length) {
        ps.providerIndex++;
        ps.failures = 0;
        console.warn(`[STT] ${ps.role} falling back to ${this.providers[ps.providerIndex].name}`);
        this.openProvider(ps);
        return;
      }
      console.error(`[STT] ${ps.role} transcription unavailable (${err.code})`);
      this.setState(ps, 'unavailable');
      return;
    }
    this.setState(ps, 'reconnecting');
    ps.timer = setTimeout(() => {
      ps.timer = null;
      if (!ps.stopped) this.openProvider(ps);
    }, 500 * 2 ** (ps.failures - 1));
  }

  private stopStream(ps: ParticipantStream, reason: string): void {
    if (ps.stopped) return;
    ps.stopped = true;
    if (ps.timer) clearTimeout(ps.timer);
    if (ps.vad.isSpeaking) this.hooks.onSpeech(ps.sessionId, ps.role, false);
    ps.stream?.stopStream();
    ps.stream = null;
    if (this.streams.get(ps.key) === ps) this.streams.delete(ps.key);
    console.log(`[STT] ${ps.role} stream stopped (${reason}; ${(ps.bytes / BYTES_PER_SECOND).toFixed(0)}s of audio)`);
    this.setState(ps, 'stopped');
  }

  private setState(ps: ParticipantStream, state: SttState): void {
    if (ps.state === state && state !== 'connecting') return;
    ps.state = state;
    const msg = {
      type: 'transcription_state',
      sessionId: ps.sessionId,
      participantId: ps.publicId,
      role: ps.role.toUpperCase(),
      state,
      provider: this.providers[ps.providerIndex]?.name ?? null,
    };
    ps.client.send(msg);
    // The interviewer also sees whether the candidate is being transcribed.
    if (ps.role === 'candidate') this.hooks.toInterviewers(ps.sessionId, msg);
  }
}
