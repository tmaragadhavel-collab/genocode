/**
 * Drives a live interview so a browser tab joined as the candidate receives real
 * coaching and answer feedback. The browser's own mic is blocked in the pane, so
 * a second candidate socket supplies the answer audio; role-scoped sends reach
 * every candidate connection, including the browser's.
 *
 * Usage: node scripts/diag-drive-room.js <port> <sessionId> <cookie> <question>
 */
const WebSocket = require('ws');

const [port, sessionId, cookie, candidateKey, question = 'Tell me about your most recent AI project.'] = process.argv.slice(2);
const base = `http://localhost:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ANSWER_TEXT = 'I built an AI career assistant using Python. It reads a resume, matches it against job descriptions, and drafts tailored applications. I used a retrieval step over the job corpus and an agent loop to call tools, and it cut application time from about an hour to five minutes.';

async function api(method, url, body) {
  const r = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/?view=room`);
    const all = []; const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()); all.push(m);
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.t); w.resolve(m); }
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws, all,
      send: (o) => ws.send(JSON.stringify(o)),
      sendBinary: (b) => ws.send(b, { binary: true }),
      wait: (pred, ms = 60000) => new Promise((res, rej) => {
        const hit = all.find(pred); if (hit) return res(hit);
        const w = { pred, resolve: res };
        w.t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout')); }, ms);
        waiters.push(w);
      }),
    }));
  });
}

(async () => {
  const Ij = (await api('POST', `/api/interviews/${sessionId}/join`, { role: 'interviewer' })).body;
  const Cj = (await api('POST', `/api/interviews/${sessionId}/join`, { role: 'candidate', key: candidateKey })).body;

  const I = await connect(); const C = await connect();
  I.send({ type: 'session_join', sessionId, participantKey: Ij.participantKey });
  await I.wait((m) => m.type === 'session_joined');
  C.send({ type: 'session_join', sessionId, participantKey: Cj.participantKey });
  await C.wait((m) => m.type === 'session_joined');

  const status = (await I.wait((m) => m.type === 'session_joined')).interview?.status;
  if (status !== 'LIVE') {
    I.send({ type: 'interview_start' });
    await I.wait((m) => m.type === 'interview_state' && m.interview.status === 'LIVE');
  }
  await sleep(500);

  console.log(`asking: "${question}"`);
  I.send({ type: 'question_start', questionText: question });
  const q = (await I.wait((m) => m.type === 'question_started')).question;

  // The browser tab already owns the candidate STT stream (one per role), so the
  // answer is injected as text through the interviewer's transcript channel.
  // Speech-to-text itself is covered by the STT and regression suites.
  console.log('candidate answering…');
  I.send({ type: 'transcript_final', speaker: 'candidate', text: ANSWER_TEXT });
  await I.wait((m) => m.type === 'transcript_final' && m.speaker === 'candidate' && m.questionId === q.questionId, 30000);

  I.send({ type: 'question_end' });
  const ev = await I.wait((m) => (m.type === 'evaluation_completed' || m.type === 'evaluation_error') && m.questionId === q.questionId, 90000);
  console.log(`evaluation: ${ev.type}${ev.score !== undefined ? ` score ${ev.score}` : ''}`);
  console.log(`questionId: ${q.questionId}`);

  await sleep(1500);
  I.ws.close(); C.ws.close();
})().catch((e) => { console.error('crashed:', e.message); process.exit(2); });
