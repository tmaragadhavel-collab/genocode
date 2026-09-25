import { v4 as uuid } from 'uuid';
import type { TranscriptEntry, QuestionEvent } from '../types';

const CNN_QUESTIONS: { question: string; topic: string }[] = [
  { question: 'Can you explain how a Convolutional Neural Network works and why pooling layers are used?', topic: 'Deep Learning' },
  { question: 'What is the difference between max pooling and average pooling, and when would you use each?', topic: 'Deep Learning' },
  { question: 'How do skip connections in ResNet help with training deep networks?', topic: 'Neural Network Design' },
  { question: 'Walk me through how backpropagation works in a CNN.', topic: 'Deep Learning' },
  { question: 'How would you handle overfitting when training a CNN on a small dataset?', topic: 'Model Generalization' },
  { question: 'What are the trade-offs between using a larger vs smaller kernel size?', topic: 'Neural Network Design' },
  { question: 'How does transfer learning work with pre-trained CNN models?', topic: 'Transfer Learning' },
  { question: 'Can you explain batch normalization and why it helps training?', topic: 'Training Optimization' },
];

const CNN_CANDIDATE_RESPONSES: string[] = [
  'A CNN uses convolution layers to extract features from input data. The filters slide across the input producing feature maps that capture spatial patterns.',
  'Max pooling takes the maximum value in each window, which helps retain the most prominent features. Average pooling computes the mean, preserving more spatial information.',
  'Skip connections allow gradients to flow directly through the network, solving the vanishing gradient problem in very deep networks.',
  'During backpropagation, we compute the gradient of the loss with respect to each weight using the chain rule, then update weights to minimize the loss.',
  'For small datasets, I would use data augmentation, transfer learning from a pre-trained model, dropout, and early stopping to prevent overfitting.',
  'Larger kernels have bigger receptive fields but more parameters. Smaller kernels are more efficient and multiple small kernels can achieve the same receptive field.',
  'Transfer learning uses a model pre-trained on a large dataset like ImageNet. We freeze early layers that capture general features and fine-tune later layers for our specific task.',
  'Batch normalization normalizes the inputs to each layer, which stabilizes training, allows higher learning rates, and acts as a mild regularizer.',
];

function timestamp(): string {
  const now = new Date();
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
}

export class MockInterviewer {
  private questionIdx = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(callbacks: {
    onQuestion: (q: QuestionEvent) => void;
    onTranscript: (entry: TranscriptEntry) => void;
  }): void {
    if (this.running) return;
    this.running = true;
    this.questionIdx = 0;

    const askQuestion = () => {
      const q = CNN_QUESTIONS[this.questionIdx % CNN_QUESTIONS.length];
      const event: QuestionEvent = {
        question: q.question,
        topic: q.topic,
        confidence: 85 + Math.floor(Math.random() * 10),
      };

      callbacks.onQuestion(event);

      callbacks.onTranscript({
        id: uuid(),
        speaker: 'INTERVIEWER',
        text: q.question,
        timestamp: timestamp(),
        isFinal: true,
      });

      setTimeout(() => {
        if (!this.running) return;
        const response = CNN_CANDIDATE_RESPONSES[this.questionIdx % CNN_CANDIDATE_RESPONSES.length];
        callbacks.onTranscript({
          id: uuid(),
          speaker: 'CANDIDATE',
          text: response,
          timestamp: timestamp(),
          isFinal: true,
        });
      }, 4000 + Math.random() * 2000);

      this.questionIdx++;
    };

    callbacks.onTranscript({
      id: uuid(),
      speaker: 'SYSTEM',
      text: 'Mock interview started — Topic: CNN (Demo Mode)',
      timestamp: timestamp(),
      isFinal: true,
    });

    setTimeout(() => {
      if (!this.running) return;
      askQuestion();
    }, 2000);

    this.interval = setInterval(() => {
      if (!this.running) return;
      askQuestion();
    }, 15000);
  }

  stop(): void {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
