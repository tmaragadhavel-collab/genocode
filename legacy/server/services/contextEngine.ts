import type { TranscriptEntry, QuestionEvent, ContextWindow } from '../types';

const MAX_TRANSCRIPT_WINDOW = 20;

export class ContextEngine {
  private transcript: TranscriptEntry[] = [];
  private currentQuestion: QuestionEvent | null = null;
  private topic = 'Deep Learning';
  private subtopic = 'Convolutional Neural Networks';
  private interviewStage = 'Technical Discussion';
  private questionCount = 0;

  appendTranscript(entry: TranscriptEntry): void {
    this.transcript.push(entry);
    if (this.transcript.length > MAX_TRANSCRIPT_WINDOW) {
      this.transcript = this.transcript.slice(-MAX_TRANSCRIPT_WINDOW);
    }
    this.inferSubtopic(entry.text);
  }

  setQuestion(event: QuestionEvent): void {
    this.currentQuestion = event;
    this.topic = event.topic;
    this.questionCount++;
    this.updateStage();
  }

  getWindow(): ContextWindow {
    return {
      transcript: [...this.transcript],
      currentQuestion: this.currentQuestion,
      topic: this.topic,
      subtopic: this.subtopic,
      interviewStage: this.interviewStage,
    };
  }

  private inferSubtopic(text: string): void {
    const lower = text.toLowerCase();
    if (lower.includes('pool') || lower.includes('downsamp')) {
      this.subtopic = 'Pooling Layers';
    } else if (lower.includes('conv') || lower.includes('filter') || lower.includes('kernel')) {
      this.subtopic = 'Convolution Operations';
    } else if (lower.includes('archit') || lower.includes('resnet') || lower.includes('vgg')) {
      this.subtopic = 'CNN Architectures';
    } else if (lower.includes('train') || lower.includes('overfit') || lower.includes('augment')) {
      this.subtopic = 'Training & Optimization';
    } else if (lower.includes('batch') || lower.includes('normal')) {
      this.subtopic = 'Batch Normalization';
    } else if (lower.includes('dropout') || lower.includes('regular')) {
      this.subtopic = 'Regularization';
    } else if (lower.includes('transfer') || lower.includes('pretrain')) {
      this.subtopic = 'Transfer Learning';
    }
  }

  private updateStage(): void {
    if (this.questionCount <= 1) {
      this.interviewStage = 'Opening Questions';
    } else if (this.questionCount <= 4) {
      this.interviewStage = 'Technical Discussion';
    } else if (this.questionCount <= 6) {
      this.interviewStage = 'Deep Dive';
    } else {
      this.interviewStage = 'Wrap-up';
    }
  }
}
