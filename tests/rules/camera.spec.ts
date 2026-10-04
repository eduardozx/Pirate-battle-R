import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG } from '../../src/game/config/gameConfig';

/**
 * Camera framing.
 *
 * The renderer is not importable here — it needs a live WebGL context — so the
 * arithmetic that decides where the camera looks is reproduced exactly as
 * `applyViewport` computes it. Duplicating three lines of maths is the cheap price
 * for being able to prove the important property without a browser:
 *
 *   THE VISIBLE RECTANGLE NEVER LEAVES THE ARENA.
 *
 * That is what makes removing the letterbox safe. Scaling up to "cover" is only
 * acceptable because the camera pans instead of cropping, and it is only correct
 * because the pan is clamped so no empty space is ever exposed.
 */

const { arena } = DEFAULT_GAME_CONFIG;

const clampCamera = (centre: number, half: number, extent: number): number => {
  if (half * 2 >= extent) return extent / 2;
  return Math.min(Math.max(centre, half), extent - half);
};

/** Mirrors `GameRenderer.applyViewport`. */
const frame = (screenWidth: number, screenHeight: number, focusX?: number, focusY?: number) => {
  const scale = Math.max(screenWidth / arena.width, screenHeight / arena.height);
  const halfW = screenWidth / scale / 2;
  const halfH = screenHeight / scale / 2;
  const centreX = clampCamera(focusX ?? arena.width / 2, halfW, arena.width);
  const centreY = clampCamera(focusY ?? arena.height / 2, halfH, arena.height);

  return {
    scale,
    centreX,
    centreY,
    viewWidth: screenWidth / scale,
    viewHeight: screenHeight / scale,
  };
};

/** Screen shapes worth covering, from a tall portrait phone to an ultrawide. */
const SCREENS: ReadonlyArray<readonly [string, number, number]> = [
  ['16:9 desktop', 1920, 1080],
  ['16:10 laptop', 1440, 900],
  ['4:3 tablet', 1024, 768],
  ['21:9 ultrawide', 2560, 1080],
  ['landscape phone', 844, 390],
  ['portrait phone', 390, 844],
];

describe('camera framing', () => {
  it('leaves no letterbox: the arena always fills the screen', () => {
    for (const [label, width, height] of SCREENS) {
      const f = frame(width, height);

      /* No black bar means the visible rectangle — which maps exactly onto the
         screen — lies INSIDE the arena, so every pixel of the display has water
         behind it. Note this does NOT mean the whole arena is visible: the camera
         shows a window into it. */
      expect(f.viewWidth, label).toBeLessThanOrEqual(arena.width + 1e-6);
      expect(f.viewHeight, label).toBeLessThanOrEqual(arena.height + 1e-6);

      /* And "cover" guarantees the window is exactly the arena's size on one axis,
         so there is never slack to fill on both. */
      const matchesWidth = Math.abs(f.viewWidth - arena.width) < 1e-6;
      const matchesHeight = Math.abs(f.viewHeight - arena.height) < 1e-6;
      expect(matchesWidth || matchesHeight, label).toBe(true);

      /* Sanity: the window really does span the whole screen. */
      expect(f.viewWidth * f.scale, label).toBeCloseTo(width, 6);
      expect(f.viewHeight * f.scale, label).toBeCloseTo(height, 6);
    }
  });

  it('never shows a region outside the arena, whatever the camera is doing', () => {
    /* Sweep the focus across the entire arena, plus well beyond its edges, at every
       screen shape. A camera clamped to the arena cannot escape it. */
    for (const [label, width, height] of SCREENS) {
      for (let i = -2; i <= 6; i += 1) {
        for (let j = -2; j <= 6; j += 1) {
          const f = frame(width, height, (i / 4) * arena.width, (j / 4) * arena.height);

          const left = f.centreX - f.viewWidth / 2;
          const right = f.centreX + f.viewWidth / 2;
          const top = f.centreY - f.viewHeight / 2;
          const bottom = f.centreY + f.viewHeight / 2;

          expect(left, `${label} @ ${i},${j}`).toBeGreaterThanOrEqual(-1e-6);
          expect(top, `${label} @ ${i},${j}`).toBeGreaterThanOrEqual(-1e-6);
          expect(right, `${label} @ ${i},${j}`).toBeLessThanOrEqual(arena.width + 1e-6);
          expect(bottom, `${label} @ ${i},${j}`).toBeLessThanOrEqual(arena.height + 1e-6);
        }
      }
    }
  });

  it('keeps the ship on screen wherever it sails', () => {
    for (const [label, width, height] of SCREENS) {
      const corners: ReadonlyArray<readonly [number, number]> = [
        [0, 0],
        [arena.width, 0],
        [0, arena.height],
        [arena.width, arena.height],
        [arena.width / 2, arena.height / 2],
      ];

      for (const [x, y] of corners) {
        const f = frame(width, height, x, y);

        expect(x, label).toBeGreaterThanOrEqual(f.centreX - f.viewWidth / 2 - 1e-6);
        expect(x, label).toBeLessThanOrEqual(f.centreX + f.viewWidth / 2 + 1e-6);
        expect(y, label).toBeGreaterThanOrEqual(f.centreY - f.viewHeight / 2 - 1e-6);
        expect(y, label).toBeLessThanOrEqual(f.centreY + f.viewHeight / 2 + 1e-6);
      }
    }
  });

  it('pans on the axis that has room and locks the one that does not', () => {
    /* A 16:9 screen is wider than the arena, so the width matches exactly and only
       the height can pan — within [432, 528]. A focus of 500 is inside that range. */
    const wide = frame(1920, 1080, 200, 500);
    expect(wide.viewWidth).toBeCloseTo(arena.width, 6);
    expect(wide.viewHeight).toBeLessThan(arena.height);
    expect(wide.centreX).toBeCloseTo(arena.width / 2, 6);
    expect(wide.centreY).toBe(500);

    /* A focus beyond the pan range is clamped, never allowed to drift outside. */
    expect(frame(1920, 1080, 200, 0).centreY).toBeCloseTo(432, 6);
    expect(frame(1920, 1080, 200, 960).centreY).toBeCloseTo(528, 6);

    /* A 4:3 screen is taller than the arena, so it flips to panning horizontally
       within [640, 896]. */
    const tall = frame(1024, 768, 800, 200);
    expect(tall.viewHeight).toBeCloseTo(arena.height, 6);
    expect(tall.viewWidth).toBeLessThan(arena.width);
    expect(tall.centreY).toBeCloseTo(arena.height / 2, 6);
    expect(tall.centreX).toBe(800);
  });

  it('centres the camera on the arena when there is nothing to pan', () => {
    const exact = frame(arena.width, arena.height, 0, 0);
    expect(exact.centreX).toBeCloseTo(arena.width / 2, 6);
    expect(exact.centreY).toBeCloseTo(arena.height / 2, 6);
    expect(exact.scale).toBeCloseTo(1, 6);
  });

  it('zooms in on a wider screen instead of adding bars', () => {
    /* The user's complaint, stated as arithmetic: on a 16:9 display the old
       "contain" scale left ~11% of the width empty. */
    const contain = Math.min(1920 / arena.width, 1080 / arena.height);
    const cover = Math.max(1920 / arena.width, 1080 / arena.height);

    expect(cover).toBeGreaterThan(contain);
    /* Contain wasted exactly 10% of a 16:9 screen's width as black bars. */
    expect((1920 - arena.width * contain) / 1920).toBeCloseTo(0.1, 6);
    expect(1920 - arena.width * cover).toBeCloseTo(0, 6);
  });
});