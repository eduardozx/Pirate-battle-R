import { expect, test, type Page, type Route } from '@playwright/test';

import {
  backToMenu,
  fastMatchUrl,
  gotoMenu,
  openTab,
  playMatchToEnd,
  selectScenario,
} from './support/app';

/**
 * Remote data as a player actually meets it: a response that takes its time,
 * responses that arrive in the wrong order, the record the player just earned,
 * and an asset that fails to download.
 *
 * Every one of these is a state the brief requires to be handled, and every one
 * of them is reached deliberately rather than waited for.
 */

test('a slow endpoint shows a loading state instead of a blank panel', async ({ page }) => {
  await gotoMenu(page);
  /* 2.5 s on every response. */
  await selectScenario(page, 'slow');

  /* History has no cached rows in a fresh profile, so switching to it starts a
     query that must be PENDING. That is the only honest way to observe a loading
     state on a panel: the ranking has already been loaded once, and a background
     revalidation of cached rows must NOT blank them out. */
  await openTab(page, 'history');

  await expect(page.getByTestId('panel-loading')).toBeVisible();
  await expect(page.getByTestId('panel-empty')).toBeVisible({ timeout: 30_000 });
});

test('a late response never replaces fresher data', async ({ page }) => {
  await gotoMenu(page);
  /* Delay is derived from a hash of each record id, so page 2 genuinely can
     arrive before page 1 rather than merely arriving slowly. */
  await selectScenario(page, 'out-of-order');

  /* Page jumps issued faster than the API can answer: the response for page 1
     lands after the response for page 3. One cache entry per page is what makes
     that harmless, and this is the input shape that proves it. */
  await page.getByTestId('page-next').click();
  await page.getByTestId('page-next').click();
  await page.getByTestId('page-previous').click();

  await expect(page.getByTestId('panel-loading')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('page-status')).toContainText('Page 1 of');
  await expect(page.getByTestId('ranking-row').first()).toBeVisible();

  /* The rows are page 1's, in ranking order. A stale response winning would
     leave page 2's scores on screen or an unordered mix of both. */
  const scores = (
    await page.locator('[data-testid="ranking-row"] .records__score').allInnerTexts()
  ).map(Number);
  expect(scores.length).toBeGreaterThan(1);
  for (let i = 1; i < scores.length; i += 1) {
    expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i] ?? 0);
  }
});

/** The ranking's own tally, read out of the pagination status ("· 37 total"). */
const rankingTotal = async (page: Page): Promise<number> => {
  const status = (await page.getByTestId('page-status').innerText()).replace(/\s+/g, ' ');
  const total = /· (\d+) total/.exec(status)?.[1];
  if (total === undefined) throw new Error(`unexpected ranking status: "${status}"`);
  return Number(total);
};

/**
 * The record travels from the result screen to the RANKING, not merely into the
 * outbox.
 *
 * Counting the rows before and after is what makes this about delivery: the
 * panel is filtered to the current configuration, so a submission recorded under
 * the wrong fingerprint — or recorded twice — shows up as a tally that does not
 * move by exactly one.
 */
test('the ranking gains exactly one row for the match that was just played', async ({ page }) => {
  await gotoMenu(page, fastMatchUrl());
  await expect(page.getByTestId('ranking-row').first()).toBeVisible();
  const before = await rankingTotal(page);

  await playMatchToEnd(page);
  await expect(page.getByTestId('result-submission')).toContainText('Recorded');

  await backToMenu(page);

  await expect(page.getByTestId('page-status')).toContainText(`· ${before + 1} total`, {
    timeout: 30_000,
  });
});

/**
 * An asset that fails to download must be reported and must be recoverable —
 * before combat starts, with a way back, not as a console line.
 *
 * The art is unblocked BEFORE retry is pressed, so the second half of the
 * assertion is about the retry path itself: the failure screen has to hand back
 * a working game, not merely acknowledge the click.
 */
test('an asset failure is reported, and retry recovers it', async ({ page }) => {
  let blockArt = true;
  const art = async (route: Route): Promise<void> => {
    if (blockArt) {
      await route.abort('failed');
      return;
    }
    await route.continue();
  };

  // `context.route`, not `page.route`: the textures are fetched through MSW's
  // service worker, and a page-level router never sees a request raised inside a
  // worker. The two patterns name the art directories rather than the whole
  // assets directory, which also holds the application's own JavaScript bundle —
  // blocking that produces a blank page, not a failure screen.
  await page.context().route('**/assets/spritesheet/**', art);
  await page.context().route('**/assets/png/**', art);

  /* Not gotoMenu(): the menu cannot become interactive while its textures are
     missing, so waiting for the ranking tab would wait for a state that cannot
     arrive. The failure screen IS the expected state here. */
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.getByTestId('asset-error')).toBeVisible({ timeout: 60_000 });
  /* Enabled, not stuck behind the progress bar: a failed load still ticks the
     bar, and a disabled Retry would leave the player with no way out. */
  await expect(page.getByTestId('asset-retry')).toBeEnabled();

  blockArt = false;
  await page.getByTestId('asset-retry').click();

  /* Recovery, not acknowledgement: the failure has to clear and hand back a
     menu with a live ranking behind it. */
  await expect(page.getByTestId('asset-error')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('tab-ranking')).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByTestId('ranking-row').first()).toBeVisible();
});
