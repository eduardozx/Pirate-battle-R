import { expect, test } from '@playwright/test';

import { clickUntil, fastMatchUrl, gotoMenu } from './support/app';

/**
 * Match lifecycle: canvas, HUD, pause, restart, abandon, teardown.
 *
 * Everything here is deterministic — no gameplay outcome is asserted — because
 * this spec is about the shell around the simulation, not about balance.
 */

test.beforeEach(async ({ page }) => {
  await gotoMenu(page, fastMatchUrl(30, 1));
});

test('a match mounts exactly one canvas', async ({ page }) => {
  await page.getByTestId('play-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();

  await expect(page.locator('.game-canvas canvas')).toHaveCount(1);
  await expect(page.getByTestId('match-screen')).toBeVisible();
});

test('the HUD reflects the running match', async ({ page }) => {
  await page.getByTestId('play-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();

  const valueOf = async (id: string): Promise<string> =>
    (await page.getByTestId(id).locator('.hud__value').innerText()).trim();

  /* The clock runs from simulation time, not from a wall-clock interval. */
  const start = await valueOf('hud-timer');
  await expect.poll(() => valueOf('hud-timer'), { timeout: 5_000 }).not.toBe(start);

  await expect(page.getByTestId('hud-health')).toBeVisible();
  await expect(page.getByTestId('hud-score')).toBeVisible();
  expect(await valueOf('hud-score')).toMatch(/^\d+$/);
});

test('pause freezes the match and resumes it', async ({ page }) => {
  await page.getByTestId('play-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();

  const timer = async (): Promise<string> =>
    (await page.getByTestId('hud-timer').locator('.hud__value').innerText()).trim();

  await clickUntil(page, 'pause-button', 'pause-overlay');

  const frozen = await timer();
  await page.waitForTimeout(2_500);
  /* Nothing accumulates while paused — that is the requirement, so it is asserted
     against wall-clock time rather than the HUD's own idea of it. */
  expect(await timer()).toBe(frozen);

  await clickUntil(page, 'resume-button', 'hud');
  await expect(page.getByTestId('pause-overlay')).toHaveCount(0);

  /* Generous: the HUD clock is driven by simulation time, so under load the frame
     loop — and therefore the clock — advances more slowly than wall time. The
     assertion is that time passes again, not how fast. */
  await expect.poll(() => timer(), { timeout: 20_000 }).not.toBe(frozen);
});

/**
 * Losing focus pauses the match without being asked.
 *
 * The event is dispatched repeatedly rather than once, because React attaches the
 * listener in an effect that runs after the HUD first appears. A single early
 * dispatch would be silently dropped and the test would then fail for a reason
 * that has nothing to do with auto-pause.
 */
test('losing window focus pauses automatically', async ({ page }) => {
  await page.getByTestId('play-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();

  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        return page.getByTestId('pause-overlay').count();
      },
      { timeout: 10_000, intervals: [200] },
    )
    .toBe(1);
});

test('restart resets the match in place', async ({ page }) => {
  await page.getByTestId('play-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();

  await page.getByTestId('restart-button').click();
  await expect(page.getByTestId('hud-score').locator('.hud__value')).toHaveText('0');
  await expect(page.locator('.game-canvas canvas')).toHaveCount(1);
});

test('abandon returns to the menu without a result', async ({ page }) => {
  await page.getByTestId('play-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();

  await page.getByTestId('abandon-button').click();
  await expect(page.getByTestId('main-menu')).toBeVisible();
  await expect(page.getByTestId('result-screen')).toHaveCount(0);
  await expect(page.locator('.game-canvas canvas')).toHaveCount(0);
});

/**
 * Teardown across repeated enter/exit cycles.
 *
 * BOTH halves matter. Exactly one canvas while a match runs catches a duplicated
 * renderer; zero once the host unmounts catches a leaked WebGL context. Checking
 * only the first would pass while leaking a context per match.
 */
test('repeated enter and exit cycles leak neither a canvas nor a context', async ({ page }) => {
  for (let i = 0; i < 5; i += 1) {
    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('hud')).toBeVisible();
    await expect(page.locator('.game-canvas canvas')).toHaveCount(1);

    await page.getByTestId('abandon-button').click();
    await expect(page.getByTestId('main-menu')).toBeVisible();
    await expect(page.locator('.game-canvas canvas')).toHaveCount(0);
  }
});

test('the match produces no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && !text.includes('GL Driver')) errors.push(text);
  });

  await page.getByTestId('play-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();
  await page.waitForTimeout(3_000);

  expect(errors).toEqual([]);
});