import type { LLMClient } from '../llm/llmClient';
import { LLMError } from '../llm/errors';
import type { InterviewQuestion } from './evaluationTypes';
import type { InterviewReport, QuestionResult, SkillScore } from './reportTypes';
import type { InterviewSession, SessionManager } from './sessionManager';

const SUMMARY_PROMPT = `You write a short summary of a technical interview for the human interviewer.
You receive per-question AI evaluations (which may have been adjusted by the interviewer).
Write 4-6 neutral sentences: overall performance, clear strengths, and areas to probe further.
Base every statement only on the data given. Do not invent details.
Do not recommend a hiring decision; that decision belongs to the interviewer.
Plain text only, no headings or lists.`;

const EVALUATION_WAIT_MS = 90_000;

const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** Case-insensitive de-duplication, keeping first occurrence order. */
function dedupe(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Builds the final interview report. All numbers come from stored question
 * evaluations and interviewer overrides; the LLM only writes the labelled
 * summary text, and the report is still produced if that call fails.
 */
export class ReportService {
  constructor(
    private readonly sessions: SessionManager,
    private readonly llm: LLMClient,
    private readonly waitForEvaluations: (sessionId: string) => Promise<void>,
    private readonly notify: (session: InterviewSession) => void
  ) {}

  /** Runs in the background; never throws. */
  async generate(session: InterviewSession): Promise<void> {
    if (session.reportStatus === 'generating') return;
    session.reportStatus = 'generating';
    this.notify(session);
    console.log(`[REPORT] ${session.id} generating`);
    const started = Date.now();

    try {
      await Promise.race([
        this.waitForEvaluations(session.id),
        new Promise((r) => setTimeout(r, EVALUATION_WAIT_MS)),
      ]);
      const report = this.buildReport(session);
      const summary = await this.summarize(session, report);
      report.aiSummary = summary.text;
      report.aiSummaryStatus = summary.status;
      session.report = report;
      session.reportStatus = 'ready';
      console.log(`[REPORT] ${session.id} ready (${Date.now() - started}ms, summary ${summary.status})`);
    } catch (err) {
      session.reportStatus = 'failed';
      console.error(`[REPORT] ${session.id} failed: ${(err as Error).message}`);
    }
    this.notify(session);
  }

  buildReport(session: InterviewSession): InterviewReport {
    const qs = session.questions;
    const evaluated = qs.filter((q) => q.evaluation);
    const questionResults: QuestionResult[] = qs.map((q) => ({
      questionId: q.questionId,
      index: q.index,
      questionText: q.questionText,
      skills: q.skills,
      status: q.status,
      aiScore: q.evaluation?.score ?? null,
      finalScore: q.evaluation ? q.finalScore : null,
      overridden: !!q.override,
    }));

    // Skill scores use the interviewer-adjusted score for each evaluated question.
    const bySkill = new Map<string, number[]>();
    for (const q of evaluated) {
      for (const skill of q.skills.length ? q.skills : ['General']) {
        const key = skill.trim();
        bySkill.set(key, [...(bySkill.get(key) ?? []), q.finalScore ?? q.evaluation!.score]);
      }
    }
    const skillBreakdown: SkillScore[] = [...bySkill.entries()]
      .map(([skill, scores]) => ({ skill, score: mean(scores)!, questions: scores.length }))
      .sort((a, b) => b.score - a.score);

    // Weaker answers contribute their gaps first; stronger answers their strengths.
    const byScoreAsc = [...evaluated].sort((a, b) => (a.finalScore ?? 0) - (b.finalScore ?? 0));
    const byScoreDesc = [...byScoreAsc].reverse();
    const kinds = new Set(evaluated.map((q) => q.evaluation!.evaluator));
    const covered = new Set(evaluated.flatMap((q) => q.evaluation!.coveredConcepts.map((c) => c.toLowerCase().trim())));

    return {
      generatedAt: Date.now(),
      candidateName: session.details.candidateName,
      candidateEmail: session.details.candidateEmail,
      position: session.details.position,
      interviewerName: session.details.interviewerName,
      interviewDate: session.startedAt,
      durationMinutes: Math.round(this.sessions.elapsedMs(session) / 60000),
      scheduledMinutes: session.details.durationMinutes,
      questionsAsked: qs.length,
      questionsAnswered: qs.filter((q) => q.answer.trim()).length,
      questionsEvaluated: evaluated.length,
      averageAiScore: mean(evaluated.map((q) => q.evaluation!.score)),
      averageFinalScore: mean(evaluated.map((q) => q.finalScore ?? q.evaluation!.score)),
      questionResults,
      skillBreakdown,
      strengths: dedupe(byScoreDesc.flatMap((q) => q.evaluation!.strengths), 6),
      weaknesses: dedupe(byScoreAsc.flatMap((q) => [...q.evaluation!.factualErrors, ...q.evaluation!.improvements]), 6),
      // A gap later covered (e.g. by a follow-up answer) is not an open area.
      areasToExplore: dedupe(byScoreAsc.flatMap((q) => q.evaluation!.missingConcepts)
        .filter((c) => !covered.has(c.toLowerCase().trim())), 8),
      aiSummary: null,
      aiSummaryStatus: 'unavailable',
      evaluator: kinds.size === 0 ? 'none' : kinds.size > 1 ? 'mixed' : [...kinds][0],
    };
  }

  private async summarize(session: InterviewSession, report: InterviewReport): Promise<{ text: string | null; status: InterviewReport['aiSummaryStatus'] }> {
    if (this.llm.demoMode) return { text: null, status: 'demo' };
    const evaluated = session.questions.filter((q) => q.evaluation);
    if (!evaluated.length) return { text: null, status: 'unavailable' };

    const lines = evaluated.map((q: InterviewQuestion) => [
      `Q${q.index}: ${q.questionText}`,
      `  score ${q.finalScore}/100${q.override ? ` (AI ${q.evaluation!.score}, adjusted by interviewer)` : ''}`,
      q.evaluation!.strengths.length ? `  strengths: ${q.evaluation!.strengths.join('; ')}` : '',
      q.evaluation!.missingConcepts.length ? `  missing: ${q.evaluation!.missingConcepts.join('; ')}` : '',
      q.evaluation!.factualErrors.length ? `  errors: ${q.evaluation!.factualErrors.join('; ')}` : '',
    ].filter(Boolean).join('\n'));
    const user = `Position: ${report.position}\nQuestions asked: ${report.questionsAsked}, evaluated: ${report.questionsEvaluated}\n`
      + `Average score: ${report.averageFinalScore}/100\n\n${lines.join('\n\n')}`;

    try {
      const { text } = await this.llm.complete(
        [{ role: 'system', content: SUMMARY_PROMPT }, { role: 'user', content: user }],
        { purpose: 'report-summary', maxTokens: 900, temperature: 0.3 }
      );
      return { text: text.trim().slice(0, 1500), status: 'generated' };
    } catch (err) {
      const code = err instanceof LLMError ? err.code : 'unknown';
      console.warn(`[REPORT] AI summary unavailable (${code}): ${(err as Error).message}`);
      return { text: null, status: 'unavailable' };
    }
  }
}
