// Shared helpers for end-to-end suites (plain Node, no test framework needed).
const WebSocket = require('ws');

function createChecker() {
  let failures = 0;
  const check = (name, cond, detail = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    if (!cond) failures++;
  };
  return { check, get failures() { return failures; } };
}

function http(base) {
  return async function api(method, url, body, cookie) {
    const r = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = r.headers.get('set-cookie');
    return { status: r.status, body: await r.json().catch(() => null), cookie: setCookie ? setCookie.split(';')[0] : null, headers: r.headers };
  };
}

function wsClient(port, view = 'room') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/?view=${view}`);
    const inbox = [];
    const all = [];
    const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      all.push(m);
      const w = waiters.find((x) => x.pred(m));
      if (w) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(m); } else inbox.push(m);
    });
    ws.on('open', () => resolve({
      ws, inbox, all,
      send: (o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o)),
      wait: (pred, ms = 30000) => new Promise((res, rej) => {
        const i = inbox.findIndex(pred);
        if (i >= 0) return res(inbox.splice(i, 1)[0]);
        const w = { pred, resolve: res };
        w.t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout waiting')); }, ms);
        waiters.push(w);
      }),
    }));
    ws.on('error', reject);
  });
}

const type = (t) => (m) => m.type === t;
const keyOf = (u) => new URL(u).searchParams.get('key');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function finish(checker) {
  console.log(checker.failures ? `\n${checker.failures} FAILED` : '\nALL PASSED');
  process.exit(checker.failures ? 1 : 0);
}

module.exports = { createChecker, http, wsClient, type, keyOf, sleep, finish };
