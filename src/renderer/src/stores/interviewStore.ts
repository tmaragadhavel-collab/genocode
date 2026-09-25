import { create } from 'zustand';

type SessionState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'interviewer_speaking'
  | 'processing_question'
  | 'ai_thinking'
  | 'ai_streaming'
  | 'waiting_for_next_question'
  | 'error';

type AudioStatus = {
  systemAudio: 'connected' | 'disconnected' | 'error' | 'unavailable';
  microphone: 'connected' | 'disconnected' | 'error' | 'denied';
  stt: 'connected' | 'disconnected' | 'connecting' | 'error';
  ai: 'connected' | 'disconnected' | 'error' | 'demo';
};

type LiveKitStatus = {
  room: 'connected' | 'connecting' | 'disconnected' | 'error';
  interviewerAudio: 'receiving' | 'waiting' | 'disconnected';
  candidateAudio: 'receiving' | 'disconnected';
  interviewerIdentity: string | null;
};

type TranscriptEntry = {
  id?: string;
  speaker: 'interviewer' | 'candidate' | 'system';
  text: string;
  timestamp: number;
  isFinal: boolean;
  confidence?: number;
};

type ConnectionMode = 'live' | 'demo' | 'offline';

export type ChatItem = {
  id: string;
  sender: 'candidate' | 'interviewer' | 'ai_interviewer';
  message: string;
  timestamp: number;
};

type VideoState = {
  remoteCamera: MediaStreamTrack | null;
  localCamera: MediaStreamTrack | null;
  cameraEnabled: boolean;
  screenSharing: boolean;
};

const initialVideo: VideoState = {
  remoteCamera: null,
  localCamera: null,
  cameraEnabled: false,
  screenSharing: false,
};

type InterviewStore = {
  sessionState: SessionState;
  connectionMode: ConnectionMode;
  audioStatus: AudioStatus;
  livekitStatus: LiveKitStatus;
  transcript: TranscriptEntry[];
  currentQuestion: string;
  currentTopic: string;
  elapsed: string;
  demoMode: boolean;
  candidateMicEnabled: boolean;
  video: VideoState;
  chatSessionId: string | null;
  chatMessages: ChatItem[];
  chatPending: boolean;
  chatError: string | null;

  setSessionState: (state: SessionState) => void;
  setConnectionMode: (mode: ConnectionMode) => void;
  setAudioStatus: (status: Partial<AudioStatus>) => void;
  setLiveKitStatus: (status: Partial<LiveKitStatus>) => void;
  appendTranscript: (entry: TranscriptEntry) => void;
  updatePartialTranscript: (entry: TranscriptEntry) => void;
  setCurrentQuestion: (question: string, topic: string) => void;
  setElapsed: (elapsed: string) => void;
  setDemoMode: (demo: boolean) => void;
  setCandidateMicEnabled: (enabled: boolean) => void;
  setVideo: (video: VideoState) => void;
  setChatSession: (sessionId: string | null, history?: ChatItem[]) => void;
  addChatMessage: (item: ChatItem) => void;
  setChatPending: (pending: boolean) => void;
  setChatError: (error: string | null) => void;
  clearSession: () => void;
};

