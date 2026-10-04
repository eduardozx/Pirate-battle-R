import { expect, test } from '@playwright/test';

import { fastMatchUrl, gotoMenu, playMatchToEnd } from './support/app';
import { startMatch } from './support/hook';

/**
 * The two ways a match ends, and the one thing the player needs from each: a
 * result screen that says WHY it ended.
 *
 * The end reason is not decoration. "Time expired" and "Ship destroyed" imply
 * different lessons for the player and different records downstream, so both are
 * reached deliberately rather than inferred from the fact that a screen appeared.
 */

test('the clock runs out and the result says why', async ({ page }) => {
  await gotoMenu(page, fastMatchUrl(6));
  await playMatchToEnd(page);

  await expect(page.getByTestId('result-reason')).toHaveText('Time expired');
  /* The heading is the same sentence: a screen-reader user announcing the dialog
     must hear the reason too, not just the value in a definition list. */
  await expect(page.getByRole('heading', { name: 'Time expired' })).toBeVisible();
});

/**
 * Dying is the slower of the two endings, and it is slower still on a machine
 * running several WebGL contexts at once: simulation time tracks the render
 * loop, which deliberately refuses to catch up in a burst. Hence the budget,
 * which is about machine load rather than about the game.
 */
test('the hull is destroyed and the result says why', async ({ page }) => {
  /* Reset the budget early: the config's 120 s is not enough for the slowest
     case, and `setTimeout` restarts the clock from this call. */
  test.setTimeout(180_000);

  await startMatch(page, fastMatchUrl(120, 0.5));

  await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('result-reason')).toHaveText('Ship destroyed');
  await expect(page.getByRole('heading', { name: 'Ship destroyed' })).toBeVisible();
});
