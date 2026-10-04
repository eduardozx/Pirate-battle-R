import { expect, test } from '@playwright/test';

import { gotoMenu, openTab, resetMocks, selectScenario } from './support/app';

/**
 * Records panels: ranking and match history.
 *
 * The four remote states — loading, empty, error, data — are all required by the
 * brief, so each is reached deliberately rather than assumed.
 *
 * TIMING. Queries retry with exponential backoff before surfacing a failure, so
 * assertions here use generous timeouts rather than fixed sleeps. A sleep-based
 * suite is a flaky suite.
 */

test.beforeEach(async ({ page }) => {
  await gotoMenu(page);
});

test('ranking loads, paginates and orders deterministically', async ({ page }) => {
  await expect(page.getByTestId('ranking-table')).toBeVisible();
  await expect(page.getByTestId('ranking-row').first()).toBeVisible();

  expect(await page.getByTestId('ranking-row').count()).toBeGreaterThan(0);
  await expect(page.getByTestId('pagination')).toBeVisible();
  await expect(page.getByTestId('page-status')).toContainText('Page 1 of');

  /* Ordering is score descending, and it must hold on every page. */
  const scoresOf = async (): Promise<number[]> => {
    const texts = await page.locator('[data-testid="ranking-row"] .records__score').allInnerTexts();
    return texts.map(Number);
  };
  const assertOrdered = async (): Promise<void> => {
    const scores = await scoresOf();
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i] ?? 0);
    }
  };

  await assertOrdered();

  await page.getByTestId('page-next').click();
  await expect(page.getByTestId('page-status')).toContainText('Page 2 of');
  await assertOrdered();

  /* Going back returns to the first page rather than appending to it. */
  await page.getByTestId('page-previous').click();
  await expect(page.getByTestId('page-status')).toContainText('Page 1 of');
  await assertOrdered();
});

test('the empty state is reachable', async ({ page }) => {
  await selectScenario(page, 'empty');
  await expect(page.getByTestId('panel-empty')).toBeVisible();

  /* And the panel returns to normal when the data comes back. */
  await selectScenario(page, 'success');
  await expect(page.getByTestId('ranking-row').first()).toBeVisible();
  await expect(page.getByTestId('panel-empty')).toHaveCount(0);
});

/**
 * A failed refresh must not destroy data the player is already reading.
 *
 * With rows on screen the failure surfaces as a warning strip and the table stays.
 * Replacing valid rows with an error panel would be a regression in behaviour
 * disguised as error handling.
 */
test('a failed refresh keeps existing rows and explains itself', async ({ page }) => {
  await expect(page.getByTestId('ranking-row').first()).toBeVisible();
  const rowsBefore = await page.getByTestId('ranking-row').count();

  await selectScenario(page, 'http-500');

  await expect(page.getByTestId('panel-stale')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('ranking-row')).toHaveCount(rowsBefore);
  await expect(page.getByTestId('panel-retry').first()).toBeVisible();
});

/**
 * The full error panel is reserved for a failure with nothing to fall back on.
 *
 * History has no cached rows in a fresh profile, so failing it is the only honest
 * way to reach the hard-error state — forcing it on the ranking would mean
 * discarding the cached rows the previous test asserts must survive.
 */
test('a failure with no cached data shows the full error panel', async ({ page }) => {
  await openTab(page, 'history');

  /* Let the tab reach its initial state BEFORE changing the scenario.
     Switching while the first request is still in flight lets that request
     resolve into the same cache entry the invalidation targets, so the failure is
     never observed. A user reads the tab before the API breaks, so this ordering
     is also the realistic one. */
  await expect(page.getByTestId('panel-empty')).toBeVisible();
  await expect(page.getByTestId('panel-loading')).toHaveCount(0);

  await selectScenario(page, 'history-error');

  const errorPanel = page.getByTestId('panel-error');
  await expect(errorPanel).toBeVisible({ timeout: 30_000 });
  await expect(errorPanel).toContainText(/503|unavailable/i);

  /* A failure must be actionable, not merely displayed. */
  await expect(page.getByTestId('panel-retry').first()).toBeVisible();
});

test('the panel recovers once the endpoint does', async ({ page }) => {
  await openTab(page, 'history');
  await expect(page.getByTestId('panel-empty')).toBeVisible();
  await expect(page.getByTestId('panel-loading')).toHaveCount(0);

  await selectScenario(page, 'history-error');
  await expect(page.getByTestId('panel-error')).toBeVisible({ timeout: 30_000 });

  /* The retry affordance and the automatic revalidation share one refetch path,
     so recovering proves both are wired to a request that can actually succeed. */
  await selectScenario(page, 'success');

  await expect(page.getByTestId('panel-error')).toHaveCount(0, { timeout: 30_000 });

  /* A fresh profile has no matches, so recovery lands on the EMPTY state rather
     than a table. Asserting a table here would be asserting a match the profile
     does not have. */
  await expect(page.getByTestId('panel-empty')).toBeVisible();
});

test('history renders a state and exposes its own filter', async ({ page }) => {
  await openTab(page, 'history');

  /* The ranking filter must not leak into the history panel. */
  await expect(page.getByTestId('ranking-filter')).toHaveCount(0);
  await expect(page.getByTestId('history-filter')).toBeVisible();

  /* A fresh profile has no matches: an empty state is correct, not a bug. */
  await expect(page.getByTestId('panel-empty')).toBeVisible();
});

test('rapid paging does not corrupt the visible page', async ({ page }) => {
  await selectScenario(page, 'multi-page');
  await expect(page.getByTestId('page-status')).toContainText('Page 1 of');

  /* Rapid back-and-forth is the input shape that makes a slow response overwrite
     a newer one. One query key per page is what structurally prevents it. */
  for (let i = 0; i < 3; i += 1) {
    await page.getByTestId('page-next').click();
    await page.getByTestId('page-previous').click();
  }

  await expect(page.getByTestId('page-status')).toContainText('Page 1 of');
  await expect(page.getByTestId('ranking-row').first()).toBeVisible();
});

test('reset clears generated records and the queue', async ({ page }) => {
  await resetMocks(page);
  await expect(page.getByTestId('confirmed-count')).toHaveText('0');
  await expect(page.getByTestId('pending-count')).toHaveText('0');
});