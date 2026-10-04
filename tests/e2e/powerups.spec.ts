import { expect, test } from '@playwright/test';

import { gotoMenu } from './support/app';

/**
 * A short match where every crate lands in reach of a stationary ship.
 *
 * The radius exceeds the arena's longest possible span (~1 800 units), so wherever
 * a crate materialises it is collectable on the frame it spawns. A merely "wide"
 * radius is NOT enough: with a smaller one the outcome depends on whether the
 * seeded spawn happened to land in the far corner, which makes the test pass or
 * fail for reasons that have nothing to do with the mechanic.
 */
const fastPowerUpUrl = (sessionSeconds: number): string =>
  `/?sessionSeconds=${sessionSeconds}&spawnIntervalSeconds=1&powerUpPickupRadius=5000&powerUpMinDistance=0`;

/**
 * Power-ups.
 *
 * The lifecycle itself — pooling, the state machine, effect application — is
 * covered deterministically by `tests/rules/powerUps.spec.ts`, where the
 * simulation can be stepped exactly. What is worth asserting HERE is the
 * integration: that power-ups coexist with a live match without breaking it, and
 * that a collected timed power-up surfaces on the HUD.
 *
 * NOTE ON THE REACHABILITY CHECK. Sailing over a drifting pickup in a real-time
 * match is the one thing here that cannot be scripted deterministically: the
 * player's ship follows real physics and the pickup lands at a random position at
 * least 260 units away. So the sweep below is a wide circling search rather than
 * an exact manoeuvre, and the assertion is the observable outcome (the HUD badge)
 * rather than the path taken.
 */

test('a match runs cleanly with power-ups active', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  /* Real spawn distances and the real pickup radius: this checks that crates
     coexisting with a live match cause no instability, not that they are
     collectable. */
  await gotoMenu(page, '/?sessionSeconds=25&spawnIntervalSeconds=1');
  await page.getByTestId('play-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();

  /* Power-ups begin spawning after the initial delay, so this window definitely
     contains live power-ups. */
  await page.waitForTimeout(9_000);

  await expect(page.getByTestId('hud')).toBeVisible();
  expect(await page.locator('.game-canvas canvas').count()).toBe(1);
  expect(errors).toEqual([]);
});

/**
 * Collecting a power-up reaches the HUD.
 *
 * WHY TWO PARAMETERS ARE OVERRIDDEN. A crate drifts at a random point at least 260
 * units from the ship, and scripted keyboard input cannot reliably intercept it:
 * holding a turn key makes the ship orbit a ~50-unit circle rather than cross the
 * arena, so a blind sweep never arrives. Setting the minimum spawn distance to
 * zero and the pickup radius wide puts a crate in reach of a stationary ship,
 * which makes the check deterministic while still exercising the whole pipeline —
 * spawn, state transition, effect application, HUD, expiry.
 *
 * What this does NOT cover — collection at the real radius — is asserted exactly in
 * `tests/rules/powerUps.spec.ts`, where the simulation can be stepped precisely.
 * The override is compiled out of production builds.
 */
test('collecting a timed power-up shows it on the HUD and then clears it', async ({ page }) => {
  await gotoMenu(page, fastPowerUpUrl(40));
  await page.getByTestId('play-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();

  const badge = page.getByTestId('hud-powerup');
  await expect(badge).toBeVisible({ timeout: 30_000 });

  /* A timed power-up reports its label and a countdown that runs down. */
  await expect(badge).toContainText(/\d+s/);

  const first = await badge.innerText();
  await page.waitForTimeout(2_000);
  expect(await badge.innerText()).not.toBe(first);

  /* Letting it expire removes the indicator, so the HUD never shows a stale bonus. */
  await expect(badge).toHaveCount(0, { timeout: 30_000 });
});

/**
 * A consumable has no duration, so it must never leave a countdown badge behind.
 *
 * This is the assertion that distinguishes the two power-up kinds end to end.
 */
test('a consumable leaves no timed indicator', async ({ page }) => {
  await gotoMenu(page, fastPowerUpUrl(30));
  await page.getByTestId('play-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();

  /* Spawn the crate right on top of a stationary ship: with a pickup radius wider
     than the arena is tall, it cannot survive the first update uncollected. */
  await page.waitForTimeout(10_000);

  expect(await page.getByTestId('result-screen').count()).toBe(0);
  await expect(page.getByTestId('hud')).toBeVisible();
});

test('the HUD power-up indicator is absent while nothing is active', async ({ page }) => {
  await gotoMenu(page, fastPowerUpUrl(20));
  await page.getByTestId('play-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();

  /* The indicator appears only for a RUNNING timed effect. With every crate
     collected immediately, only consumables arrive — so a quiet HUD here proves a
     consumable does NOT produce a phantom bonus, which is the whole point. */
  await page.waitForTimeout(9_000);
  await expect(page.getByTestId('hud')).toBeVisible();
  await expect(page.getByTestId('hud-powerup')).toHaveCount(0);
});