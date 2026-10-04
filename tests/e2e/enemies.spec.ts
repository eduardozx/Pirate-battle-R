import { expect, test } from '@playwright/test';

import { fastMatchUrl } from './support/app';
import { readCounters, readSnapshot, resetCounters, startMatch, thePlayer } from './support/hook';

/**
 * Enemy behaviour: reinforcement schedule, pursuit, gunnery — and the score
 * rule that distinguishes a kill from a ship blowing itself up on contact.
 *
 * Every wait polls the simulation rather than sleeping, and each one is sized
 * for a machine that is rendering three WebGL contexts at once: the assertion
 * is about behaviour that must happen, not about how fast it happens.
 */

/** A shot every other second: hostile, but slow enough that the hull survives
 *  long enough to be observed doing so. */
const HOSTILE = fastMatchUrl(120, 2);

test('enemies arrive on the configured schedule', async ({ page }) => {
  const started = await startMatch(page, fastMatchUrl(60, 1));

  expect(started.spawnIntervalMs).toBe(1_000);
  expect(started.enemies).toHaveLength(0);

  await expect
    .poll(async () => (await readSnapshot(page)).enemies.length, { timeout: 45_000, intervals: [250] })
    .toBeGreaterThanOrEqual(1);

  /* Not just a lucky first spawn: three intervals in, the arena is genuinely
     being reinforced on the cadence the options asked for. */
  await expect
    .poll(async () => (await readSnapshot(page)).enemies.length, { timeout: 45_000, intervals: [500] })
    .toBeGreaterThanOrEqual(3);
});

test('a chaser closes the distance to the hull', async ({ page }) => {
  await startMatch(page, HOSTILE);

  await expect
    .poll(
      async () => (await readSnapshot(page)).enemies.some((enemy) => enemy.kind === 'chaser'),
      { timeout: 45_000, intervals: [500] },
    )
    .toBe(true);

  const opening = await readSnapshot(page);
  const start = thePlayer(opening);
  const chaser = opening.enemies.find((enemy) => enemy.kind === 'chaser');
  if (chaser === undefined) throw new Error('the poll above guarantees a chaser');
  const initialGap = Math.hypot(chaser.x - start.x, chaser.y - start.y);

  /* Polling the gap rather than sleeping and re-reading: the chaser may reach
     the hull and detonate at any moment, and a lost entity must count as
     "closed the distance", not as a failure to find it. */
  await expect
    .poll(
      async () => {
        const snapshot = await readSnapshot(page);
        const hull = thePlayer(snapshot);
        const target = snapshot.enemies.find((enemy) => enemy.id === chaser.id);
        if (target === undefined) return 0;
        return Math.hypot(target.x - hull.x, target.y - hull.y);
      },
      { timeout: 45_000, intervals: [500] },
    )
    .toBeLessThan(initialGap - 60);
});

test('a shooter opens fire from range', async ({ page }) => {
  await startMatch(page, HOSTILE);

  await expect
    .poll(
      async () => (await readCounters(page)).shotsByWeapon.enemy_shooter,
      { timeout: 60_000, intervals: [500] },
    )
    .toBeGreaterThan(0);
});

/**
 * The score rule, asserted end-to-end rather than against a constant.
 *
 * A chaser that reaches the hull destroys itself. Awarding a point for that
 * would let a player score by doing nothing at all, so the kill counter, the
 * defeated counter and the score must all stay at zero after it happens.
 */
test('a chaser that detonates on the hull scores nothing', async ({ page }) => {
  await startMatch(page, fastMatchUrl(120, 0.5));
  await resetCounters(page);

  await expect
    .poll(async () => (await readCounters(page)).enemySelfDestructed, {
      timeout: 60_000,
      intervals: [500],
    })
    .toBeGreaterThan(0);

  const snapshot = await readSnapshot(page);
  expect(snapshot.score).toBe(0);
  expect(snapshot.enemiesDefeated).toBe(0);
  expect((await readCounters(page)).enemyKilled).toBe(0);
});
