// Candidate coaching: what reaches the LLM, how often, and who sees the result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoachingService } from '../server/services/coachingService';
import { looksLikeQuestion } from '../server/services/questionFlow';
import type { LLMClient } from '../server/llm/llmClient';
import type { InterviewSession } from '../server/services/sessionManager';

type Sent = { role: string; msg: { type: string; [k: string]: unknown } };

const DEBOUNCE = 20;
const settle = () => new Promise((r) => setTimeout(r, DEBOUNCE * 6));

/** Records every prompt and streams a canned reply, one delta per chunk. */
function fakeLLM(behaviour: 'ok' | 'fail' | 'slow' = 'ok') {
  const calls: string[] = [];
  const llm = {
    demoMode: false,
    async stream(messages: { role: string; content: string }[], onDelta: (d: string) => void) {
      calls.push(messages[messages.length - 1].content);
      if (behaviour === 'fail') throw new Error('provider exploded: key sk-secret');
      if (behaviour === 'slow') await new Promise((r) => setTimeout(r, DEBOUNCE * 8));
      for (const d of ['### HINTS\n', '- one\n', '- two\n', '### STRUCTURE\n', 'A → B\n',
        '### GROUNDING\n', 'None on file.\n', '### CAUTION\n', 'Do not ramble.']) onDelta(d);
    },
  } as unknown as LLMClient;
  return { llm, calls };
}

function fixture(coachingOn = true) {
  const sent: Sent[] = [];
  const session = {
    id: 'int_test',
    status: 'LIVE',
    settings: { autoEndOnSilence: false, silenceSeconds: 5, candidateCoaching: coachingOn },
    details: { position: 'Backend Engineer', skills: ['python'], difficulty: 'medium' },
    transcript: [],
  } as unknown as InterviewSession;
  const send = {
    toRole: (_s: string, role: 'interviewer' | 'candidate', msg: Sent['msg']) => sent.push({ role, msg }),
    toSession: (_s: string, msg: Sent['msg']) => sent.push({ role: 'both', msg }),
  };
  return { session, sent, send };
}

const speak = (svc: CoachingService, session: InterviewSession, text: string) =>
  svc.onInterviewerFinal(session, text, looksLikeQuestion);

test('one interviewer question produces exactly one LLM request', async () => {
  const { llm, calls } = fakeLLM();
  const { session, sent, send } = fixture();
  const svc = new CoachingService(llm, send, { debounceMs: DEBOUNCE });
  speak(svc, session, 'Tell me about your most recent AI project.');
  await settle();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /Tell me about your most recent AI project/);
  assert.ok(sent.some((s) => s.role === 'candidate' && s.msg.type === 'coaching_question'));
});

test('the same question asked twice does not call the LLM again', async () => {
  const { llm, calls } = fakeLLM();
  const { session, send } = fixture();
  const svc = new CoachingService(llm, send, { debounceMs: DEBOUNCE });
  speak(svc, session, 'Tell me about your project.');
  await settle();
  speak(svc, session, 'Tell me about your project.');
  await settle();
  assert.equal(calls.length, 1);
});

test('a question split across several finals is debounced into one request', async () => {
  const { llm, calls } = fakeLLM();
  const { session, send } = fixture();
  const svc = new CoachingService(llm, send, { debounceMs: DEBOUNCE });
  speak(svc, session, 'Can you explain');
  speak(svc, session, 'how you used LangChain');
  speak(svc, session, 'in your project?');
  await settle();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /Can you explain how you used LangChain in your project\?/);
});

test('interviewer speech that is not a question triggers nothing', async () => {
  const { llm, calls } = fakeLLM();
  const { session, send } = fixture();
  const svc = new CoachingService(llm, send, { debounceMs: DEBOUNCE });
  speak(svc, session, 'Okay. Great, thanks.');
  await settle();
  assert.equal(calls.length, 0);
});

test('two different questions produce two requests with different ids', async () => {
  const { llm, calls } = fakeLLM();
  const { session, sent, send } = fixture();
  const svc = new CoachingService(llm, send, { debounceMs: DEBOUNCE });
  speak(svc, session, 'Tell me about your most recent project.');
  await settle();
  speak(svc, session, 'Why did you choose that architecture?');
  await settle();
  assert.equal(calls.length, 2);
  const ids = sent.filter((s) => s.msg.type === 'coaching_question').map((s) => s.msg.questionId);
  assert.equal(new Set(ids).size, 2);
});

test('a new question cancels the previous stream, so stale coaching never lands', async () => {
  const { llm } = fakeLLM('slow');
  const { session, sent, send } = fixture();
  const svc = new CoachingService(llm, send, { debounceMs: DEBOUNCE });
  speak(svc, session, 'Tell me about your first project.');
  await new Promise((r) => setTimeout(r, DEBOUNCE * 3)); // request in flight, not yet streaming
  speak(svc, session, 'Why did you choose that architecture?');
  await new Promise((r) => setTimeout(r, DEBOUNCE * 20));

  const ids = sent.filter((s) => s.msg.type === 'coaching_question').map((s) => s.msg.questionId);
  const stale = ids[0];
  assert.equal(sent.filter((s) => s.msg.type === 'coaching_delta' && s.msg.questionId === stale).length, 0,
    'the superseded question produced no coaching content');
  assert.ok(sent.some((s) => s.msg.type === 'coaching_delta' && s.msg.questionId === ids[1]));
});

