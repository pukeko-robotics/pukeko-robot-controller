import { test, expect, type ConsoleMessage } from '@playwright/test';

// Robot controller browser e2e. By default the AG-UI server runs a deterministic
// scripted model (PUKEKO_FAKE_LLM=1) that calls capture_image, then move_forward,
// then finish_task, so these assertions are CI-stable. With E2E_LIVE=1 the
// harness uses a real LLM — the same flow still holds (the agent is prompted to
// move once and finish; live models routinely capture an image first, and the
// RC-14 image assertions below only run on badges that exist).
//
// PLAT-13: the Tutor chat is now vue-ui's headless CopilotKit surface
// (HeadlessChat inside a CopilotKitProvider) — selectors follow its
// data-testids; the tool badges are the same shared ToolCallBadge as before.
test.describe('Robot Controller (browser)', () => {
  let consoleErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    page.on('console', (m: ConsoleMessage) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    await page.goto('/');
    await expect(page.locator('[data-testid="pk-headless-chat"]')).toBeVisible();
  });

  test('drives a motion tool round-trip and finalizes', async ({ page }) => {
    const input = page.locator('[data-testid="pk-headless-input"]');
    await input.fill('Move forward one step, then finish the task.');
    await input.press('Enter');

    // User message echoed.
    await expect(
      page.locator('.message.user', { hasText: 'Move forward one step' })
    ).toBeVisible();

    // The motion client tool ran (browser fulfilled it: robot stub + webcam
    // capture + compose). ToolCallBadge label is "Used <name> tool".
    await expect(
      page.locator('.tool-call-badge', { hasText: 'move_forward' })
    ).toBeVisible({ timeout: 30_000 });

    // The run reaches its terminal tool and FINALIZES cleanly (RC-6: no
    // headless reintroduction of the returnDirect non-termination bug).
    await expect(
      page.locator('.tool-call-badge', { hasText: 'finish_task' })
    ).toBeVisible({ timeout: 30_000 });
    // Idle again: HeadlessChat renders its Stop button only while a run is in
    // flight — the headless equivalent of "no lingering .streaming bubble".
    await expect(
      page.locator('[data-testid="pk-headless-chat"] .stop-button')
    ).toHaveCount(0, { timeout: 15_000 });
    // No repeated/empty assistant bubbles after finalization (the RC-6
    // symptom): every rendered assistant bubble carries actual content.
    const aiBubbles = page.locator('.message.ai .message-content');
    for (let i = 0; i < (await aiBubbles.count()); i++) {
      await expect(aiBubbles.nth(i)).not.toBeEmpty();
    }
    // ...and the transcript has settled: exactly one finish_task badge, and no
    // new assistant bubbles appear after the run went idle.
    await expect(
      page.locator('.tool-call-badge', { hasText: 'finish_task' })
    ).toHaveCount(1);
    const settledCount = await page.locator('.message.ai').count();
    await page.waitForTimeout(1_500);
    expect(await page.locator('.message.ai').count()).toBe(settledCount);

    // ── RC-14: expanding the vision/motion tool calls shows the actual
    // pictures, not a base64 blob or a bare params line. ──────────────────

    // capture_image → inline thumbnail (the scripted model always calls it;
    // a live model usually does — only assert the thumbnail when the badge
    // exists so E2E_LIVE stays flake-free).
    const captureBadge = page.locator('.tool-call-badge', { hasText: 'capture_image' });
    if (process.env.E2E_LIVE !== '1' || (await captureBadge.count()) > 0) {
      await expect(captureBadge).toBeVisible();
      await captureBadge.locator('.tool-call-header').click();
      const thumb = captureBadge.locator('img.rc-tool-image');
      await expect(thumb).toBeVisible();
      expect(await thumb.getAttribute('src')).toMatch(/^data:image\//);

      // Click-to-enlarge round trip: lightbox opens with the frame, Esc closes.
      await thumb.click();
      const lightboxImg = page.locator('.rc-lightbox img');
      await expect(lightboxImg).toBeVisible();
      expect(await lightboxImg.getAttribute('src')).toMatch(/^data:image\//);
      await page.keyboard.press('Escape');
      await expect(page.locator('.rc-lightbox')).toHaveCount(0);
      // Collapse again so the motion badge is unambiguous below.
      await captureBadge.locator('.tool-call-header').click();
    }

    // Motion tool → the composed Before/After diff picture, inline.
    const motionBadge = page.locator('.tool-call-badge', { hasText: 'move_forward' });
    await motionBadge.locator('.tool-call-header').click();
    const diffImage = motionBadge.locator('img.rc-tool-image');
    await expect(diffImage).toBeVisible();
    expect(await diffImage.getAttribute('src')).toMatch(/^data:image\//);

    // The 0.0.56 fetch regression (and any send failure) would surface here.
    const fatal = consoleErrors.filter((e) =>
      /Illegal invocation|Error sending message|Agent execution failed/i.test(e)
    );
    expect(fatal, `unexpected console errors:\n${fatal.join('\n')}`).toHaveLength(0);
  });
});
