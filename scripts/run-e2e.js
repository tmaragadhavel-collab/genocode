// End-to-end test runner: fresh SQLite database, real server processes,
// a hard kill + restart between phases to test recovery.
// Usage: npm run test:e2e
// AI and STT keys are blanked so results are deterministic (demo mode);
// the real providers are exercised by `npm run eval:sample` / `npm run stt:sample`.
const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = String(process.env.E2E_PORT || 3197);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-e2e-'));
const db = `file:${path.join(tmp, 'e2e.db').split(path.sep).join('/')}`;
const env = {
  ...process.env,
  DATABASE_URL: db,
  SERVER_PORT: port,
  // Empty values win over .env (dotenv never overrides existing variables).
  LLM_API_KEY: '', AI_API_KEY: '', GEMINI_API_KEY: '', LLM_FALLBACK_PROVIDER: '',
  STT_PROVIDER: 'none', DEEPGRAM_API_KEY: '', STT_API_KEY: '',
};

let server = null;
let results = [];

async function startServer(label) {
  const log = fs.openSync(path.join(tmp, `server-${label}.log`), 'a');
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: root, env, stdio: ['ignore', log, log] });
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

function suite(name, file, ...args) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, [path.join(root, 'tests', 'e2e', file), port, ...args], { cwd: root, stdio: 'inherit' });
  results.push([name, r.status === 0]);
}

(async () => {
  console.log(`[e2e] temp dir ${tmp}`);
  execSync('node scripts/db-setup.js --skip-generate', { cwd: root, env, stdio: 'ignore' });
  const state = (n) => path.join(tmp, `${n}.json`);

  await startServer('1');
  suite('workflow', 'workflow.e2e.js', 'main', state('workflow'));
  suite('chat', 'chat.e2e.js');
  suite('restore (before crash)', 'restore.e2e.js', 'before', state('restore'));
  await killServer();

  await startServer('2');
  suite('workflow persistence after restart', 'workflow.e2e.js', 'persist', state('workflow'));
  suite('restore (after crash)', 'restore.e2e.js', 'after', state('restore'));
  await killServer();

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
