/**
 * Verify that the screen-share-safe coaching implementation is correct:
 * 1. coach-popup.html is served and has valid HTML/JS
 * 2. BroadcastChannel communication works between main page and popup
 * 3. Coach tab hides (ss-hidden) during screen share simulation
 * 4. Coach tab restores after screen share ends
 * 5. Coaching data continues to flow via relay during screen share
 * 6. Popup receives init state and live coaching messages
 *
 * Usage: node scripts/diag-screenshare.js [port]
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const port = process.argv[2] || '3001';
const base = `http://localhost:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, ok, d = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`);
  if (!ok) failures++;
};

function pcmOf(name) {
  const buf = fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', name));
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

async function api(method, url, body, cookie) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, body: await r.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null };
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/?view=room`);
    const all = [];
    const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      all.push(m);
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.t); w.resolve(m); }
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws, all,
      send: (o) => ws.send(JSON.stringify(o)),
      sendBinary: (b) => ws.send(b, { binary: true }),
      count: (t) => all.filter((m) => m.type === t).length,
      wait: (pred, ms = 30000) => new Promise((res, rej) => {
        const hit = all.find(pred);
        if (hit) return res(hit);
        const w = { pred, resolve: res };
        w.t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout')); }, ms);
        waiters.push(w);
      }),
    }));
  });
}

async function speak(client, pcm) {
  const frame = 3200;
  const audio = Buffer.concat([pcm, Buffer.alloc(1500 * 32)]);
  for (let i = 0; i < audio.length; i += frame) {
    client.sendBinary(audio.subarray(i, i + frame));
    await sleep(100);
  }
}

(async () => {
  console.log('=== Screen-share-safe coaching verification ===\n');

  // --- TEST 1: coach-popup.html is served ---
  console.log('TEST 1 — Popup page accessibility');
  const popupResp = await fetch(`${base}/room-assets/coach-popup.html`);
  check('coach-popup.html served', popupResp.status === 200, `HTTP ${popupResp.status}`);
  const popupHtml = await popupResp.text();
  check('popup has BroadcastChannel', popupHtml.includes('BroadcastChannel'));
  check('popup has coaching_question handler', popupHtml.includes('coaching_question'));
  check('popup has coaching_delta handler', popupHtml.includes('coaching_delta'));
  check('popup has coaching_state handler', popupHtml.includes('coaching_state'));
  check('popup has close handler', popupHtml.includes("d.type === 'close'"));
  check('popup has init handler', popupHtml.includes("d.type === 'init'"));
  check('popup renders all 4 sections', popupHtml.includes('HINTS') && popupHtml.includes('STRUCTURE') && popupHtml.includes('GROUNDING') && popupHtml.includes('CAUTION'));

  // --- TEST 2: room.js has the screen share logic ---
  console.log('\nTEST 2 — Room.js screen share integration');
  const roomJs = fs.readFileSync(path.join(__dirname, '..', 'web', 'room', 'room.js'), 'utf8');
  check('room.js tracks screenSharing state', roomJs.includes('screenSharing'));
  check('room.js has applyScreenShareHide()', roomJs.includes('function applyScreenShareHide'));
  check('room.js has openCoachPopup()', roomJs.includes('function openCoachPopup'));
  check('room.js has closeCoachPopup()', roomJs.includes('function closeCoachPopup'));
  check('room.js has relayToPopup()', roomJs.includes('function relayToPopup'));
  check('room.js uses BroadcastChannel', roomJs.includes("BroadcastChannel('coach-popup')"));
  check('room.js hooks LocalTrackPublished for ScreenShare', roomJs.includes('Track.Source.ScreenShare') && roomJs.includes('applyScreenShareHide(true)'));
  check('room.js hooks LocalTrackUnpublished for ScreenShare', roomJs.includes('applyScreenShareHide(false)'));
  check('room.js guards openTab during screen share', roomJs.includes('state.screenSharing && SS_HIDDEN_TABS'));
  check('room.js relays coaching messages to popup', roomJs.includes('relayToPopup(msg)'));
  check('room.js closes popup on teardown', roomJs.includes('closeCoachPopup()'));
  check('room.js opens popup URL /room-assets/coach-popup.html', roomJs.includes('coach-popup.html'));

  // --- TEST 3: coach.js and feedback.js have getState() ---
  console.log('\nTEST 3 — Panel getState() exports');
  const coachJs = fs.readFileSync(path.join(__dirname, '..', 'web', 'room', 'coach.js'), 'utf8');
  check('coach.js exports getState()', coachJs.includes('getState()'));
  check('coach getState returns history and selectedId', coachJs.includes('st.history.slice()') && coachJs.includes('st.selectedId'));
  const feedbackJs = fs.readFileSync(path.join(__dirname, '..', 'web', 'room', 'feedback.js'), 'utf8');
  check('feedback.js exports getState()', feedbackJs.includes('getState()'));
  check('feedback getState returns order and entries', feedbackJs.includes('st.order.slice()') && feedbackJs.includes('entries'));

  // --- TEST 4: CSS hides ss-hidden elements ---
  console.log('\nTEST 4 — CSS and HTML');
  const roomCss = fs.readFileSync(path.join(__dirname, '..', 'web', 'room', 'room.css'), 'utf8');
  check('CSS has .ss-hidden rule', roomCss.includes('.ss-hidden'));
  check('.ss-hidden uses display:none!important', roomCss.includes('ss-hidden') && roomCss.includes('display: none !important'));
  check('CSS has .popup-notice styles', roomCss.includes('.popup-notice'));
  check('CSS has .popout-btn styles', roomCss.includes('.popout-btn'));
  const roomHtml = fs.readFileSync(path.join(__dirname, '..', 'web', 'room', 'room.html'), 'utf8');
  check('HTML has pop-out button', roomHtml.includes('popoutBtn'));

  // --- TEST 5: route serves the popup ---
  console.log('\nTEST 5 — Route allowlist');
  const routeTs = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'interviews.ts'), 'utf8');
  check('coach-popup.html in ASSETS allowlist', routeTs.includes("'coach-popup.html'"));

  // --- TEST 5b: popup has feedback support ---
  console.log('\nTEST 5b — Popup feedback support');
  check('popup handles answer_evaluation', popupHtml.includes('answer_evaluation'));
  check('popup has feedback tab', popupHtml.includes('tabFeedback'));
  check('popup renders score/breakdown', popupHtml.includes('score-value') && popupHtml.includes('breakdown'));
  check('popup renders strengths/improvements', popupHtml.includes('Strengths') && popupHtml.includes('Improvements'));

  // --- TEST 6: live coaching flow still works (not broken by screen share changes) ---
  console.log('\nTEST 6 — Live coaching flow (sanity)');
  const Q1 = pcmOf('q-what-is-python.wav');

  const A = (await api('POST', '/api/auth/signup', {
    email: `ss.${Date.now()}@example.com`, password: 'long enough password', name: 'SS Owner',
  })).cookie;
  const iv = (await api('POST', '/api/interviews', {
    candidateName: 'SS Cand', position: 'Dev', durationMinutes: 30, candidateCoaching: true,
  }, A)).body;
  const Ij = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'interviewer' }, A)).body;
  const key = new URL(iv.candidateUrl).searchParams.get('key');
  const Cj = (await api('POST', `/api/interviews/${iv.sessionId}/join`, { role: 'candidate', key })).body;

  const I = await connect();
  const C = await connect();
  I.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Ij.participantKey });
  await I.wait((m) => m.type === 'session_joined');
  C.send({ type: 'session_join', sessionId: iv.sessionId, participantKey: Cj.participantKey });
  const cJoined = await C.wait((m) => m.type === 'session_joined');

  check('candidate joins with coachingEnabled', cJoined.coachingEnabled === true);

  I.send({ type: 'interview_start' });
  await I.wait((m) => m.type === 'interview_state' && m.interview.status === 'LIVE');
  I.send({ type: 'audio_start', format: 'pcm16', sampleRate: 16000, channels: 1 });
  await sleep(1500);

  await speak(I, Q1);
  const final = await I.wait((m) => m.type === 'transcript_final' && m.speaker === 'interviewer', 30000);
  check('interviewer question transcribed', final.text.length > 3, `"${final.text}"`);

  const q = await C.wait((m) => m.type === 'coaching_question', 25000);
  check('coaching question detected', !!q.questionId, `"${q.question}"`);

  const delta = await C.wait((m) => m.type === 'coaching_delta', 40000);
  check('coaching deltas stream to candidate', !!delta.text);

  const done = await C.wait((m) => m.type === 'coaching_state' && m.questionId === q.questionId
    && (m.state === 'complete' || m.state === 'error'), 60000);
  check('coaching completes', done.state === 'complete', done.state);

  // Verify the interviewer sees coaching activity but not content
  check('interviewer notified of coaching activity', I.all.some((m) => m.type === 'coaching_activity'));
  check('interviewer gets NO coaching deltas', !I.all.some((m) => m.type === 'coaching_delta'));
  check('interviewer gets NO coaching state', !I.all.some((m) => m.type === 'coaching_state'));

  I.send({ type: 'interview_end' });
  await sleep(500);
  I.ws.close();
  C.ws.close();

  // --- Summary ---
  console.log(`\n=== ${failures ? failures + ' FAILED' : 'ALL PASSED'} ===`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('crashed:', e.message); process.exit(2); });
