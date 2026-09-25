export type Difficulty = 'easy' | 'medium' | 'hard';

export type TranscriptSegment = {
  id: string;
  sessionId: string;
  questionId: string | null;
  speaker: 'interviewer' | 'candidate';
  text: string;
  timestamp: number;
  source: 'stt' | 'manual';
  confidence: number | null; // provider confidence 0–1 (Deepgram)
  // Whisper quality signals when available; lowConfidence is shown in the UI.
  avgLogprob: number | null;
  noSpeechProb: number | null;
  lowConfidence: boolean;
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

/** What the evaluator produces for one run. */
export type EvaluationResult = {
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

/** A stored evaluation run. Runs are append-only; the newest is current. */
export type Evaluation = EvaluationResult & {
  id: string;
  answerSource: 'original' | 'edited';
  answerText: string; // exactly what was evaluated
  trigger: 'auto' | 'retry' | 'reevaluate';
};

export type ScoreOverride = {
  id: string;
  aiScore: number;
  finalScore: number;
  overrideReason: string;
  overriddenBy: string;
  overriddenAt: number;
};

/** Override history entry; finalScore null records that an override was removed. */
export type ScoreOverrideRecord = Omit<ScoreOverride, 'finalScore'> & { finalScore: number | null };

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
  plannedQuestionId: string | null;
  askedAt: number;
  answerStartedAt: number | null;
  answeredAt: number | null;
  answer: string; // original: final candidate transcript segments joined
  editedAnswer: string | null; // interviewer correction; evaluated instead of `answer` when set
  editedBy: string | null;
  editedAt: number | null;
  lowConfidence: boolean; // answer includes low-confidence STT segments
  status: EvaluationStatus;
  evaluation: Evaluation | null; // newest run
  evaluationHistory: Evaluation[];
  evaluationError: string | null;
  override: ScoreOverride | null;
  overrideHistory: ScoreOverrideRecord[];
  finalScore: number | null; // override if present, else AI score
  interviewerNote: string; // private to the interviewer
};
