// RC-12 measurement harness — the emulator twin of it-robot.js.
//
// it-robot.js boots the robot STUB and points the browser at it. The stub has no
// camera, so its `capture_image` comes from Chromium's fake webcam. That is the
// wrong instrument for RC-12: the cost pathology is about real image bytes moving
// through the Before/After composite and accumulating in history, and a fake
// camera frame is not the frame a session actually carries.
//
// This harness boots the grid-world EMULATOR instead, which serves a real
// rendered JPEG from `GET /capture`. In the simulated world `captureUrlForWorld`
// sources BOTH composite frames from that endpoint, so Chromium's fake camera is
// out of the loop entirely and the composite is made of emulator pixels.
//
//   robot emulator  :8081  (motion endpoints + GET /capture, real JPEG)
//   AG-UI server    :3000  (live Anthropic, sonnet — see pukeko.config.ts)
//   Vite web client :5173  VITE_ROBOT_EMULATOR_HOST -> :8081
//
// Usage: node rc12-measure.js
// Every run is live and spends real Anthropic credit; there is no fake-LLM mode
// here on purpose, because a scripted model produces no usage_metadata worth
// reading.

import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

try {
  process.loadEnvFile(resolve(__dirname, '.env'))
} catch {
  /* no .env: use defaults */
}

const EMULATOR_PORT = process.env.ROBOT_EMULATOR_PORT || '8081'
const AGUI_PORT = process.env.AGUI_PORT || '3000'
const WEB_PORT = process.env.WEB_PORT || '5173'
const EMULATOR_HOST = `localhost:${EMULATOR_PORT}`
const READY_TIMEOUT_MS = 60_000

const RUN_ID = process.env.RC12_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-')
const DUMP_DIR = resolve(__dirname, 'logs', `rc12-${RUN_ID}`)
mkdirSync(DUMP_DIR, { recursive: true })

function log(file) {
  return createWriteStream(resolve(__dirname, file), { flags: 'w' })
}

function pipe(proc, file) {
  const out = log(file)
  proc.stdout.on('data', (d) => out.write(d))
  proc.stderr.on('data', (d) => out.write(d))
  return proc
}

function startEmulator() {
  return pipe(
    spawn('npm', ['run', 'emulator'], {
      cwd: __dirname,
      env: { ...process.env, ROBOT_EMULATOR_PORT: EMULATOR_PORT },
      stdio: ['inherit', 'pipe', 'pipe'],
      detached: true,
    }),
    'rc12-emulator.log',
  )
}

function startServer() {
  const env = {
    ...process.env,
    // The agent's own motion tools still need a host; in the simulated world the
    // BROWSER does the driving, but the server-side tool definitions are built
    // against this and a missing value is a startup error, not a no-op.
    ROBOT_HOST: EMULATOR_HOST,
    PUKEKO_PROFILE: 'anthropic',
    PUKEKO_DUMP_DIR: DUMP_DIR,
    PUKEKO_VERBOSE: '1',
  }
  delete env.PUKEKO_FAKE_LLM
  console.log(`[rc12] AG-UI server: LIVE anthropic, dumps -> ${DUMP_DIR}`)
  return pipe(
    spawn('npm', ['run', 'server'], {
      cwd: __dirname,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
      detached: true,
    }),
    'rc12-server.log',
  )
}

function startWeb() {
  return pipe(
    spawn('npm', ['run', 'dev:ag-ui'], {
      cwd: __dirname,
      env: { ...process.env, VITE_ROBOT_EMULATOR_HOST: EMULATOR_HOST },
      stdio: ['inherit', 'pipe', 'pipe'],
      detached: true,
    }),
    'rc12-web.log',
  )
}

async function waitForUrl(url, label) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  process.stdout.write(`Waiting for ${label} (${url})`)
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 404) {
        console.log(' ready')
        return
      }
    } catch {
      /* not up yet */
    }
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`${label} not ready within ${READY_TIMEOUT_MS / 1000}s`)
}

function killGroup(proc) {
  try {
    process.kill(-proc.pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
}

const procs = [startEmulator(), startServer(), startWeb()]
function cleanup() {
  console.log('\n[rc12] stopping services...')
  procs.forEach(killGroup)
}
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})
process.on('SIGTERM', () => {
  cleanup()
  process.exit(143)
})

let code = 1
try {
  await Promise.all([
    waitForUrl(`http://${EMULATOR_HOST}/status`, 'robot emulator'),
    waitForUrl(`http://localhost:${AGUI_PORT}/health`, 'AG-UI server'),
    waitForUrl(`http://localhost:${WEB_PORT}/`, 'web client'),
  ])
  console.log('\n[rc12] running the measurement session...\n')
  code = await new Promise((res) => {
    const t = spawn(
      resolve(__dirname, 'node_modules/.bin/playwright'),
      ['test', 'e2e/rc12-measure.spec.ts', ...process.argv.slice(2)],
      { cwd: __dirname, stdio: 'inherit', env: { ...process.env, RC12_DUMP_DIR: DUMP_DIR } },
    )
    t.on('close', res)
    t.on('error', (e) => {
      console.error(e.message)
      res(1)
    })
  })
} catch (err) {
  console.error(`\n[rc12] aborted: ${err.message}`)
} finally {
  cleanup()
}
console.log(`\n[rc12] dumps in ${DUMP_DIR}`)
process.exit(code)
