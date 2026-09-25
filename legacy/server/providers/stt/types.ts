export interface STTProvider {
  readonly name: string;
  start(onTranscript: (text: string, isFinal: boolean) => void): void;
  sendAudio(data: Buffer): void;
  stop(): void;
}
