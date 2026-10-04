import { expect, test } from '@playwright/test';

import { fastMatchUrl } from './support/app';
import {
  press,
  readCounters,
  readSnapshot,
  resetCounters,
  scriptInputs,
  startMatch,
  thePlayer,
  wait,
} from './support/hook';

/**
 * Weapons, damage and the score rules that hang off them.
 *
 * The counters are read straight from the simulation's event stream, so "two
 * presses, one shot" is a statement about what the rules engine actually did —
 * not about how many projectiles happen to still be alive when the assertion
 * runs.
 */

/** One enemy after 1.2 s, then a ten-second gap. */
const QUIET_ARENA = fastMatchUrl(60, 10);
/** Enemy every 0.5 s: hostile enough to land a hit inside a reasonable budget. */
const SWARM = fastMatchUrl(120, 0.5);

test('the bow cannon fires once per cooldown', async ({ page }) => {
  await startMatch(page, QUIET_ARENA);

  /* Four steps in a single call into the page — see `scriptInputs` for why this
     cannot be driven with `page.keyboard`: the round trips alone would outlast
     the cooldown being tested, and the assertion would pass no matter what the
     rules did. */
  const trail = await scriptInputs(page, [
    press('Space'), // one volley
    press('Space'), // 60 ms later: still inside the 380 ms cooldown
    wait(400), // cooldown spent
    press('Space'), // must be usable again
  ]);

  /* [1, 1, 1, 2] says three separate things: a press is edge-consumed rather
     than a stream of shots, the cooldown swallows the press made inside it
     instead of queueing it, and the cannon is reusable once the cooldown is
     spent. */
  expect(trail.map((step) => step.counters.shotsByWeapon.player_front)).toEqual([1, 1, 1, 2]);
  expect(trail[3]?.counters.weaponFired).toBe(2);
});

test('a broadside throws three guns across the heading', async ({ page }) => {
  const started = await startMatch(page, QUIET_ARENA);
  const heading = thePlayer(started).angle;

  const [fired] = await scriptInputs(page, [press('KeyQ')]);
  if (fired === undefined) throw new Error('scriptInputs reported no steps');

  const port = fired.snapshot.projectiles.filter((shot) => shot.weaponId === 'player_left');

  /* One volley from three barrels. The counter is per volley and the world is
     per ball: both have to agree with the "3 shots" the menu promises, because
     either one on its own can be satisfied by a bug in the other. */
  expect(fired.counters.shotsByWeapon.player_left).toBe(1);
  expect(port).toHaveLength(3);

  for (const shot of port) {
    /* Port fires off the flank: perpendicular to the bow, with tolerance for the
       handful of milliseconds the hull may have turned by. */
    expect(Math.abs(Math.cos(shot.angle - heading))).toBeLessThan(0.2);
  }
});

test('the hull loses health when an enemy lands a hit', async ({ page }) => {
  await startMatch(page, SWARM);
  await resetCounters(page);

  await expect
    .poll(async () => (await readCounters(page)).playerDamaged, {
      timeout: 90_000,
      intervals: [500],
    })
    .toBeGreaterThan(0);

  const hull = thePlayer(await readSnapshot(page));
  expect(hull.health).toBeLessThan(hull.maxHealth);
  expect(hull.health).toBeGreaterThan(0);
});
