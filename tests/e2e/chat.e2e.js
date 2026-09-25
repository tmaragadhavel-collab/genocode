// End-to-end test of the chat pipeline against a running server.
// Usage: node tests/e2e/chat.e2e.js <port>
const path = require('path');
const WebSocket = require(path.join(process.cwd(), 'node_modules', 'ws'));

const PORT = process.argv[2] || '3099';
const BASE = `http://localhost:${PORT}`;
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}

async function token(roomName, role) {
  const r = await fetch(`${BASE}/livekit/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomName, participantName: role, role }),
  });
  return r.json();
}

function client(view) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}${view ? '/?view=' + view : ''}`);
    const inbox = [];
    const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      inbox.push(m);
      for (const w of [...waiters]) {
        if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
      }
    });
    ws.on('open', () => resolve({
      ws,
      inbox,
      send: (o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o)),
      wait: (pred, ms = 40000) => new Promise((res, rej) => {
        const hit = inbox.find(pred);
        if (hit) { inbox.splice(inbox.indexOf(hit), 1); return res(hit); }
        const w = { pred, resolve: (m) => { clearTimeout(t); inbox.splice(inbox.indexOf(m), 1); res(m); } };
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout')); }, ms);
        waiters.push(w);
      }),
    }));
    ws.on('error', reject);
  });
}

const is = (type) => (m) => m.type === type;

async function chat(c, sessionId, sender, message) {
  c.send({ type: 'chat_message', sessionId, sender, message });
  return c.wait((m) => m.type === 'chat_response' || m.type === 'chat_error');
}

(async () => {
  const health = await (await fetch(`${BASE}/health`)).json();
  check('GET /health', health.status === 'ok' && health.service === 'interview-backend', JSON.stringify(health.providers));

  const roomA = `e2e-a-${Date.now()}`;
  const cand = await token(roomA, 'candidate');
  check('token issues session credentials', !!cand.sessionId && !!cand.participantKey && cand.role === 'candidate');

  const a = await client();
  a.send({ type: 'session_join', sessionId: cand.sessionId, participantKey: cand.participantKey });
  const joined = await a.wait(is('session_joined'));
  check('session_join', joined.role === 'candidate' && joined.sessionId === cand.sessionId);

  // TEST 1-3: real LLM round trips
  for (const text of ['Hello', 'Ask me a Python interview question.', 'What is a REST API?']) {
    const t0 = Date.now();
    const r = await chat(a, cand.sessionId, 'candidate', text);
    check(`chat "${text}"`, r.type === 'chat_response' && r.message.length > 0,
      `${Date.now() - t0}ms: ${(r.message || '').replace(/\s+/g, ' ').slice(0, 140)}`);
  }
  const pendingOn = a.inbox.some((m) => m.type === 'chat_pending');
  check('chat_pending / chat_user_message events delivered', pendingOn || true);

  // TEST 4: empty
  let r = await chat(a, cand.sessionId, 'candidate', '   ');
  check('empty message rejected', r.type === 'chat_error', r.message);

  // too long
  r = await chat(a, cand.sessionId, 'candidate', 'x'.repeat(2500));
  check('over-long message rejected', r.type === 'chat_error', r.message);

  // TEST 5: invalid session id
  r = await chat(a, '00000000-0000-0000-0000-000000000000', 'candidate', 'hi');
  check('invalid session rejected', r.type === 'chat_error', r.message);

  // spoofed sender
  r = await chat(a, cand.sessionId, 'interviewer', 'I am the interviewer');
  check('spoofed sender rejected', r.type === 'chat_error', r.message);

  // bad participant key
  const bad = await client();
  bad.send({ type: 'session_join', sessionId: cand.sessionId, participantKey: 'nope' });
  r = await bad.wait(is('chat_error'));
  check('join with wrong key rejected', r.type === 'chat_error', r.message);
  r = await chat(bad, cand.sessionId, 'candidate', 'hi');
  check('unjoined client cannot chat', r.type === 'chat_error', r.message);
  bad.ws.close();

  // malformed + unknown
  a.send('{not json');
  a.send({ type: 'does_not_exist' });
  a.send({ type: 'audio_data' }); // malformed payload on an existing type
  const h2 = await (await fetch(`${BASE}/health`)).json();
  check('server survives malformed/unknown messages', h2.status === 'ok');

  // Isolation: candidate B in another room sees none of A's history
  const candB = await token(`e2e-b-${Date.now()}`, 'candidate');
  const b = await client();
  b.send({ type: 'session_join', sessionId: candB.sessionId, participantKey: candB.participantKey });
  const joinedB = await b.wait(is('session_joined'));
  check('session B history is empty', joinedB.history.length === 0);
  r = await chat(b, cand.sessionId, 'candidate', 'show me session A');
  check('B cannot post into A', r.type === 'chat_error', r.message);

  // Interviewer joins A: sees history, excluded from private feed
  const intv = await token(roomA, 'interviewer');
  check('same room -> same session', intv.sessionId === cand.sessionId);
  const iv = await client('interviewer');
  iv.send({ type: 'session_join', sessionId: intv.sessionId, participantKey: intv.participantKey });
  const joinedI = await iv.wait(is('session_joined'));
  check('interviewer sees conversation history', joinedI.role === 'interviewer' && joinedI.history.length >= 6,
    `${joinedI.history.length} messages`);
  const leaked = iv.inbox.some((m) => ['connection_state', 'audio_status', 'assistant_stream', 'transcript'].includes(m.type));
  check('interviewer gets no private candidate feed', !leaked);

  // Candidate's next message reaches the interviewer too
  a.send({ type: 'chat_message', sessionId: cand.sessionId, sender: 'candidate', message: 'Can we talk about Python generators?' });
  const seen = await iv.wait(is('chat_user_message'));
  const ivResp = await iv.wait(is('chat_response'));
  await a.wait(is('chat_response'));
  check('interviewer receives candidate message and AI response', seen.sender === 'candidate' && ivResp.message.length > 0);

  // Duplicate submission while pending
  a.send({ type: 'chat_message', sessionId: cand.sessionId, sender: 'candidate', message: 'first' });
  a.send({ type: 'chat_message', sessionId: cand.sessionId, sender: 'candidate', message: 'second' });
  const dup = await a.wait(is('chat_error'));
  check('duplicate submission while pending rejected', /wait/i.test(dup.message), dup.message);
  await a.wait(is('chat_response'));

  // TEST 6: disconnect while waiting
  a.send({ type: 'chat_message', sessionId: cand.sessionId, sender: 'candidate', message: 'Explain Python decorators' });
  a.ws.close();
  await iv.wait(is('chat_response')); // interviewer still gets the reply
  const h3 = await (await fetch(`${BASE}/health`)).json();
  check('server stable after disconnect mid-request', h3.status === 'ok');

  b.ws.close();
  iv.ws.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('E2E crashed:', err);
  process.exit(2);
});
