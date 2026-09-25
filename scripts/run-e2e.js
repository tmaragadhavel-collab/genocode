// End-to-end test runner: fresh SQLite database, real server processes,
// a hard kill + restart between phases to test recovery.
// Usage: npm run test:e2e
// AI keys are blanked (demo mode) and speech-to-text goes to a local fake
// Whisper, so results are deterministic; the real providers are exercised by
// `npm run eval:sample` / `npm run stt:sample`.
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = String(process.env.E2E_PORT || 3197);
const whisperPort = Number(port) + 1;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-e2e-'));
const db = `file:${path.join(tmp, 'e2e.db').split(path.sep).join('/')}`;
const env = {
  ...process.env,
  DATABASE_URL: db,
  SERVER_PORT: port,
  // Empty values win over .env (dotenv never overrides existing variables).
  LLM_API_KEY: '', AI_API_KEY: '', GEMINI_API_KEY: '', LLM_FALLBACK_PROVIDER: '',
  STT_PROVIDER: 'groq', STT_API_KEY: 'fake', STT_BASE_URL: `http://127.0.0.1:${whisperPort}/v1`, DEEPGRAM_API_KEY: '',
};

// Fake OpenAI-compatible transcription endpoint. POST /control with ok|low|fail switches behaviour.
let whisperMode = 'ok';
const fakeWhisper = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    // Fake LLM endpoint for the failure phase: always overloaded.
    if (req.url.endsWith('/chat/completions')) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fake LLM outage' } }));
      return;
    }
    if (req.url === '/control') {
      whisperMode = body.trim();
      res.end('ok');
      return;
    }
    if (whisperMode === 'fail') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fake outage' } }));
      return;
    }
    const low = whisperMode === 'low';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      text: whisperMode === 'question'
        ? 'Can you explain how virtual memory works?'
        : 'A process is an executing program and threads in the same process share memory.',
      segments: [{ start: 0, end: 5, avg_logprob: low ? -1.3 : -0.15, no_speech_prob: low ? 0.2 : 0.01 }],
    }));
  });
});

let server = null;
let results = [];

async function startServer(label, extraEnv = {}) {
  const log = fs.openSync(path.join(tmp, `server-${label}.log`), 'a');
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, env: { ...env, ...extraEnv }, stdio: ['ignore', log, log] });
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) return;
    } catch { /* not up yet */ }
  }
  throw new Error(`server did not start (see ${path.join(tmp, `server-${label}.log`)})`);
}

async function killServer() {
  if (!server) return;
  const s = server;
  server = null;
  s.kill('SIGKILL'); // hard kill: no graceful flush, like a crash
  await new Promise((r) => s.once('exit', r));
}

// Async so the in-process fake Whisper server keeps serving while a suite runs.
async function suite(name, file, ...args) {
  console.log(`\n=== ${name} ===`);
  const child = spawn(process.execPath, [path.join(root, 'tests', 'e2e', file), port, ...args], { cwd: root, stdio: 'inherit' });
  const r = { status: await new Promise((res) => child.once('exit', res)) };
  results.push([name, r.status === 0]);
}

(async () => {
  console.log(`[e2e] temp dir ${tmp}`);
  await new Promise((r) => fakeWhisper.listen(whisperPort, '127.0.0.1', r));
  execSync('node scripts/db-setup.js --skip-generate', { cwd: root, env, stdio: 'ignore' });
  const state = (n) => path.join(tmp, `${n}.json`);

  await startServer('1');
  await suite('workflow', 'workflow.e2e.js', 'main', state('workflow'));
  await suite('chat', 'chat.e2e.js');
  await suite('speech-to-text', 'stt.e2e.js', `http://127.0.0.1:${whisperPort}/control`);
  await suite('answer boundaries', 'boundaries.e2e.js', `http://127.0.0.1:${whisperPort}/control`);
  await suite('transcript correction', 'corrections.e2e.js', `http://127.0.0.1:${whisperPort}/control`);
  await suite('restore (before crash)', 'restore.e2e.js', 'before', state('restore'));
  await killServer();

  await startServer('2');
  await suite('workflow persistence after restart', 'workflow.e2e.js', 'persist', state('workflow'));
  await suite('restore (after crash)', 'restore.e2e.js', 'after', state('restore'));
  await killServer();

  // Phase 3: the LLM provider is down (503 on every call, so retries run and fail).
  await startServer('3', {
    LLM_PROVIDER: 'groq', LLM_API_KEY: 'fake', LLM_MODEL: 'fake-model',
    LLM_BASE_URL: `http://127.0.0.1:${whisperPort}/v1`, LLM_TIMEOUT_MS: '3000',
  });
  await suite('LLM failure → interview continues', 'llm-failure.e2e.js');
  await killServer();
  fakeWhisper.close();

  console.log('\n=== Summary ===');
  for (const [name, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed ? `\n${failed} suite(s) failed. Server logs: ${tmp}` : '\nAll suites passed.');
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('[e2e]', err.message);
  await killServer();
  process.exit(2);
});
