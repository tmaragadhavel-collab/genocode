import type { TranscriptEntry, QuestionEvent, ContextWindow } from '../types';

const MAX_CONTEXT_ENTRIES = 15;

export class ConversationEngine {
  private transcript: TranscriptEntry[] = [];
  private currentQuestion: QuestionEvent | null = null;
  private recentQuestions: QuestionEvent[] = [];
  private currentTopic = '';
  private pendingInterviewerText = '';
  private questionDetectionTimer: ReturnType<typeof setTimeout> | null = null;
  private onQuestionDetected: ((q: QuestionEvent) => void) | null = null;

  setQuestionHandler(handler: (q: QuestionEvent) => void): void {
    this.onQuestionDetected = handler;
  }

  handleTranscript(entry: TranscriptEntry): void {
    if (entry.speaker === 'interviewer') {

      if (entry.isFinal && entry.text.trim()) {
        this.pendingInterviewerText += (this.pendingInterviewerText ? ' ' : '') + entry.text.trim();
        this.transcript.push(entry);
        this.trimTranscript();

        if (this.questionDetectionTimer) {
          clearTimeout(this.questionDetectionTimer);
        }

        this.questionDetectionTimer = setTimeout(() => {
          this.finalizeQuestion();
        }, 2000);
      }
    } else if (entry.speaker === 'candidate') {
      if (entry.isFinal && entry.text.trim()) {
        this.transcript.push(entry);
        this.trimTranscript();
      }
    }
  }

  private finalizeQuestion(): void {
    const text = this.pendingInterviewerText.trim();
    if (!text) return;

    const topic = this.inferTopic(text);
    this.currentTopic = topic;

    const question: QuestionEvent = {
      question: text,
      topic,
      timestamp: Date.now(),
    };

    this.currentQuestion = question;
    this.recentQuestions.push(question);
    if (this.recentQuestions.length > 5) {
      this.recentQuestions = this.recentQuestions.slice(-5);
    }

    this.pendingInterviewerText = '';
    this.onQuestionDetected?.(question);
  }

  getContext(): ContextWindow {
    return {
      transcript: [...this.transcript],
      currentQuestion: this.currentQuestion,
      recentQuestions: [...this.recentQuestions],
      topic: this.currentTopic,
    };
  }

  clear(): void {
    this.transcript = [];
    this.currentQuestion = null;
    this.recentQuestions = [];
    this.currentTopic = '';
    this.pendingInterviewerText = '';
    if (this.questionDetectionTimer) {
      clearTimeout(this.questionDetectionTimer);
      this.questionDetectionTimer = null;
    }
  }

  private trimTranscript(): void {
    if (this.transcript.length > MAX_CONTEXT_ENTRIES) {
      this.transcript = this.transcript.slice(-MAX_CONTEXT_ENTRIES);
    }
  }

  private inferTopic(text: string): string {
    const lower = text.toLowerCase();
    const topics: [string, string[]][] = [
      ['Database Architecture', ['database', 'sql', 'postgres', 'mongodb', 'nosql', 'schema', 'query', 'index']],
      ['System Design', ['design', 'scalab', 'architecture', 'microservice', 'distributed', 'load balanc']],
      ['Data Structures', ['array', 'linked list', 'tree', 'graph', 'hash', 'stack', 'queue', 'heap']],
      ['Algorithms', ['algorithm', 'sort', 'search', 'dynamic programming', 'recursion', 'complexity', 'big o']],
      ['API Design', ['api', 'rest', 'graphql', 'endpoint', 'http', 'request', 'response']],
      ['Cloud & DevOps', ['aws', 'cloud', 'docker', 'kubernetes', 'ci/cd', 'deploy']],
      ['Frontend', ['react', 'css', 'javascript', 'typescript', 'component', 'dom', 'state']],
      ['Backend', ['server', 'node', 'express', 'middleware', 'auth', 'session']],
      ['Machine Learning', ['ml', 'model', 'training', 'neural', 'deep learning', 'cnn', 'ai']],
      ['Security', ['security', 'encrypt', 'auth', 'oauth', 'jwt', 'xss', 'injection']],
      ['Testing', ['test', 'unit test', 'integration', 'mock', 'tdd', 'coverage']],
    ];

    for (const [topic, keywords] of topics) {
      if (keywords.some(k => lower.includes(k))) return topic;
    }
    return this.currentTopic || 'Technical Interview';
  }
}
