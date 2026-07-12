#!/usr/bin/env node
// Robot-controller browser e2e harness. Boots three processes, waits for them,
// runs Playwright (e2e/robot.spec.ts), then tears everything down.
//
//   robot stub        :8080  (motion endpoints + CORS)
//   AG-UI server      :3000  deterministic scripted model by default
//                            (PUKEKO_FAKE_LLM=1); set E2E_LIVE=1 for a real LLM
//   Vite web client   :5173  AGUI_URL -> :3000, VITE_ROBOT_HOST -> :8080
//
// Usage:  node it-robot.js            (deterministic, CI-stable)
//         E2E_LIVE=1 node it-robot.js (opt-in live LLM smoke; needs an API key)
import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// OPS-8: load the worktree-root `.env` so a shifted allocation moves every port
// together. Inline env vars still win (loadEnvFile does not clobber process.env).
try { process.loadEnvFile(resolve(__dirname, '.env')); } catch { /* no .env: use defaults */ }

const LIVE = process.env.E2E_LIVE === '1';
const STUB_PORT = process.env.ROBOT_STUB_PORT || '8080';
const AGUI_PORT = process.env.AGUI_PORT || '3000';
const WEB_PORT = process.env.WEB_PORT || '5173';
const ROBOT_HOST = `localhost:${STUB_PORT}`;
const READY_TIMEOUT_MS = 60_000;

function log(file) {
  return createWriteStream(resolve(__dirname, file), { flags: 'w' });
}

function startStub() {
  const proc = spawn('npm', ['run', 'stub'], {
    cwd: __dirname,
    env: { ...process.env, ROBOT_STUB_PORT: STUB_PORT },
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: true,
  });
  const out = log('it-robot-stub.log');
  proc.stdout.on('data', (d) => out.write(d));
  proc.stderr.on('data', (d) => out.write(d));
  return proc;
}

function startServer() {
  const env = { ...process.env, ROBOT_HOST };
  if (LIVE) {
    env.LLM_PROVIDER = env.LLM_PROVIDER || 'anthropic';
    env.ANTHROPIC_MODEL = env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
    delete env.PUKEKO_FAKE_LLM;
  } else {
    env.PUKEKO_FAKE_LLM = '1';
  }
  console.log(`[it-robot] AG-UI server model: ${LIVE ? 'LIVE (' + env.LLM_PROVIDER + ')' : 'scripted fake'}`);
  const proc = spawn('npm', ['run', 'server'], {
    cwd: __dirname,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: true,
  });
  const out = log('it-robot-server.log');
  proc.stdout.on('data', (d) => out.write(d));
  proc.stderr.on('data', (d) => out.write(d));
  return proc;
}

function startWeb() {
  const proc = spawn('npm', ['run', 'dev:ag-ui'], {
    cwd: __dirname,
    env: { ...process.env, VITE_ROBOT_HOST: ROBOT_HOST },
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: true,
  });
  const out = log('it-robot-web.log');
  proc.stdout.on('data', (d) => out.write(d));
  proc.stderr.on('data', (d) => out.write(d));
  return proc;
}

async function waitForUrl(url, label) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  process.stdout.write(`Waiting for ${label} (${url})`);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) {
        console.log(' ready');
        return;
      }
    } catch {
      /* not up yet */
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label} not ready within ${READY_TIMEOUT_MS / 1000}s`);
}

function killGroup(proc) {
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

const procs = [startStub(), startServer(), startWeb()];
function cleanup() {
  console.log('\n[it-robot] stopping services...');
  procs.forEach(killGroup);
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

let code = 1;
try {
  await Promise.all([
    waitForUrl(`http://${ROBOT_HOST}/`, 'robot stub'),
    waitForUrl(`http://localhost:${AGUI_PORT}/health`, 'AG-UI server'),
    waitForUrl(`http://localhost:${WEB_PORT}/`, 'web client'),
  ]);
  console.log('\n[it-robot] running Playwright...\n');
  code = await new Promise((res) => {
    const t = spawn('npx', ['playwright', 'test', ...process.argv.slice(2)], {
      cwd: __dirname,
      stdio: 'inherit',
    });
    t.on('close', res);
    t.on('error', (e) => { console.error(e.message); res(1); });
  });
} catch (err) {
  console.error(`\n[it-robot] aborted: ${err.message}`);
} finally {
  cleanup();
}
process.exit(code);
