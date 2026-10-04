import { expect, test } from '@playwright/test';

import { fastMatchUrl, focusWithin, gotoMenu } from './support/app';
import { advance, readSnapshot, startMatch } from './support/hook';

/**
 * Keyboard operation and dialog behaviour.
 *
 * These are the claims a screenshot cannot make: that the menu can be driven
 * without a pointer, that P and Escape pause and resume, that Tab cannot walk
 * out of a modal, and that focus returns to whatever opened it.
 */

/** One enemy after 1.2 s, then a ten-second gap: nothing to fight while testing. */
const QUIET_ARENA = fastMatchUrl(60, 10);

test('the menu is operable from the keyboard alone', async ({ page }) => {
  await gotoMenu(page);

  /* Tab until Play is focused rather than assuming it is first: the bound is
     what makes the assertion about REACHABILITY, not about DOM order. */
  let focused: string | null = null;
  for (let attempt = 0; attempt < 8 && focused !== 'play-button'; attempt += 1) {
    await page.keyboard.press('Tab');
    focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
  }
  expect(focused).toBe('play-button');

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('hud')).toBeVisible();
});

test('P pauses, Escape resumes, and the dialog keeps focus', async ({ page }) => {
  await startMatch(page, QUIET_ARENA);

  await page.keyboard.press('p');
  await expect(page.getByTestId('pause-overlay')).toBeVisible();
  expect(await focusWithin(page, 'pause-overlay')).toBe(true);

  /* Tab must cycle inside the dialog rather than reaching the HUD behind it —
     a modal a keyboard user can tab out of is not a modal. */
  await page.keyboard.press('Tab');
  expect(await focusWithin(page, 'pause-overlay')).toBe(true);

  /* The freeze is structural, not cosmetic: advancing the clock while paused
     must not move simulation time at all. */
  const frozen = (await readSnapshot(page)).simulationMs;
  await advance(page, 1_000);
  expect((await readSnapshot(page)).simulationMs).toBe(frozen);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-overlay')).toHaveCount(0);
  await expect
    .poll(async () => (await readSnapshot(page)).phase, { timeout: 10_000, intervals: [100] })
    .toBe('running');
});

test('closing the pause dialog hands focus back to its trigger', async ({ page }) => {
  await startMatch(page, QUIET_ARENA);

  const pause = page.getByTestId('pause-button');
  await pause.focus();
  await page.keyboard.press('p');
  await expect(page.getByTestId('pause-overlay')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-overlay')).toHaveCount(0);
  /* Dropping focus on <body> here would strand a keyboard player: the next Tab
     would start over at the top of the page instead of resuming play. */
  await expect(pause).toBeFocused();
});

test('the result dialog is modal and takes focus when it opens', async ({ page }) => {
  await gotoMenu(page, fastMatchUrl(6));
  await page.getByTestId('play-button').click();
  await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 60_000 });

  await expect(page.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  expect(await focusWithin(page, 'result-screen')).toBe(true);

  await page.keyboard.press('Tab');
  expect(await focusWithin(page, 'result-screen')).toBe(true);
});
