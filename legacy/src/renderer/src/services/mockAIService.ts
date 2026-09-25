import type { AIService } from './aiService';

const keywordResponses: Record<string, string> = {
  pooling:
    'Explain that pooling reduces spatial dimensions, lowers computation, and provides some translation invariance. Max pooling retains the strongest activations.',
  cnn: 'A CNN applies learned filters through convolution operations to extract spatial features hierarchically — edges, textures, then objects.',
  overfitting:
    'Discuss regularization techniques: dropout, L2 penalty, data augmentation, and early stopping. Mention the bias-variance trade-off.',
  backpropagation:
    'Explain how gradients flow backward through the network using the chain rule to update weights, minimizing the loss function iteratively.',
  transformer:
    'Cover self-attention, positional encoding, and multi-head attention. Mention how transformers handle long-range dependencies better than RNNs.',
  lstm: 'Explain the gating mechanism (input, forget, output gates) that allows LSTMs to selectively retain or discard information over long sequences.',
  activation:
    'Compare ReLU, sigmoid, and tanh. ReLU is preferred for hidden layers because it mitigates vanishing gradients and is computationally efficient.',
  batch:
    'Batch normalization normalizes layer inputs to stabilize training, allows higher learning rates, and acts as a regularizer.',
  dropout:
    'Dropout randomly deactivates neurons during training to prevent co-adaptation, acting as an ensemble of sub-networks.',
  gradient:
    'Cover vanishing and exploding gradients. Solutions include ReLU activations, residual connections, gradient clipping, and proper initialization.',
  default:
    'Let me analyze that question. Focus on explaining core concepts clearly, use concrete examples, and connect back to practical applications.'
};

export class MockAIService implements AIService {
  async getResponse(input: string): Promise<string> {
    await this.simulateDelay();
    const lower = input.toLowerCase();
    for (const [keyword, response] of Object.entries(keywordResponses)) {
      if (keyword !== 'default' && lower.includes(keyword)) {
        return response;
      }
    }
    return keywordResponses.default;
  }

  async getSuggestion(
    question: string,
    topic: string
  ): Promise<{
    insight: string;
    points: string[];
    direction: string;
    followUp: string;
  }> {
    await this.simulateDelay();
    return {
      insight: `Your interviewer is testing your understanding of ${topic.toLowerCase()} concepts.`,
      points: [
        `Core ${topic} fundamentals`,
        'Practical implementation details',
        'Common trade-offs',
        'Real-world applications'
      ],
      direction: `Structure your answer around ${topic.toLowerCase()} fundamentals, then give practical examples.`,
      followUp: `Can you describe a real-world use case for ${topic.toLowerCase()}?`
    };
  }

  private simulateDelay(): Promise<void> {
    return new Promise((resolve) =>
      setTimeout(resolve, 600 + Math.random() * 400)
    );
  }
}

export const mockAI = new MockAIService();
