import { expect, type Page } from '@playwright/test';

/**
 * End-to-end helpers.
 *
 * Everything the specs need to talk to the application's internal state goes
 * through here, so a storage-key rename is a one-file change rather than a sweep
 * across the suite.
 */

export const OUTBOX_KEY = 'pb.outbox.v1';
export const MOCK_DB_KEY = 'pb.msw.db.v1';

export interface OutboxItemView {
  readonly matchId: string;
  readonly status: string;
  readonly attempts: number;
  readonly recovered: boolean;
  readonly lastError: string | null;
}

export interface StoredMatch {
  readonly matchId: string;
  readonly playerId: string;
  readonly score: number;
  readonly effectiveDurationMs: number;
  readonly endReason: string;
  readonly configFingerprint: string;
}

/**
 * A URL that shortens the match to a few seconds.
 *
 * The seam only exists in dev builds (see `readTestOverrides` in optionsStore), so
 * every spec that needs a completed match goes through here rather than hand-
 * rolling the parameters.
 */
export const fastMatchUrl = (sessionSeconds = 6, spawnIntervalSeconds = 1): string =>
  `/?sessionSeconds=${sessionSeconds}&spawnIntervalSeconds=${spawnIntervalSeconds}`;

/** Loads the app and waits until the menu is interactive. */
export const gotoMenu = async (page: Page, url = '/'): Promise<void> => {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('main-menu')).toBeVisible();
  // The mock worker registers before first paint, so a visible menu already
  // implies the API is reachable. This assertion proves it rather than assuming.
  await expect(page.getByTestId('tab-ranking')).toBeEnabled();
};

/** Clears the fixture records and the submission queue. */
export const resetMocks = async (page: Page): Promise<void> => {
  await page.getByTestId('reset-mocks').click();
  await expect(page.getByTestId('pending-count')).toHaveText('0');
};

export const selectScenario = async (page: Page, id: string): Promise<void> => {
  await page.getByTestId('scenario-select').selectOption(id);
  await expect(page.getByTestId('scenario-description')).toBeVisible();
};

export const openTab = async (page: Page, tab: 'ranking' | 'history'): Promise<void> => {
  await page.getByTestId(`tab-${tab}`).click();
};

/**
 * Whether the focused element lives inside the given element.
 *
 * This is the whole accessibility contract of the two dialogs — focus moves in
 * when they open and cannot walk out — and it is asserted structurally rather
 * than by which control happens to be focused, which would break the moment a
 * button is reordered.
 */
export const focusWithin = (page: Page, testId: string): Promise<boolean> =>
  page.evaluate((id) => {
    const root = document.querySelector(`[data-testid="${id}"]`);
    return root !== null && document.activeElement !== null && root.contains(document.activeElement);
  }, testId);

/**
 * Plays one match to completion.
 *
 * A match ends either when the clock expires or when the ship is sunk — both
 * produce a result screen and both must be recorded, so this does not care which
 * happens. That is deliberate: asserting on a specific end reason would make the
 * helper depend on AI behaviour, which is exactly the thing under test elsewhere.
 *
 * THE GENEROUS TIMEOUT IS LOAD-BEARING. The match clock advances with the render
 * loop, and the loop deliberately refuses to catch up in a burst — a starved frame
 * is capped rather than replayed. That is the right behaviour for a game, but it
 * means simulation time runs slower than wall time whenever several WebGL
 * contexts are competing, and a six-second match can take the best part of a
 * minute. Waiting on the result therefore cannot use the default budget.
 */
export const playMatchToEnd = async (page: Page): Promise<void> => {
  await page.getByTestId('play-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();
  await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 60_000 });
};

/** Returns to the menu from a result screen. */
export const backToMenu = async (page: Page): Promise<void> => {
  await page.getByTestId('main-menu-button').click();
  await expect(page.getByTestId('main-menu')).toBeVisible();
};

/**
 * Clicks a control and waits for the result, retrying the click.
 *
 * WHY THIS EXISTS. The in-match HUD republishes on a coarse change — a tick of the
 * clock, a point of health — so the pause button is re-rendered constantly. Under
 * load, a single click can be dispatched against a node React is about to replace:
 * Playwright sees the button as stable, the click lands, and the handler runs
 * against a detached node, so nothing happens and the spec fails on a 30-second
 * wait for an overlay that was never requested.
 *
 * The overlay simply did not appear, with no error anywhere — the failure mode this
 * exists to remove. A user tapping pause gets it handled; this is about the test
 * observing that reliably, not about the app being wrong.
 */
export const clickUntil = async (
  page: Page,
  trigger: string,
  result: string,
  timeoutMs = 20_000,
): Promise<void> => {
  await expect
    .poll(
      async () => {
        await page.getByTestId(trigger).click();
        return page.getByTestId(result).count();
      },
      { timeout: timeoutMs, intervals: [250, 500, 1_000] },
    )
    .toBeGreaterThan(0);
};

/** Reads the submission queue straight out of storage. */
export const readOutbox = (page: Page): Promise<readonly OutboxItemView[]> =>
  page.evaluate(
    (key) => {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return [];
      const parsed = JSON.parse(raw) as {
        items?: Array<{
          matchId: string;
          status: string;
          attempts: number;
          recovered: boolean;
          lastError: string | null;
        }>;
      };
      return (parsed.items ?? []).map((item) => ({
        matchId: item.matchId,
        status: item.status,
        attempts: item.attempts,
        recovered: item.recovered,
        lastError: item.lastError,
      }));
    },
    OUTBOX_KEY,
  );

/** Reads the mock server's stored records. */
export const readMockMatches = (page: Page): Promise<readonly StoredMatch[]> =>
  page.evaluate(
    (key) => {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return [];
      const parsed = JSON.parse(raw) as { matches?: StoredMatch[] };
      return parsed.matches ?? [];
    },
    MOCK_DB_KEY,
  );

/**
 * Records the player actually created, as opposed to generated fixtures.
 *
 * Counting only real submissions is what makes "exactly one record per match"
 * meaningful: fixture rows are regenerated on demand and would mask a duplicate.
 */
export const realMatches = async (page: Page): Promise<readonly StoredMatch[]> => {
  const all = await readMockMatches(page);
  return all.filter((match) => !match.matchId.startsWith('fixture-'));
};

/** Asserts the invariant that matters most: one record per match, no duplicates. */
export const expectExactlyOneRecordEach = async (page: Page, expected: number): Promise<void> => {
  await expect
    .poll(async () => (await realMatches(page)).length, { timeout: 20_000 })
    .toBe(expected);

  const matches = await realMatches(page);
  const ids = matches.map((match) => match.matchId);
  expect(new Set(ids).size).toBe(ids.length);
};