import { test, expect, type ConsoleMessage } from '@playwright/test';

// Robot controller browser e2e. By default the AG-UI server runs a deterministic
// scripted model (PUKEKO_FAKE_LLM=1) that calls move_forward then finish_task, so
// these assertions are CI-stable. With E2E_LIVE=1 the harness uses a real LLM —
// the same flow still holds (the agent is prompted to move once and finish).
test.describe('Robot Controller (browser)', () => {
  let consoleErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    page.on('console', (m: ConsoleMessage) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    await page.goto('/');
    await expect(page.locator('.chat-interface')).toBeVisible();
  });

  test('drives a motion tool round-trip and finalizes', async ({ page }) => {
    const input = page.locator('input[name="chat-input"]');
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

    // The run reaches its terminal tool and finalizes (no lingering stream).
    await expect(
      page.locator('.tool-call-badge', { hasText: 'finish_task' })
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.message.ai.streaming')).toHaveCount(0, { timeout: 15_000 });

    // The 0.0.56 fetch regression (and any send failure) would surface here.
    const fatal = consoleErrors.filter((e) =>
      /Illegal invocation|Error sending message|Agent execution failed/i.test(e)
    );
    expect(fatal, `unexpected console errors:\n${fatal.join('\n')}`).toHaveLength(0);
  });
});
