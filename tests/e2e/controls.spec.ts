import { expect, test } from '@playwright/test';

import { fastMatchUrl } from './support/app';
import {
  advance,
  hold,
  insideSolid,
  readSnapshot,
  startMatch,
  theIsland,
  thePlayer,
  turnTo,
} from './support/hook';

/**
 * Steering and confinement — the three properties that make the hull playable:
 * it answers the helm, it cannot leave the arena, and it cannot drive through
 * land.
 *
 * DISTANCES COME FROM SIMULATION TIME. Each step is measured by advancing the
 * clock through the hook, so "it reached the wall" means the same thing on a
 * loaded CI box as on a laptop. Assertions are still written with tolerance for
 * the wall-clock loop that runs alongside the harness.
 */

/** One enemy after 1.2 s, then a ten-second gap: an arena that stays out of the way. */
const QUIET_ARENA = fastMatchUrl(60, 10);

test('the hull answers the helm', async ({ page }) => {
  const start = thePlayer(await startMatch(page, QUIET_ARENA));

  await hold(page, 'ArrowUp', 900);
  const sailed = thePlayer(await readSnapshot(page));

  /* Spawn faces north, so forward thrust is a straight line: any sideways drift
     would mean velocity is being built from the wrong angle. */
  expect(sailed.y).toBeLessThan(start.y - 100);
  expect(Math.abs(sailed.x - start.x)).toBeLessThan(25);

  /* Turn to a KNOWN heading rather than for a known duration: a duration lands
     the bow wherever the frame rate happens to leave it — see `turnTo`. A
     quarter turn from the north-bound heading, requested and then measured. */
  const target = sailed.angle + Math.PI / 2;
  const turned = await turnTo(page, target);

  /* Clockwise from north means the heading increases, and it must reach the
     heading that was asked for: within one 20 ms step of overshoot, no more. */
  expect(turned).toBeGreaterThanOrEqual(target);
  expect(turned).toBeLessThan(target + 0.1);
});

test('the arena edge holds the hull', async ({ page }) => {
  const start = await startMatch(page, QUIET_ARENA);
  const hull = thePlayer(start);
  const limit = start.arena.boundsPadding + hull.radius;

  /* Sampled throughout the run rather than only at the end: a hull that sailed
     out and was pulled back would pass a final-position check. */
  await page.keyboard.down('ArrowUp');
  let closest = hull.y;
  for (let i = 0; i < 8; i += 1) {
    await advance(page, 500);
    closest = Math.min(closest, thePlayer(await readSnapshot(page)).y);
  }
  await page.keyboard.up('ArrowUp');

  const held = thePlayer(await readSnapshot(page));
  expect(closest).toBeGreaterThanOrEqual(limit - 2);
  expect(held.y).toBeLessThanOrEqual(limit + 2);
  expect(held.y).toBeGreaterThanOrEqual(limit - 2);
  expect(held.alive).toBe(true);
});

test('an island stops the hull instead of yielding to it', async ({ page }) => {
  const start = await startMatch(page, QUIET_ARENA);
  const hull = thePlayer(start);
  const central = theIsland(start, 'isle-central');
  const westFace = central.bounds.x;

  /* Aim a little north of due east: close enough to the face that the hull
     cannot miss it, nowhere near the ~70° that would carry it round the island's
     north edge instead of into it. */
  const heading = await turnTo(page, -0.4);
  expect(heading).toBeGreaterThanOrEqual(-0.4);
  expect(heading).toBeLessThan(-0.3);

  await page.keyboard.down('ArrowUp');
  let intruder: string | null = null;
  let deepest = hull.x;
  for (let i = 0; i < 4 && intruder === null; i += 1) {
    await advance(page, 500);
    const passing = await readSnapshot(page);
    const moving = thePlayer(passing);
    deepest = Math.max(deepest, moving.x);
    intruder = insideSolid(passing, moving);
  }
  await page.keyboard.up('ArrowUp');

  /* The centre of the hull must never sit inside a solid tile, and this is
     checked DURING the drive — a pass-through could otherwise slip between the
     last sample and the end of the test. */
  expect(intruder).toBeNull();

  const stopped = thePlayer(await readSnapshot(page));
  /* It really did drive at the land… */
  expect(stopped.x).toBeGreaterThan(hull.x + 30);
  /* …and was held short of its face, all the way through. */
  expect(deepest).toBeLessThan(westFace);
});
