import { expect, test } from '@playwright/test';

import { clickUntil, fastMatchUrl, gotoMenu, openTab } from './support/app';

/**
 * Visual regression baselines.
 *
 * WHAT THIS IS FOR. Pixel diffs catch the class of change that no functional
 * assertion notices: a sprite anchored on the wrong corner, a panel overlapping
 * the one below it, a colour that quietly loses contrast, a layout that collapses
 * on a narrow viewport. Every other suite here passes happily while any of those
 * happens.
 *
 * WHAT IT IS NOT FOR. It is not a screenshot gallery and must not become one.
 * Each baseline targets one component and is paired with a functional assertion,
 * so a diff fails with a reason instead of as an unexplained image mismatch.
 *
 * WHY ELEMENTS, NOT FULL-PAGE SHOTS. On the mobile viewport the ranking table sits
 * below the fold, so a viewport screenshot would silently protect nothing. Every
 * baseline below targets a specific element, which makes it meaningful at any
 * scroll position.
 *
 * STABILITY RULES LEARNED THE HARD WAY. Three separate flakes were fixed here, and
 * each is a trap worth documenting:
 *   • live canvas pixels — a running match redraws every frame, so the arena is
 *     captured PAUSED, which freezes the loop;
 *   • unsettled panels — capture the terminal state, never a transition;
 *   • random per-profile data — the generated captain name differs on every run.
 * Live regions are masked for the same reason: a field mask whose box resizes with
 * its text leaves a diff at the edges whenever the number changes width.
 *
 * Baselines are platform-specific: fonts, GPU and rasterisation all differ per
 * machine. `update-snapshots` must be run on the machine whose baselines are
 * committed.
 */

test.describe('visual baselines', () => {
  test('main menu chrome', async ({ page }) => {
    await gotoMenu(page);

    /* Wait for the panel to SETTLE before opening the shutter. The loading state
       is shorter than the table it is replaced by, so capturing mid-flight locks
       the baseline to a spinner — the panel below it changes height, which shifts
       every pixel underneath, which is exactly what this baseline is for. */
    await expect(page.getByTestId('panel-loading')).toHaveCount(0);
    await expect(page.getByTestId('ranking-row').first()).toBeVisible();

    /* The two live counters change on their own schedule, so they cannot be part of
       a static baseline. */
    await expect(page).toHaveScreenshot('main-menu.png', {
      animations: 'disabled',
      mask: [page.getByTestId('outbox-summary')],
    });
  });

  test('ranking table', async ({ page }) => {
    await gotoMenu(page);

    await expect(page.getByTestId('ranking-table')).toBeVisible();
    // Populated, or the baseline would lock in an empty table.
    await expect(page.getByTestId('ranking-row').first()).toBeVisible();

    await expect(page.getByTestId('pagination')).toBeVisible();
    await expect(page.getByTestId('ranking-filter')).toBeVisible();

    await expect(page.locator('[data-testid="ranking-table"]').locator('xpath=ancestor::section[1]'))
      .toHaveScreenshot('ranking.png', { animations: 'disabled' });
  });

  test('history empty state', async ({ page }) => {
    await gotoMenu(page);
    await openTab(page, 'history');

    /* Wait for the panel to SETTLE. Capturing mid-transition locks the baseline to
       whichever of loading / empty / data happened to be on screen. */
    await expect(page.getByTestId('panel-loading')).toHaveCount(0);
    await expect(page.getByTestId('panel-empty')).toBeVisible();

    await expect(page.locator('[data-testid="history-filter"]').locator('xpath=ancestor::section[1]'))
      .toHaveScreenshot('history.png', {
        animations: 'disabled',
        /* The captain name is generated per profile, so it differs on every run.
           Diffing it would fail for a value that is data, not design. */
        mask: [page.getByTestId('history-filter')],
      });
  });

  test('options screen', async ({ page }) => {
    await gotoMenu(page);
    await page.getByTestId('options-button').click();
    await expect(page.getByTestId('options-screen')).toBeVisible();

    await expect(page.getByTestId('options-screen')).toHaveScreenshot('options.png', {
      animations: 'disabled',
    });
  });

  /**
   * The rendered arena, captured PAUSED.
   *
   * Pausing is not a shortcut, it is the only stable way to diff gameplay pixels:
   * `animations: 'disabled'` stops CSS transitions but cannot stop a WebGL canvas
   * redrawing a live simulation, so two runs seconds apart would differ in every
   * ship's position and fail every time. Screenshotting the canvas element rather
   * than the screen also excludes the pause overlay, which would otherwise dim
   * exactly the pixels worth checking.
   */
  test('the arena, frozen', async ({ page }) => {
    await gotoMenu(page, fastMatchUrl(60, 1));
    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('hud')).toBeVisible();

    // Sail and fight briefly so ships, wake and projectiles are all on screen: a
    // pristine opening frame would not exercise most of the renderer.
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(5_000);
    await page.keyboard.up('ArrowUp');

    await clickUntil(page, 'pause-button', 'pause-overlay');
    // Let the final frame settle before the shutter.
    await page.waitForTimeout(500);

    await expect(page.locator('.game-canvas canvas')).toHaveScreenshot('arena.png');
  });

  test('paused overlay', async ({ page }) => {
    await gotoMenu(page, fastMatchUrl(60, 1));
    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('hud')).toBeVisible();

    await clickUntil(page, 'pause-button', 'pause-overlay');

    await expect(page.getByTestId('match-screen')).toHaveScreenshot('paused.png', {
      animations: 'disabled',
      // Every HUD value is live; masking the whole HUD avoids edge diffs.
      mask: [page.getByTestId('hud')],
    });
  });

  test('result screen', async ({ page }) => {
    await gotoMenu(page, fastMatchUrl(6, 1));
    await page.getByTestId('play-button').click();
    await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 60_000 });

    /* Score, duration and submission status are all data-dependent. What the
       baseline protects is the layout: label alignment, actions, status strip. */
    await expect(page.getByTestId('result-screen')).toHaveScreenshot('result.png', {
      animations: 'disabled',
      mask: [
        page.getByTestId('result-score'),
        page.getByTestId('result-duration'),
        page.getByTestId('result-submission'),
      ],
    });
  });
});