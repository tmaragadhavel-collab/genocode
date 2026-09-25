import mongoose, { Schema, Document } from 'mongoose';

export interface IInterview extends Document {
  title: string;
  role: string;
  interviewType: string;
  status: 'active' | 'completed' | 'cancelled';
  startedAt: Date;
  endedAt?: Date;
  demoMode: boolean;
  currentTopic: string;
  questionCount: number;
}

const InterviewSchema = new Schema<IInterview>({
  title: { type: String, required: true },
  role: { type: String, default: 'AI Engineer' },
  interviewType: { type: String, default: 'Technical' },
  status: { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active' },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
  demoMode: { type: Boolean, default: false },
  currentTopic: { type: String, default: '' },
  questionCount: { type: Number, default: 0 },
});

export interface ITranscript extends Document {
  interviewId: string;
  speaker: string;
  text: string;
  timestamp: string;
  isFinal: boolean;
  confidence: number;
}

const TranscriptSchema = new Schema<ITranscript>({
  interviewId: { type: String, required: true, index: true },
  speaker: { type: String, required: true },
  text: { type: String, required: true },
  timestamp: { type: String, required: true },
  isFinal: { type: Boolean, default: true },
  confidence: { type: Number, default: 1 },
}, { timestamps: true });

export interface IAIInsight extends Document {
  interviewId: string;
  triggerTranscriptId?: string;
  insight: string;
  keyPoints: string[];
  suggestedDirection: string;
  followUp: string;
  topic: string;
}

const AIInsightSchema = new Schema<IAIInsight>({
  interviewId: { type: String, required: true, index: true },
  triggerTranscriptId: { type: String },
  insight: { type: String, default: '' },
  keyPoints: [{ type: String }],
  suggestedDirection: { type: String, default: '' },
  followUp: { type: String, default: '' },
  topic: { type: String, default: '' },
}, { timestamps: true });

export const Interview = mongoose.model<IInterview>('Interview', InterviewSchema);
export const Transcript = mongoose.model<ITranscript>('Transcript', TranscriptSchema);
export const AIInsightModel = mongoose.model<IAIInsight>('AIInsight', AIInsightSchema);
