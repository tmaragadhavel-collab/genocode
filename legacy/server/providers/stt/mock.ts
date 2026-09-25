import type { STTProvider } from './types';

const CNN_RESPONSES = [
  'A convolutional neural network uses learnable filters to extract spatial features from input data.',
  'The convolution operation slides a kernel across the input, computing dot products to produce feature maps.',
  'Pooling layers, typically max pooling, reduce spatial dimensions while preserving the most important features.',
  'Stride controls how much the filter moves — a stride of 2 halves the output dimensions.',
  'ReLU activation after convolution introduces non-linearity, helping the network learn complex patterns.',
  'Deeper layers capture increasingly abstract features — edges become textures, textures become object parts.',
  'Batch normalization stabilizes training by normalizing activations, allowing higher learning rates.',
  'Dropout in fully connected layers prevents overfitting by randomly deactivating neurons during training.',
  'Transfer learning with pre-trained CNNs like ResNet is effective for limited training data scenarios.',
  'The receptive field grows with depth — each neuron in deeper layers sees a larger portion of the input.',
];

export class MockSTTProvider implements STTProvider {
  readonly name = 'mock-stt';
  private interval: ReturnType<typeof setInterval> | null = null;
  private idx = 0;

  start(onTranscript: (text: string, isFinal: boolean) => void): void {
    this.idx = 0;
    this.interval = setInterval(() => {
      const text = CNN_RESPONSES[this.idx % CNN_RESPONSES.length];
      onTranscript(text, true);
      this.idx++;
    }, 6000);
  }

  sendAudio(_data: Buffer): void {
    // Mock provider ignores audio data
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
