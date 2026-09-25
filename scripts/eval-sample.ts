// Calls the evaluator directly and prints the full evaluation and computed score.
// Usage: npm run eval:sample   (uses LLM_* settings from .env)
import '../server/config';
import { LLMClient } from '../server/llm/llmClient';
import { loadLLMConfig } from '../server/llm/config';
import { EvaluationService, computeScore } from '../server/services/evaluationService';

async function main() {
  const llm = new LLMClient(loadLLMConfig());
  console.log(`LLM: ${llm.describe}`);
  const evaluator = new EvaluationService(llm);
  const questionText = 'What is the difference between a process and a thread?';
  const rubric = await evaluator.generateRubric(questionText, 'Backend Engineer');
  console.log('\nRubric (AI-generated):\n' + JSON.stringify(rubric, null, 2));
  const evaluation = await evaluator.evaluateAnswer({
    questionId: 'q_001_sample',
    questionText,
    rubric,
    candidateAnswer: 'A process is an executing program and a thread is a smaller execution unit inside a process. Threads in the same process share memory.',
    interviewContext: { position: 'Backend Engineer', questionNumber: 1, previousQuestions: [] },
  });
  console.log('\nEvaluation:\n' + JSON.stringify(evaluation, null, 2));
  const b = evaluation.breakdown;
  console.log(`\nScore computed by the backend: ${b.correctness}×0.40 + ${b.completeness}×0.25 + ${b.relevance}×0.15 + ${b.technicalDepth}×0.10 + ${b.clarity}×0.10 = ${computeScore(b)}`);
}

main().catch((err) => {
  console.error(`Evaluation failed (${err.code ?? 'error'}): ${err.message}`);
  process.exit(1);
});
