// LLM client behaviour against local fake OpenAI-compatible servers:
// retry with backoff, fallback, JSON repair, schema validation, errors.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { LLMClient } from '../server/llm/llmClient';
import { LLMError } from '../server/llm/errors';
import { EvaluationService, EvaluationSchema, computeScore } from '../server/services/evaluationService';

type Reply = { status: number; content?: string; delayMs?: number };

function fakeProvider() {
  const queue: Reply[] = [];
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      calls++;
      const reply = queue.shift() ?? { status: 200, content: '{}' };
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      if (reply.status !== 200) {
        res.end(JSON.stringify({ error: { message: `fake ${reply.status}` } }));
        return;
      }
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'fake',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply.content } }],
      }));
    });
  });
  return {
    server,
    queue,
    get calls() { return calls; },
    reset() { queue.length = 0; calls = 0; },
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
  };
}

const primary = fakeProvider();
const fallback = fakeProvider();

const good = {
  breakdown: { correctness: 90, completeness: 75, relevance: 92, technicalDepth: 70, clarity: 85 },
  coveredConcepts: ['HTTP methods'], missingConcepts: ['statelessness'], factualErrors: [],
  strengths: ['Correct HTTP methods'], improvements: ['Explain statelessness'], confidence: 0.87,
  followUpQuestion: 'Why is REST stateless?',
};

function client(withFallback: boolean, timeoutMs = 2000) {
  return new LLMClient({
    primary: { name: 'groq', baseURL: primary.url(), apiKey: 'test-key', model: 'm1' },
    fallback: withFallback ? { name: 'gemini', baseURL: fallback.url(), apiKey: 'test-key', model: 'm2' } : null,
    timeoutMs,
    maxRetries: 2,
  });
}

const msgs = [{ role: 'user' as const, content: 'hi' }];

before(async () => {
  await new Promise<void>((r) => primary.server.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => fallback.server.listen(0, '127.0.0.1', r));
});
after(() => {
  primary.server.close();
  fallback.server.close();
});

test('retries 429/5xx with backoff, then succeeds on the primary', async () => {
  primary.reset();
  primary.queue.push({ status: 429 }, { status: 503 }, { status: 200, content: 'ok' });
  const started = Date.now();
  const res = await client(false).complete(msgs, { purpose: 'test' });
  assert.equal(res.text, 'ok');
  assert.equal(primary.calls, 3);
  assert.ok(Date.now() - started >= 1900, 'backoff 0.5s + 1.5s');
});

test('falls back after retries are exhausted', async () => {
  primary.reset();
  fallback.reset();
  primary.queue.push({ status: 500 }, { status: 500 }, { status: 500 });
  fallback.queue.push({ status: 200, content: 'from fallback' });
  const res = await client(true).complete(msgs, { purpose: 'test' });
  assert.equal(res.text, 'from fallback');
  assert.equal(res.provider, 'gemini');
  assert.equal(primary.calls, 3);
});

test('auth errors are not retried; fallback is used', async () => {
  primary.reset();
  fallback.reset();
  primary.queue.push({ status: 401 });
  fallback.queue.push({ status: 200, content: 'ok' });
  await client(true).complete(msgs, { purpose: 'test' });
  assert.equal(primary.calls, 1);
});

test('timeout is enforced per call and reported as timeout', async () => {
  primary.reset();
  primary.queue.push({ status: 200, content: 'slow', delayMs: 1500 }, { status: 200, content: 'slow', delayMs: 1500 }, { status: 200, content: 'slow', delayMs: 1500 });
  await assert.rejects(client(false, 300).complete(msgs, { purpose: 'test' }), (e: unknown) => e instanceof LLMError && e.code === 'timeout');
});

test('both providers failing throws LLMError', async () => {
  primary.reset();
  fallback.reset();
  primary.queue.push({ status: 401 });
  fallback.queue.push({ status: 401 });
  await assert.rejects(client(true).complete(msgs, { purpose: 'test' }), (e: unknown) => e instanceof LLMError && e.code === 'auth');
});

test('invalid JSON gets one repair retry, then succeeds', async () => {
  primary.reset();
  primary.queue.push({ status: 200, content: 'Sure! Here you go: not json' }, { status: 200, content: JSON.stringify(good) });
  const res = await client(false).completeJSON(EvaluationSchema, msgs, { purpose: 'test' });
  assert.equal(res.data.breakdown.correctness, 90);
  assert.equal(primary.calls, 2);
});

test('schema violations after the repair retry are rejected', async () => {
  primary.reset();
  const bad = JSON.stringify({ ...good, breakdown: { ...good.breakdown, correctness: 140 } });
  primary.queue.push({ status: 200, content: bad }, { status: 200, content: bad });
  await assert.rejects(client(false).completeJSON(EvaluationSchema, msgs, { purpose: 'test' }),
    (e: unknown) => e instanceof LLMError && e.code === 'invalid_response');
});

test('JSON wrapped in prose or fences is extracted', async () => {
  primary.reset();
  primary.queue.push({ status: 200, content: 'Here is the JSON:\n```json\n' + JSON.stringify(good) + '\n```' });
  const res = await client(false).completeJSON(EvaluationSchema, msgs, { purpose: 'test' });
  assert.equal(res.data.confidence, 0.87);
});

test('backend computes the score; an LLM-supplied total is ignored', async () => {
  primary.reset();
  primary.queue.push({ status: 200, content: JSON.stringify({ ...good, score: 99, total: 99 }) });
  const evaluation = await new EvaluationService(client(false)).evaluateAnswer({
    questionId: 'q_001_abcdef',
    questionText: 'What is a REST API?',
    rubric: { expectedAnswer: '', expectedConcepts: ['statelessness'], difficulty: 'medium', skills: [], scoringCriteria: '', source: 'interviewer' },
    candidateAnswer: 'It uses HTTP verbs on resources.',
    interviewContext: { position: 'Backend', questionNumber: 1, previousQuestions: [] },
  });
  // 90×0.40 + 75×0.25 + 92×0.15 + 70×0.10 + 85×0.10 = 84.05
  assert.equal(evaluation.score, 84);
  assert.equal(computeScore(evaluation.breakdown), 84);
  assert.ok(!('total' in evaluation));
});

test('numeric strings are accepted; nulls are not coerced to 0', () => {
  const ok = EvaluationSchema.safeParse({ ...good, breakdown: { ...good.breakdown, clarity: '85' } });
  assert.ok(ok.success && ok.data.breakdown.clarity === 85);
  const bad = EvaluationSchema.safeParse({ ...good, breakdown: { ...good.breakdown, clarity: null } });
  assert.equal(bad.success, false);
});
