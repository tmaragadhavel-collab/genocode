export type Speaker = 'interviewer' | 'candidate' | 'system';

export type TranscriptEntry = {
  id: string;
  speaker: Speaker;
  text: string;
  timestamp: number;
  isFinal: boolean;
  confidence?: number;
};

export type QuestionEvent = {
  question: string;
  topic: string;
  timestamp: number;
};

export type ContextWindow = {
  transcript: TranscriptEntry[];
  currentQuestion: QuestionEvent | null;
  recentQuestions: QuestionEvent[];
  topic: string;
};

export type AssistantSection =
  | 'ANSWER'
  | 'KEY_POINTS'
  | 'CONTEXT'
  | 'FOLLOW_UP';

export type StreamChunk = {
  type: 'section_start' | 'content' | 'section_end' | 'done' | 'error';
  section?: AssistantSection;
  content?: string;
};

export type WSMessageType =
  | 'transcript'
  | 'question'
  | 'assistant_stream'
  | 'connection_state'
  | 'session_control'
  | 'audio_status'
  | 'session_state'
  | 'audio_data'
  | 'session_join'
  | 'session_joined'
  | 'chat_message'
  | 'chat_user_message'
  | 'chat_pending'
  | 'chat_response'
  | 'chat_error'
  | 'interview_start'
  | 'interview_pause'
  | 'interview_resume'
  | 'interview_end'
  | 'interview_cancel'
  | 'interview_state'
  | 'participant_joined'
  | 'participant_left'
  | 'participant_status'
  | 'ping'
  | 'pong'
  | 'question_start'
  | 'question_end'
  | 'question_started'
  | 'question_updated'
  | 'answer_started'
  | 'answer_completed'
  | 'transcript_partial'
  | 'transcript_final'
  | 'room_audio'
  | 'audio_segment'
  | 'speech_activity'
  | 'transcription_status'
  | 'interview_settings'
  | 'settings_updated'
  | 'answer_silence_prompt'
  | 'answer_auto_ended'
  | 'new_question_detected'
  | 'answer_edit'
  | 'evaluation_reevaluate'
  | 'evaluation_started'
  | 'evaluation_completed'
  | 'evaluation_error'
  | 'evaluation_updated'
  | 'evaluation_retry'
  | 'evaluation_override'
  | 'note_save'
  | 'notes_updated'
  | 'report_status'
  | 'error';

export type WSMessage = {
  type: WSMessageType;
  payload: unknown;
  timestamp: string;
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

export type SttConfig = {
  provider: 'groq' | 'deepgram' | 'none';
  apiKey: string;
  model: string;
  baseURL: string;
};

export type ServerConfig = {
  port: number;
  isProduction: boolean;
  publicBaseUrl: string | null;
  databaseUrl: string;
  stt: SttConfig;
  deepgramKey: string | null;
  answerSilenceSeconds: number;
  demoMode: boolean;
  livekitUrl: string | null;
  livekitApiKey: string | null;
  livekitApiSecret: string | null;
};
