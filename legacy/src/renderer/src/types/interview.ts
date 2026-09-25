export type ThemeMode = 'light' | 'dark';

export type InterviewSpeaker = 'INTERVIEWER' | 'CANDIDATE' | 'SYSTEM';

export type TranscriptEntry = {
  speaker: InterviewSpeaker;
  text: string;
  timestamp: string;
};

export type QuestionEvent = {
  question: string;
  topic: string;
  confidence: number;
};

export type AssistantState = 'Analyzing context' | 'Suggestion ready' | 'Paused' | 'Listening';
