import { isDBConnected, Interview, Transcript, AIInsightModel, memoryStore } from '../db';

export class DBService {
  async createInterview(data: { title: string; role?: string; interviewType?: string; demoMode: boolean }) {
    if (isDBConnected()) {
      const doc = await Interview.create(data);
      return { _id: doc._id.toString(), ...data, status: 'active' as const, startedAt: doc.startedAt.toISOString(), questionCount: 0, currentTopic: '' };
    }
    return memoryStore.createInterview(data);
  }

  async getInterview(id: string) {
    if (isDBConnected()) {
      const doc = await Interview.findById(id).lean();
      return doc ? { ...doc, _id: doc._id.toString() } : null;
    }
    return memoryStore.getInterview(id) || null;
  }

  async listInterviews() {
    if (isDBConnected()) {
      const docs = await Interview.find().sort({ startedAt: -1 }).lean();
      return docs.map((d) => ({ ...d, _id: d._id.toString() }));
    }
    return memoryStore.listInterviews();
  }

  async endInterview(id: string) {
    if (isDBConnected()) {
      await Interview.findByIdAndUpdate(id, { status: 'completed', endedAt: new Date() });
      return;
    }
    memoryStore.updateInterview(id, { status: 'completed', endedAt: new Date().toISOString() });
  }

  async updateInterviewTopic(id: string, topic: string, questionCount: number) {
    if (isDBConnected()) {
      await Interview.findByIdAndUpdate(id, { currentTopic: topic, questionCount });
      return;
    }
    memoryStore.updateInterview(id, { currentTopic: topic, questionCount });
  }

  async addTranscript(data: { interviewId: string; speaker: string; text: string; timestamp: string; isFinal: boolean; confidence?: number }) {
    if (isDBConnected()) {
      await Transcript.create(data);
      return;
    }
    memoryStore.addTranscript({ ...data, confidence: data.confidence || 1 });
  }

  async getTranscripts(interviewId: string) {
    if (isDBConnected()) {
      return Transcript.find({ interviewId }).sort({ createdAt: 1 }).lean();
    }
    return memoryStore.getTranscripts(interviewId);
  }

  async addAIInsight(data: { interviewId: string; insight: string; keyPoints: string[]; suggestedDirection: string; followUp: string; topic: string; triggerTranscriptId?: string }) {
    if (isDBConnected()) {
      await AIInsightModel.create(data);
      return;
    }
    memoryStore.addAIInsight(data);
  }

  async getAIInsights(interviewId: string) {
    if (isDBConnected()) {
      return AIInsightModel.find({ interviewId }).sort({ createdAt: 1 }).lean();
    }
    return memoryStore.getAIInsights(interviewId);
  }
}

export const dbService = new DBService();
