export type Difficulty = 'easy' | 'medium' | 'hard';

export type TranscriptSegment = {
  id: string;
  sessionId: string;
  questionId: string | null;
  speaker: 'interviewer' | 'candidate';
  text: string;
  timestamp: number;
};

export type Breakdown = {
  correctness: number;
  completeness: number;
  relevance: number;
  technicalDepth: number;
  clarity: number;
};

// Fixed rubric weights; the backend computes the final score from these.
export const RUBRIC_WEIGHTS: Breakdown = {
  correctness: 0.4,
  completeness: 0.25,
  relevance: 0.15,
  technicalDepth: 0.1,
  clarity: 0.1,
};

export type Rubric = {
  expectedAnswer: string;
  expectedConcepts: string[];
  difficulty: Difficulty;
  skills: string[];
  scoringCriteria: string;
  source: 'interviewer' | 'ai' | 'none';
};

export type Evaluation = {
  questionId: string;
  score: number; // weighted, computed server-side
  breakdown: Breakdown;
  coveredConcepts: string[];
  missingConcepts: string[];
  strengths: string[];
  improvements: string[];
  factualErrors: string[];
  confidence: number;
  followUpQuestion: string | null;
  evaluator: 'llm' | 'demo-heuristic';
  model: string;
  evaluatedAt: number;
};

export type ScoreOverride = {
  aiScore: number;
  finalScore: number;
  overrideReason: string;
  overriddenBy: string;
  overriddenAt: number;
};

export type EvaluationStatus = 'not_started' | 'answering' | 'evaluating' | 'completed' | 'error' | 'no_answer';

export type InterviewQuestion = {
  questionId: string;
  index: number;
  questionText: string;
  expectedAnswer: string;
  expectedConcepts: string[];
  difficulty: Difficulty;
  skills: string[];
  scoringCriteria: string;
  rubricSource: Rubric['source'];
  askedAt: number;
  answerStartedAt: number | null;
  answeredAt: number | null;
  answer: string; // final candidate transcript segments joined
  status: EvaluationStatus;
  evaluation: Evaluation | null;
  evaluationError: string | null;
  override: ScoreOverride | null;
  finalScore: number | null; // override if present, else AI score
  interviewerNote: string; // private to the interviewer
};
