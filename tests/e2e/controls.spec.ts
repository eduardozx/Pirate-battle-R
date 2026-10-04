import { expect, test } from '@playwright/test';

import { fastMatchUrl } from './support/app';
import {
  advance,
  drive,
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

  /* The drive is ONE evaluate: two seconds of simulation with the key down,
     sampled every 50 ms — see `drive` for why neither the distance nor the
     samples can drift with machine load. */
  const path = await drive(page, 'ArrowUp', 2000);

  let intruder: string | null = null;
  let deepestBeside = Number.NEGATIVE_INFINITY;
  for (const point of path) {
    const sample = { ...hull, x: point.x, y: point.y };
    if (intruder === null) intruder = insideSolid(start, sample);

    /* Eastward progress is measured ONLY while the hull is at the island's own
       latitude. Sailing round the north end is legal navigation and invisible to
       a raw maximum of x; driving through the land is the failure this test is
       about, and it can only happen while the two overlap in y. */
    const besideIsland =
      point.y >= central.bounds.y && point.y <= central.bounds.y + central.bounds.height;
    if (besideIsland) deepestBeside = Math.max(deepestBeside, point.x);
  }

  /* The centre of the hull never sat inside a solid tile — checked at every
     sample of the drive, not only at the end, so a hull that crossed the land
     between two samples cannot slip through the assertion. */
  expect(intruder).toBeNull();

  const stopped = thePlayer(await readSnapshot(page));
  /* It really did drive at the land… */
  expect(stopped.x).toBeGreaterThan(hull.x + 30);
  /* …while it was beside the island it never got past the western face: the land
     held it short… */
  expect(deepestBeside).toBeLessThan(westFace);
  /* …and it came within touching distance of that face, rather than turning away
     from it before ever making contact. */
  expect(deepestBeside).toBeGreaterThan(westFace - 80);
});
