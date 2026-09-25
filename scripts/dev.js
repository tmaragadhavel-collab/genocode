const { spawn } = require('child_process');
const path = require('path');

delete process.env.ELECTRON_RUN_AS_NODE;

const isWin = process.platform === 'win32';
const npx = isWin ? 'npx.cmd' : 'npx';

const serverProc = spawn(npx, ['tsx', path.join('server', 'index.ts')], {
  stdio: 'inherit',
  env: { ...process.env, SERVER_PORT: '3001' },
  cwd: process.cwd(),
  shell: isWin,
});

setTimeout(() => {
  const viteProc = spawn(npx, ['electron-vite', 'dev'], {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd(),
    shell: isWin,
  });

  viteProc.on('close', (code) => {
    serverProc.kill();
    process.exit(code || 0);
  });
}, 2000);

serverProc.on('close', (code) => {
  if (code && code !== 0) {
    console.error(`Server exited with code ${code}`);
  }
});

process.on('SIGINT', () => {
  serverProc.kill();
  process.exit(0);
});

process.on('SIGTERM', () => {
  serverProc.kill();
  process.exit(0);
});
