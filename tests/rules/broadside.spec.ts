import { describe, expect, it } from 'vitest';

import { PlayerSystem } from '../../src/game/systems/playerSystem';
import { compileIslands, ISLAND_DEFINITIONS } from '../../src/game/config/arenaLayout';
import { DEFAULT_GAME_CONFIG, broadsideDirection } from '../../src/game/config/gameConfig';
import { TAU } from '../../src/game/core/math';
import type { PlayerEntity } from '../../src/game/entities/entityModels';
import { EntityStore } from '../../src/game/entities/entityStore';

/**
 * Broadside firing geometry.
 *
 * This suite exists because of a specific defect: the broadsides were fired along
 * a fixed WORLD angle, which happened to look correct while the ship sailed along
 * +X and fired out of the BOW once the ship pointed anywhere else. A test that
 * only checks the horizontal case would not have caught it, so every heading is
 * swept here.
 */

const HALF_PI = Math.PI / 2;

const playerAt = (angle: number): PlayerEntity => {
  const player = {
    id: 1,
    kind: 'player',
    x: 500,
    y: 400,
    angle,
    radius: DEFAULT_GAME_CONFIG.player.hitboxRadius,
    alive: true,
    health: 100,
    maxHealth: 100,
    invulnerableUntilMs: 0,
    weapons: {},
    cooldownUntilMs: { front: 0, left: 0, right: 0 },
  } as unknown as PlayerEntity;
  return player;
};

const system = new PlayerSystem(
  new EntityStore(16),
  compileIslands(ISLAND_DEFINITIONS),
  DEFAULT_GAME_CONFIG,
);

/** Unit vector a given angle points at. */
const directionOf = (angle: number): { x: number; y: number } => ({
  x: Math.cos(angle),
  y: Math.sin(angle),
});

/** Smallest signed difference between two angles, in radians. */
const angleDelta = (a: number, b: number): number => {
  let delta = (a - b) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return delta;
};

const weapons = DEFAULT_GAME_CONFIG.player.weapons;

describe('broadside geometry', () => {
  it('fires perpendicular to the bow at every heading', () => {
    /* The whole regression in one loop: whatever the ship faces, a broadside must
       be exactly 90° off the bow, never aligned with it. */
    for (let step = 0; step < 36; step += 1) {
      const heading = (step / 36) * TAU;
      const player = playerAt(heading);

      /* Port is the ship's -Y side, which with the bow on +X points at -90°: the
         LEFT broadside sits at heading - 90°, the RIGHT at heading + 90°. */
      for (const muzzle of system.muzzlePositions(player, weapons.left)) {
        expect(Math.abs(angleDelta(muzzle.angle, heading - HALF_PI))).toBeLessThan(1e-9);
      }

      for (const muzzle of system.muzzlePositions(player, weapons.right)) {
        expect(Math.abs(angleDelta(muzzle.angle, heading + HALF_PI))).toBeLessThan(1e-9);
      }
    }
  });

  it('never fires a broadside along the bow', () => {
    /* Stated separately because it is the exact user-visible complaint: pointed
       up or down, the shots used to leave the front of the ship. */
    for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const player = playerAt(heading);

      for (const weapon of [weapons.left, weapons.right]) {
        for (const muzzle of system.muzzlePositions(player, weapon)) {
          const parallel = Math.abs(angleDelta(muzzle.angle, heading));
          expect(parallel).toBeGreaterThan(HALF_PI - 1e-6);
        }
      }
    }
  });

  it('sends the shots out to opposite sides', () => {
    for (let step = 0; step < 24; step += 1) {
      const heading = (step / 24) * TAU;
      const player = playerAt(heading);

      const left = directionOf(system.muzzlePositions(player, weapons.left)[0]?.angle ?? 0);
      const right = directionOf(system.muzzlePositions(player, weapons.right)[0]?.angle ?? 0);

      /* Opposite sides means a straight line through the hull. */
      expect(left.x * right.x + left.y * right.y).toBeCloseTo(-1, 9);
    }
  });

  it('rotates the shots with the ship instead of holding a world angle', () => {
    const horizontal = playerAt(0);
    const vertical = playerAt(Math.PI / 2);

    const horizontalLeft = system.muzzlePositions(horizontal, weapons.left)[0]?.angle ?? 0;
    const verticalLeft = system.muzzlePositions(vertical, weapons.left)[0]?.angle ?? 0;

    /* A fixed world angle would leave both identical. This is the assertion that
       fails against the original bug. */
    expect(angleDelta(verticalLeft, horizontalLeft)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('keeps the forward cannon pointing along the bow', () => {
    for (let step = 0; step < 12; step += 1) {
      const heading = (step / 12) * TAU;
      const player = playerAt(heading);

      for (const muzzle of system.muzzlePositions(player, weapons.front)) {
        expect(angleDelta(muzzle.angle, heading)).toBeLessThan(1e-9);
      }
    }
  });

  it('fires all three shots of a broadside in parallel', () => {
    const player = playerAt(Math.PI / 3);

    for (const weapon of [weapons.left, weapons.right]) {
      const muzzles = system.muzzlePositions(player, weapon);
      expect(muzzles).toHaveLength(3);

      const first = muzzles[0]?.angle ?? 0;
      for (const muzzle of muzzles) {
        expect(angleDelta(muzzle.angle, first)).toBeLessThan(1e-9);
      }
    }
  });

  it('places the muzzles along the hull, rotating with the ship', () => {
    const player = playerAt(Math.PI / 2);
    const muzzles = system.muzzlePositions(player, weapons.right);

    /* The muzzles are laid along the hull, i.e. the ship's local X axis. With the
       bow pointing down the screen that axis is world Y, so the spread must have
       rotated from horizontal to vertical. The perpendicular offset moves to -X. */
    const xs = muzzles.map((muzzle) => muzzle.x);
    const ys = muzzles.map((muzzle) => muzzle.y);

    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(20);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(6);
    /* Starboard of a ship facing down-screen points at world -X. */
    expect(xs.every((x) => x < player.x)).toBe(true);
  });

  it('keeps the broadside offset signed away from the bow', () => {
    /* Guards the constants themselves, independent of any ship. */
    expect(broadsideDirection('left')).toBeCloseTo(-HALF_PI, 9);
    expect(broadsideDirection('right')).toBeCloseTo(HALF_PI, 9);
  });
});