export const useInterviewStore = create<InterviewStore>((set) => ({
  sessionState: 'idle',
  connectionMode: 'offline',
  audioStatus: {
    systemAudio: 'disconnected',
    microphone: 'disconnected',
    stt: 'disconnected',
    ai: 'disconnected',
  },
  livekitStatus: {
    room: 'disconnected',
    interviewerAudio: 'disconnected',
    candidateAudio: 'disconnected',
    interviewerIdentity: null,
  },
  transcript: [],
  currentQuestion: '',
  currentTopic: '',
  elapsed: '00:00',
  demoMode: false,
  candidateMicEnabled: true,
  video: initialVideo,
  chatSessionId: null,
  chatMessages: [],
  chatPending: false,
  chatError: null,

  setSessionState: (sessionState) => set({ sessionState }),
  setConnectionMode: (connectionMode) => set({ connectionMode }),
  setAudioStatus: (status) =>
    set((s) => ({ audioStatus: { ...s.audioStatus, ...status } })),
  setLiveKitStatus: (status) =>
    set((s) => ({ livekitStatus: { ...s.livekitStatus, ...status } })),
  appendTranscript: (entry) =>
    set((s) => {
      // A final result supersedes the pending partial from the same speaker.
      const pending = s.transcript.findIndex(
        (t) => t.speaker === entry.speaker && !t.isFinal
      );
      if (pending >= 0) {
        const updated = [...s.transcript];
        if (entry.text.trim()) updated[pending] = entry;
        else updated.splice(pending, 1);
        return { transcript: updated };
      }
      if (!entry.text.trim()) return {};
      return { transcript: [...s.transcript, entry] };
    }),
  updatePartialTranscript: (entry) =>
    set((s) => {
      const existing = s.transcript.findIndex(
        (t) => t.speaker === entry.speaker && !t.isFinal
      );
      if (existing >= 0) {
        const updated = [...s.transcript];
        updated[existing] = entry;
        return { transcript: updated };
      }
      return { transcript: [...s.transcript, entry] };
    }),
  setCurrentQuestion: (currentQuestion, currentTopic) =>
    set({ currentQuestion, currentTopic }),
  setElapsed: (elapsed) => set({ elapsed }),
  setDemoMode: (demoMode) => set({ demoMode }),
  setCandidateMicEnabled: (candidateMicEnabled) => set({ candidateMicEnabled }),
  setVideo: (video) => set({ video }),
  setChatSession: (chatSessionId, history) =>
    set((s) => ({ chatSessionId, chatMessages: history ?? (chatSessionId ? s.chatMessages : []) })),
  addChatMessage: (item) =>
    set((s) => (s.chatMessages.some((m) => m.id === item.id)
      ? {}
      : { chatMessages: [...s.chatMessages, item] })),
  setChatPending: (chatPending) => set({ chatPending }),
  setChatError: (chatError) => set({ chatError }),
  clearSession: () =>
    set({
      sessionState: 'idle',
      transcript: [],
      currentQuestion: '',
      currentTopic: '',
      elapsed: '00:00',
      video: initialVideo,
      chatSessionId: null,
      chatMessages: [],
      chatPending: false,
      chatError: null,
    }),
}));

type AssistantStore = {
  protectionEnabled: boolean;
  theme: 'light' | 'dark';
  currentQuestion: string;
  answerDirection: string;
  keyPoints: string[];
  contextInfo: string;
  followUp: string;
  isStreaming: boolean;
  streamingSection: string | null;

  setProtection: (enabled: boolean) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setCurrentQuestion: (question: string) => void;
  handleStreamChunk: (chunk: { type: string; section?: string; content?: string }) => void;
  clearAssistant: () => void;
};

export const useAssistantStore = create<AssistantStore>((set) => ({
  protectionEnabled: true,
  theme: 'dark',
  currentQuestion: '',
  answerDirection: '',
  keyPoints: [],
  contextInfo: '',
  followUp: '',
  isStreaming: false,
  streamingSection: null,

  setProtection: (enabled) => set({ protectionEnabled: enabled }),
  setTheme: (theme) => set({ theme }),
  setCurrentQuestion: (currentQuestion) => set({ currentQuestion }),

  handleStreamChunk: (chunk) => {
    const { type, section, content } = chunk;

    switch (type) {
      case 'section_start':
        set({ isStreaming: true, streamingSection: section || null });
        if (section === 'ANSWER') set({ answerDirection: '' });
        if (section === 'KEY_POINTS') set({ keyPoints: [] });
        if (section === 'CONTEXT') set({ contextInfo: '' });
        if (section === 'FOLLOW_UP') set({ followUp: '' });
        break;

      case 'content':
        if (section === 'ANSWER') {
          set((s) => ({ answerDirection: s.answerDirection + (content || '') }));
        } else if (section === 'KEY_POINTS') {
          const text = (content || '').trim();
          if (text) {
            const lines = text.split('\n').map(l => l.replace(/^[•\-]\s*/, '').trim()).filter(Boolean);
            set((s) => ({
              keyPoints: [...s.keyPoints, ...lines],
            }));
          }
        } else if (section === 'CONTEXT') {
          set((s) => ({ contextInfo: s.contextInfo + (content || '') }));
        } else if (section === 'FOLLOW_UP') {
          set((s) => ({ followUp: s.followUp + (content || '') }));
        }
        break;

      case 'section_end':
        set({ streamingSection: null });
        break;

      case 'done':
        set({ isStreaming: false, streamingSection: null });
        break;

      case 'error':
        set({ isStreaming: false, streamingSection: null });
        break;
    }
  },

  clearAssistant: () =>
    set({
      currentQuestion: '',
      answerDirection: '',
      keyPoints: [],
      contextInfo: '',
      followUp: '',
      isStreaming: false,
      streamingSection: null,
    }),
}));
