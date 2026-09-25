import { v4 as uuid } from 'uuid';

interface MemInterview {
  _id: string;
  title: string;
  role: string;
  interviewType: string;
  status: 'active' | 'completed' | 'cancelled';
  startedAt: string;
  endedAt?: string;
  demoMode: boolean;
  currentTopic: string;
  questionCount: number;
}

interface MemTranscript {
  _id: string;
  interviewId: string;
  speaker: string;
  text: string;
  timestamp: string;
  isFinal: boolean;
  confidence: number;
  createdAt: string;
}

interface MemAIInsight {
  _id: string;
  interviewId: string;
  triggerTranscriptId?: string;
  insight: string;
  keyPoints: string[];
  suggestedDirection: string;
  followUp: string;
  topic: string;
  createdAt: string;
}

class MemoryStore {
  interviews: MemInterview[] = [];
  transcripts: MemTranscript[] = [];
  aiInsights: MemAIInsight[] = [];

  createInterview(data: Partial<MemInterview>): MemInterview {
    const doc: MemInterview = {
      _id: uuid(),
      title: data.title || 'Untitled Interview',
      role: data.role || 'AI Engineer',
      interviewType: data.interviewType || 'Technical',
      status: 'active',
      startedAt: new Date().toISOString(),
      demoMode: data.demoMode || false,
      currentTopic: '',
      questionCount: 0,
    };
    this.interviews.push(doc);
    return doc;
  }

  getInterview(id: string): MemInterview | undefined {
    return this.interviews.find((i) => i._id === id);
  }

  listInterviews(): MemInterview[] {
    return [...this.interviews].reverse();
  }

  updateInterview(id: string, data: Partial<MemInterview>): MemInterview | undefined {
    const idx = this.interviews.findIndex((i) => i._id === id);
    if (idx === -1) return undefined;
    this.interviews[idx] = { ...this.interviews[idx], ...data };
    return this.interviews[idx];
  }

  addTranscript(data: Omit<MemTranscript, '_id' | 'createdAt'>): MemTranscript {
    const doc: MemTranscript = {
      ...data,
      _id: uuid(),
      createdAt: new Date().toISOString(),
    };
    this.transcripts.push(doc);
    return doc;
  }

  getTranscripts(interviewId: string): MemTranscript[] {
    return this.transcripts.filter((t) => t.interviewId === interviewId);
  }

  addAIInsight(data: Omit<MemAIInsight, '_id' | 'createdAt'>): MemAIInsight {
    const doc: MemAIInsight = {
      ...data,
      _id: uuid(),
      createdAt: new Date().toISOString(),
    };
    this.aiInsights.push(doc);
    return doc;
  }

  getAIInsights(interviewId: string): MemAIInsight[] {
    return this.aiInsights.filter((i) => i.interviewId === interviewId);
  }
}

export const memoryStore = new MemoryStore();
