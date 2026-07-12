import { defineConfig, devices } from '@playwright/test';

// Browser e2e for the robot controller. The harness (it-robot.js) boots the
// robot stub + AG-UI server + Vite; Playwright drives a real Chromium with a
// FAKE camera/mic so the webcam-capture + Before/After compose path runs without
// hardware. See e2e/robot.spec.ts.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    // OPS-8: track the shifted vite dev port (WEB_PORT); it-robot.js loads `.env`.
    baseURL: `http://localhost:${process.env.WEB_PORT || 5173}`,
    permissions: ['camera'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
