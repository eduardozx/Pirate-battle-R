import { expect, test } from '@playwright/test';

import { fastMatchUrl, gotoMenu } from './support/app';
import {
  advance,
  headingDelta,
  holdPad,
  readCounters,
  readSnapshot,
  resetCounters,
  startMatch,
  thePlayer,
} from './support/hook';

/**
 * Touch controls: the pad exists, the menu documents it BEFORE the match, and
 * pressing it drives exactly the same input path the keyboard does.
 *
 * Restricted to the touch project. A desktop browser emitting pointer events
 * would prove nothing about whether a phone can play the game.
 */

test.beforeEach(async ({ hasTouch }) => {
  test.skip(!hasTouch, 'the on-screen pad exists only on a touch device');
});

/** One enemy after 1.2 s, then a ten-second gap. */
const QUIET_ARENA = fastMatchUrl(60, 10);

test('the menu documents the on-screen pad', async ({ page }) => {
  await gotoMenu(page);

  const hints = page.getByTestId('controls-hint');
  await expect(hints).toBeVisible();
  await expect(hints.getByRole('heading')).toHaveText('Touch controls');

  /* Every glyph on the pad has to be explained somewhere, because a touch player
     has no keyboard table to fall back on. */
  await expect(hints).toContainText('Hold to sail forward');
  await expect(hints).toContainText('Hold to turn');
  await expect(hints).toContainText('Fire forward cannon');
  await expect(hints).toContainText('broadside');
});

test('the on-screen pad steers the hull', async ({ page }) => {
  const start = thePlayer(await startMatch(page, QUIET_ARENA));
  const pad = page.getByTestId('touch-controls');
  await expect(pad).toBeVisible();

  const forward = pad.getByLabel('Sail forward');
  await forward.dispatchEvent('pointerdown', { bubbles: true, cancelable: true });
  await advance(page, 900);
  await forward.dispatchEvent('pointerup', { bubbles: true, cancelable: true });

  const sailed = thePlayer(await readSnapshot(page));
  /* Same budget as the keyboard spec: the pad is another door into one input
     controller, so it must move the hull the same distance. */
  expect(sailed.y).toBeLessThan(start.y - 100);
  expect(Math.abs(sailed.x - start.x)).toBeLessThan(25);
});

test('the on-screen pad fires the cannons', async ({ page }) => {
  await startMatch(page, QUIET_ARENA);
  await resetCounters(page);

  const cannon = page.getByTestId('touch-controls').getByLabel('Fire forward cannon');
  await cannon.dispatchEvent('pointerdown', { bubbles: true, cancelable: true });
  await advance(page, 60);
  await cannon.dispatchEvent('pointerup', { bubbles: true, cancelable: true });

  expect((await readCounters(page)).shotsByWeapon.player_front).toBe(1);
});

test('the on-screen pad reports which control is held', async ({ page }) => {
  await startMatch(page, QUIET_ARENA);
  await expect(page.getByTestId('touch-controls')).toBeVisible();

  const start = thePlayer(await readSnapshot(page));

  /* The whole hold lives inside one evaluate (see `holdPad`): the button is
     pressed, 400 ms of simulation runs, the button is released. The heading it
     produces therefore does not depend on how long the machine took to travel
     between steps — a round trip is ~100 ms of wall time the sim clock follows,
     and the button would be pressed for every millisecond of it. */
  const turned = thePlayer(await holdPad(page, 'Turn left', 400));

  /* Counter-clockwise from north: the heading must DECREASE, proving the pad's
     "Turn left" is wired to the left action and not merely to "some action".
     The difference is folded first (see `headingDelta`) because headings live in
     [−π, π] and wrap at the seam: a hull turned far enough past −π reports a
     LARGER number than it started with, and a raw subtraction would then read as
     the opposite turn. */
  expect(headingDelta(turned.angle, start.angle)).toBeLessThan(-0.6);
});
