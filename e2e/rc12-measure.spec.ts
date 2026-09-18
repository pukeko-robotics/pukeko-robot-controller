import { test, expect } from '@playwright/test'

// RC-12 measurement session. This is NOT a pass/fail e2e test — it is a driver
// that produces a realistic multi-turn session so the observability dumps have
// something to measure. It asserts only the things that would invalidate the
// measurement if they were false; whether the robot actually reaches the target
// is irrelevant to the question being asked.
//
// WHY MANY TURNS. The question is whether per-turn input tokens grow linearly or
// quadratically once `keepLatestImages: 1` is doing its job. One round-trip
// cannot distinguish those — two points fit any curve. The navigation task is
// chosen because it makes the agent bracket its own motions with captures, which
// is exactly the loop that accumulated image bytes before the fix.
test('drives a multi-turn simulated session for RC-12 cost measurement', async ({ page }) => {
  // A live navigation session runs far past the suite's 60 s default.
  test.setTimeout(15 * 60 * 1000)

  await page.goto('/')
  await expect(page.locator('[data-testid="pk-headless-chat"]')).toBeVisible()

  // Drive the World picker exactly as a student would, rather than patching the
  // default: switching worlds re-instantiates RobotSession and remounts the chat,
  // and a measurement taken on a session that was built differently from a real
  // one is not measuring the real one.
  await page.locator('.world-picker__select').selectOption('simulated')
  await expect(page.locator('.world-picker__select')).toHaveValue('simulated')

  const input = page.locator('[data-testid="pk-headless-input"]')
  await input.fill(
    'You are in the simulated arena. Explore it and navigate to the green target area. ' +
      'Take an image first to see where you are, then move step by step, checking what ' +
      'you see as you go. Keep going until you reach the green area, then finish the task.',
  )
  await input.press('Enter')

  await expect(
    page.locator('.message.user', { hasText: 'simulated arena' }),
  ).toBeVisible()

  // Let the session run. It ends either when the agent calls finish_task or when
  // the deadline expires — both are fine, because the dumps are written per turn
  // as the run proceeds and do not depend on a clean finish.
  const finished = page.locator('.tool-call-badge', { hasText: 'finish_task' })
  const deadline = Date.now() + 13 * 60 * 1000
  while (Date.now() < deadline) {
    if ((await finished.count()) > 0) break
    // Still running? HeadlessChat shows a Stop button only while a run is in
    // flight, so its absence means the agent has stopped for some other reason
    // and there is nothing left to wait for.
    const running = await page
      .locator('[data-testid="pk-headless-chat"] .stop-button')
      .count()
    if (running === 0 && (await page.locator('.tool-call-badge').count()) > 0) break
    await page.waitForTimeout(5000)
  }

  const badges = await page.locator('.tool-call-badge').count()
  console.log(`[rc12] session ended with ${badges} tool badges`)
  // The only real assertion: the session actually exercised the tool loop. A run
  // that never called a tool produced no image turns and cannot answer anything.
  expect(badges).toBeGreaterThan(0)
})