test('coaching is off unless the interview enabled it', async () => {
  const { llm, calls } = fakeLLM();
  const { session, send } = fixture(false);
  const svc = new CoachingService(llm, send, { debounceMs: DEBOUNCE });
  speak(svc, session, 'Tell me about your most recent AI project.');
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(svc.enabledFor(session), false);
});

test('an LLM failure is reported safely and never leaks provider detail', async () => {
  const { llm } = fakeLLM('fail');
  const { session, sent, send } = fixture();
  const svc = new CoachingService(llm, send, { debounceMs: DEBOUNCE });
  speak(svc, session, 'Tell me about your most recent AI project.');
  await settle();
  const err = sent.find((s) => s.msg.type === 'coaching_state' && s.msg.state === 'error');
  assert.ok(err, 'an error state was sent');
  assert.equal(err!.msg.error, 'AI coaching temporarily unavailable');
  assert.ok(!JSON.stringify(sent).includes('sk-secret'), 'no credential reached any client');
  assert.ok(!JSON.stringify(sent).includes('exploded'), 'no provider internals reached any client');
});

test('coaching content goes only to the candidate; the interviewer sees only that it is active', async () => {
  const { llm } = fakeLLM();
  const { session, sent, send } = fixture();
  const svc = new CoachingService(llm, send, { debounceMs: DEBOUNCE });
  speak(svc, session, 'Tell me about your most recent AI project.');
  await settle();
  const toInterviewer = sent.filter((s) => s.role === 'interviewer');
  assert.ok(toInterviewer.every((s) => s.msg.type === 'coaching_activity'),
    'the interviewer receives no coaching content');
  assert.ok(toInterviewer.length > 0, 'the interviewer is told coaching is running');
  assert.ok(sent.some((s) => s.role === 'candidate' && s.msg.type === 'coaching_delta'));
});

test('the prompt is grounded and forbids inventing experience', async () => {
  const { llm, calls } = fakeLLM();
  const { session, send } = fixture();
  const svc = new CoachingService(llm, send, { debounceMs: DEBOUNCE });
  speak(svc, session, 'Tell me about your most recent AI project.');
  await settle();
  assert.match(calls[0], /No resume or job description has been provided/);
  assert.match(calls[0], /Backend Engineer/);
});

test('question heuristic: short explicit questions count, filler does not', () => {
  assert.equal(looksLikeQuestion('What is Python?'), true);
  assert.equal(looksLikeQuestion('Walk me through your last project.'), true);
  assert.equal(looksLikeQuestion('Okay, thanks.'), false);
  assert.equal(looksLikeQuestion('Sure?'), false, 'a one-word "question" is noise');
  assert.equal(looksLikeQuestion('Right, got it, makes sense.'), false);
});

test('section markers survive being streamed one character at a time', async () => {
  const calls: string[] = [];
  const llm = {
    demoMode: false,
    async stream(_m: unknown, onDelta: (d: string) => void) {
      calls.push('x');
      for (const ch of '### HINTS\n- alpha\n- beta\n### STRUCTURE\nA → B\n### GROUNDING\nNone.\n### CAUTION\nStay short.') {
        onDelta(ch); // worst case: one character per delta
      }
    },
  } as unknown as LLMClient;
  const { session, sent, send } = fixture();
  const svc = new CoachingService(llm, send, { debounceMs: DEBOUNCE });
  speak(svc, session, 'Tell me about your most recent AI project.');
  await settle();
  const by = (s: string) => sent.filter((x) => x.msg.type === 'coaching_delta' && x.msg.section === s)
    .map((x) => x.msg.text).join('');
  assert.match(by('HINTS'), /alpha/);
  assert.match(by('HINTS'), /beta/);
  assert.match(by('STRUCTURE'), /A → B/);
  assert.match(by('GROUNDING'), /None/);
  assert.match(by('CAUTION'), /Stay short/);
});

test('bold and colon section headings are accepted, not just ###', async () => {
  const llm = {
    demoMode: false,
    async stream(_m: unknown, onDelta: (d: string) => void) {
      onDelta('**HINTS**  \n- alpha\n- beta\n\n');
      onDelta('STRUCTURE:\nA → B\n');
      onDelta('### GROUNDING\nNone on file.\n**CAUTION**\nStay short.');
    },
  } as unknown as LLMClient;
  const { session, sent, send } = fixture();
  const svc = new CoachingService(llm, send, { debounceMs: DEBOUNCE });
  speak(svc, session, 'Tell me about your most recent AI project.');
  await settle();
  const by = (s: string) => sent.filter((x) => x.msg.type === 'coaching_delta' && x.msg.section === s)
    .map((x) => x.msg.text).join('');
  assert.match(by('HINTS'), /alpha/);
  assert.match(by('STRUCTURE'), /A → B/);
  assert.match(by('GROUNDING'), /None on file/);
  assert.match(by('CAUTION'), /Stay short/);
  assert.ok(!by('HINTS').includes('**'), 'emphasis stripped');
});
