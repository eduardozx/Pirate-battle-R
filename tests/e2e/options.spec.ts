import { expect, test } from '@playwright/test';

import { gotoMenu } from './support/app';

/**
 * Options: validation, persistence and reset.
 *
 * The brief requires validation with visible error messages and persistence
 * across refreshes, so both are asserted rather than assumed.
 */

test.beforeEach(async ({ page }) => {
  await gotoMenu(page);
});

test('values outside the documented limits are rejected', async ({ page }) => {
  await page.getByTestId('options-button').click();
  await expect(page.getByTestId('options-screen')).toBeVisible();

  const session = page.getByTestId('option-sessionSeconds');

  /* Below the minimum. */
  await session.fill('30');
  await expect(session).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('options-screen')).toContainText(/between/i);

  /* Above the maximum. */
  await session.fill('999');
  await expect(session).toHaveAttribute('aria-invalid', 'true');

  /* Cleared entirely. Letters are not testable here and deliberately so: the
     control is `type="number"`, so the browser refuses non-numeric input before
     the app ever sees it. Asserting that would be testing the browser. An empty
     field IS reachable, and must still be rejected. */
  await session.fill('');
  await expect(session).toHaveAttribute('aria-invalid', 'true');
});

test('a valid value is accepted and persisted across a refresh', async ({ page }) => {
  await page.getByTestId('options-button').click();
  await page.getByTestId('option-sessionSeconds').fill('120');
  await expect(page.getByTestId('option-sessionSeconds')).toHaveAttribute('aria-invalid', 'false');
  await page.getByTestId('options-back').click();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('options-button').click();

  await expect(page.getByTestId('option-sessionSeconds')).toHaveValue('120');
});

test('reset restores the defaults', async ({ page }) => {
  await page.getByTestId('options-button').click();
  await page.getByTestId('option-sessionSeconds').fill('180');
  await page.getByTestId('option-spawnIntervalSeconds').fill('7');

  await page.getByTestId('options-reset').click();

  await expect(page.getByTestId('option-sessionSeconds')).toHaveValue('90');
  await expect(page.getByTestId('option-spawnIntervalSeconds')).toHaveValue('3');
});

test('the spawn interval is validated against its own limits', async ({ page }) => {
  await page.getByTestId('options-button').click();

  const spawn = page.getByTestId('option-spawnIntervalSeconds');
  await spawn.fill('0');
  await expect(spawn).toHaveAttribute('aria-invalid', 'true');

  await spawn.fill('11');
  await expect(spawn).toHaveAttribute('aria-invalid', 'true');

  await spawn.fill('0.5');
  await expect(spawn).toHaveAttribute('aria-invalid', 'false');
});