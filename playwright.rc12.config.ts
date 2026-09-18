import { defineConfig, devices } from '@playwright/test'

// RC-12 measurement session — its own config and its own test directory, on purpose.
//
// The measurement spec must NOT live in `e2e/`. `playwright.config.ts` sets
// `testDir: './e2e'`, so a spec dropped there is collected by `pnpm run e2e` —
// robot's deterministic browser gate, which boots the stub and a scripted fake
// model. This spec needs the emulator and a live Anthropic key and would sit
// there for its whole deadline before failing. Verified with `--list`: from
// `e2e/` the default run collects 2 tests where trunk collects 1.
//
// Keeping the split as a separate directory plus this config leaves
// `playwright.config.ts` and `e2e/` byte-identical to trunk, so the gate cannot
// be disturbed by anything here. `rc12-measure.js` passes `--config` explicitly.
export default defineConfig({
  testDir: './measure-e2e',
  // The spec sets its own deadline with test.setTimeout; this is only a ceiling
  // that must not cut a live navigation session short.
  timeout: 20 * 60 * 1000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.WEB_PORT || 5173}`,
    // The simulated world sources its frames from the emulator, not the camera —
    // but PkWebcamPanel stays mounted in every world because composeBeforeAfter
    // draws on its hidden canvas, so the fake-media flags stay to keep a real
    // camera prompt from ever blocking the run.
    permissions: ['camera'],
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
