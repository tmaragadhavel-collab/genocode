export interface AIService {
  getResponse(input: string): Promise<string>;
  getSuggestion(question: string, topic: string): Promise<{
    insight: string;
    points: string[];
    direction: string;
    followUp: string;
  }>;
}
