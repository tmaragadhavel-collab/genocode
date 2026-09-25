export const CHANNELS = {
  // Audio control
  AUDIO_START: 'audio:start',
  AUDIO_STOP: 'audio:stop',
  AUDIO_STATUS: 'audio:status',

  // Transcript events
  TRANSCRIPT_PARTIAL: 'transcript:partial',
  TRANSCRIPT_FINAL: 'transcript:final',

  // Question detection
  INTERVIEWER_QUESTION: 'interviewer:question',

  // Context
  CONTEXT_UPDATE: 'context:update',

  // AI streaming
  AI_START: 'ai:start',
  AI_DELTA: 'ai:delta',
  AI_COMPLETE: 'ai:complete',
  AI_ERROR: 'ai:error',

  // Session lifecycle
  SESSION_START: 'session:start',
  SESSION_STOP: 'session:stop',
  SESSION_STATE: 'session:state',

  // Privacy
  PRIVACY_STATUS: 'privacy:status',
  PROTECTION_SET: 'PROTECTION_SET',
  PROTECTION_STATE_CHANGED: 'PROTECTION_STATE_CHANGED',

  // Window
  ASSISTANT_TOGGLE_VISIBILITY: 'ASSISTANT_TOGGLE_VISIBILITY',
  THEME_CHANGED: 'THEME_CHANGED',

  // Coach overlay (workspace → assistant)
  COACH_CONTENT: 'COACH_CONTENT',
  COACH_STATUS: 'COACH_STATUS',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

export type AudioStatus = {
  systemAudio: 'connected' | 'disconnected' | 'error' | 'unavailable';
  microphone: 'connected' | 'disconnected' | 'error' | 'denied';
  stt: 'connected' | 'disconnected' | 'connecting' | 'error';
  ai: 'connected' | 'disconnected' | 'error';
};

export type TranscriptEvent = {
  speaker: 'interviewer' | 'candidate';
  text: string;
  timestamp: number;
  isFinal: boolean;
  confidence?: number;
};

export type SessionState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'interviewer_speaking'
  | 'processing_question'
  | 'ai_thinking'
  | 'ai_streaming'
  | 'waiting_for_next_question'
  | 'error';
