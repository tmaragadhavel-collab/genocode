export type ParticipantRole = 'interviewer' | 'candidate';

export type Speaker = 'INTERVIEWER' | 'CANDIDATE' | 'SYSTEM';

export interface TranscriptSegment {
  id: string;
  speaker: Speaker;
  text: string;
  timestamp: number;
  isFinal: boolean;
  confidence?: number;
}

export interface InterviewContext {
  role: string;
  interviewType: string;
  currentQuestion: string;
  topic: string;
  subtopic: string;
  technologies: string[];
  interviewStage: string;
  questionType: string;
  recentTranscript: TranscriptSegment[];
}

export interface QuestionEvent {
  question: string;
  topic: string;
  confidence: number;
}

export type ConnectionState = 'connected' | 'demo' | 'offline';

export interface ServiceStatus {
  websocket: boolean;
  stt: boolean;
  ai: boolean;
  database: boolean;
  media: boolean;
}

export type RealtimeEvent =
  | { type: 'INTERVIEWER_TRANSCRIPT_PARTIAL'; payload: TranscriptSegment }
  | { type: 'INTERVIEWER_TRANSCRIPT_FINAL'; payload: TranscriptSegment }
  | { type: 'CANDIDATE_TRANSCRIPT_PARTIAL'; payload: TranscriptSegment }
  | { type: 'CANDIDATE_TRANSCRIPT_FINAL'; payload: TranscriptSegment }
  | { type: 'CONTEXT_UPDATED'; payload: InterviewContext }
  | { type: 'QUESTION_DETECTED'; payload: QuestionEvent }
  | { type: 'AI_RESPONSE_START' }
  | { type: 'AI_RESPONSE_CHUNK'; payload: { section?: string; content?: string; type: string } }
  | { type: 'AI_RESPONSE_END' }
  | { type: 'CONNECTION_CHANGED'; payload: { state: ConnectionState; demoMode: boolean } }
  | { type: 'SERVICE_STATUS'; payload: ServiceStatus }
  | { type: 'INTERVIEW_STARTED'; payload: { sessionId: string; title: string } }
  | { type: 'INTERVIEW_ENDED'; payload: { sessionId: string; duration: number } };

export interface InterviewSession {
  id: string;
  title: string;
  role: string;
  interviewType: string;
  status: 'active' | 'completed' | 'cancelled';
  startedAt: string;
  endedAt?: string;
  demoMode: boolean;
}

export interface AIInsight {
  id: string;
  interviewId: string;
  triggerTranscriptId?: string;
  insight: string;
  keyPoints: string[];
  suggestedDirection: string;
  followUp: string;
  topic: string;
  createdAt: string;
}
