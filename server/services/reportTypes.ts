import type { Difficulty } from './evaluationTypes';

export type PlannedQuestion = {
  id: string;
  text: string;
  expectedConcepts: string[];
  skills: string[];
  difficulty: Difficulty;
  askedQuestionId: string | null; // set once asked in the room
};

export type ReportStatus = 'none' | 'generating' | 'ready' | 'failed';

export type Decision = 'undecided' | 'strong_hire' | 'hire' | 'no_hire' | 'strong_no_hire';

/** Human-controlled conclusions. AI never writes these fields. */
export type InterviewerReview = {
  decision: Decision;
  finalScore: number | null;
  notes: string;
  comments: string;
  updatedAt: number | null;
  updatedBy: string | null;
};

export type QuestionResult = {
  questionId: string;
  index: number;
  questionText: string;
  skills: string[];
  status: string;
  aiScore: number | null;
  finalScore: number | null;
  overridden: boolean;
};

export type SkillScore = { skill: string; score: number; questions: number };

export type InterviewReport = {
  generatedAt: number;
  candidateName: string;
  candidateEmail: string | null;
  position: string;
  interviewerName: string;
  interviewDate: number | null;
  durationMinutes: number; // actual LIVE time
  scheduledMinutes: number;
  questionsAsked: number;
  questionsAnswered: number;
  questionsEvaluated: number;
  averageAiScore: number | null;
  averageFinalScore: number | null; // includes interviewer overrides
  questionResults: QuestionResult[];
  skillBreakdown: SkillScore[];
  strengths: string[];
  weaknesses: string[];
  areasToExplore: string[];
  aiSummary: string | null;
  aiSummaryStatus: 'generated' | 'unavailable' | 'demo';
  evaluator: 'llm' | 'demo-heuristic' | 'mixed' | 'none';
};
