import { expect, test } from '@playwright/test';

import {
  backToMenu,
  expectExactlyOneRecordEach,
  fastMatchUrl,
  gotoMenu,
  playMatchToEnd,
  readOutbox,
  realMatches,
  resetMocks,
  selectScenario,
} from './support/app';

/**
 * Submission, retries and the no-duplicates guarantee.
 *
 * These are the strictest requirements in the brief: exactly one history record
 * and one ranking entry per completed match, across retries, double clicks,
 * timeouts and refreshes.
 *
 * The client request timeout is 8 s, so a spec that expects a timeout has to allow
 * for more than that. Assertions use `expect.poll` throughout rather than fixed
 * sleeps, because a sleep-based suite is a flaky suite.
 */

test.beforeEach(async ({ page }) => {
  await gotoMenu(page, fastMatchUrl());
  await resetMocks(page);
});

test('a completed match produces exactly one record', async ({ page }) => {
  await playMatchToEnd(page);

  await expect(page.getByTestId('result-submission')).toContainText('Recorded');
  await expectExactlyOneRecordEach(page, 1);

  const [match] = await realMatches(page);
  expect(match?.score).toBeGreaterThanOrEqual(0);
  expect(match?.effectiveDurationMs).toBeGreaterThan(0);
});

test('an abandoned match is never recorded', async ({ page }) => {
  await page.getByTestId('play-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();

  await page.getByTestId('abandon-button').click();
  await expect(page.getByTestId('main-menu')).toBeVisible();
  await expect(page.getByTestId('result-screen')).toHaveCount(0);

  expect(await realMatches(page)).toHaveLength(0);
  expect(await readOutbox(page)).toHaveLength(0);
});

test('the queue is never blocked: Play Again works while a submission is pending', async ({
  page,
}) => {
  await selectScenario(page, 'unavailable-at-match-end');
  await playMatchToEnd(page);

  await expect
    .poll(async () => (await readOutbox(page)).filter((item) => item.status !== 'confirmed').length)
    .toBeGreaterThanOrEqual(1);

  /* The player is not held hostage by a failing network. */
  await expect(page.getByTestId('play-again-button')).toBeEnabled();
  await expect(page.getByTestId('result-submission')).toContainText(/pending/i);

  await backToMenu(page);
  await expect(page.getByTestId('play-button')).toBeEnabled();
  await expect(page.getByTestId('menu-pending')).toBeVisible();
});

/**
 * The scenario that separates a correct queue from one that merely exists.
 *
 * The server commits the record and then never answers. The client has no way to
 * learn that the data exists — only a resend can discover it, and the resend must
 * not create a second record.
 */
test('a committed-then-timed-out submission is recovered, not duplicated', async ({ page }) => {
  await selectScenario(page, 'submit-commit-then-hang');
  await playMatchToEnd(page);

  /* The record exists server-side even though the client is still waiting. */
  await expect.poll(async () => (await realMatches(page)).length, { timeout: 20_000 }).toBe(1);

  /* The client cannot know that, so the item stays queued. */
  await expect
    .poll(async () => (await readOutbox(page)).filter((item) => item.status !== 'confirmed').length, {
      timeout: 25_000,
    })
    .toBeGreaterThanOrEqual(1);

  /* Restore a healthy API and let the queue retry. */
  await backToMenu(page);
  await selectScenario(page, 'success');
  await page.getByTestId('flush-outbox').click();

  /* THE ASSERTION: three matches' worth of attempts, one record. */
  await expectExactlyOneRecordEach(page, 1);
});

test('a pending submission survives a page refresh', async ({ page }) => {
  await selectScenario(page, 'unavailable-at-match-end');
  await playMatchToEnd(page);

  const pending = await readOutbox(page);
  const queued = pending.find((item) => item.status !== 'confirmed');
  expect(queued).toBeDefined();

  /* A refresh must not lose a queued record — the player may have closed the tab
     after a match, which is the normal case, not an edge case. The refresh lands
     back on the RESULT screen (the outcome is persisted too), and the queue is
     read from storage, so neither depends on being on the menu. */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('result-screen')).toBeVisible();

  await expect
    .poll(async () => (await readOutbox(page)).some((item) => item.matchId === queued?.matchId), {
      timeout: 20_000,
    })
    .toBe(true);

  /* And it is delivered once the API is reachable again. The failure scenario is
     in-memory, so a reload restores a healthy default. */
  await expect
    .poll(
      async () => {
        const item = (await readOutbox(page)).find((entry) => entry.matchId === queued?.matchId);
        return item?.status;
      },
      { timeout: 25_000 },
    )
    .toBe('confirmed');

  await expectExactlyOneRecordEach(page, 1);
});

test('repeated submissions across several matches stay one-per-match', async ({ page }) => {
  for (let i = 0; i < 3; i += 1) {
    await playMatchToEnd(page);
    await backToMenu(page);
  }

  await expectExactlyOneRecordEach(page, 3);

  const ids = (await realMatches(page)).map((match) => match.matchId);
  expect(new Set(ids).size).toBe(3);
});

test('the history tab lists the player\'s recorded matches', async ({ page }) => {
  await playMatchToEnd(page);
  await backToMenu(page);

  await page.getByTestId('tab-history').click();
  await expect(page.getByTestId('history-table')).toBeVisible();
  await expect(page.getByTestId('history-row')).toHaveCount(1);
});