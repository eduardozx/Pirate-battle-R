import { describe, expect, it } from 'vitest';

import { clampInsideArena } from '../../src/game/config/arenaLayout';
import { DEFAULT_GAME_CONFIG, type GameConfig } from '../../src/game/config/gameConfig';
import { GameWorld } from '../../src/game/core/gameWorld';
import { isEnemy, isPlayer, type EnemyEntity, type PlayerEntity } from '../../src/game/entities/entityModels';
import type { InputState } from '../../src/game/core/types';

/**
 * Arena confinement.
 *
 * The defect: enemies could sail out of the arena while the player could not. The
 * cause was not the AI but the ORDER of operations — `resolveShipVsIslandFor`
 * clamps only after it displaces a hull, and it returns early when no island was
 * touched, so an enemy crossing open border water never met the clamp at all. It
 * also ran BEFORE the AI moved the ship, so even a clamped hull could leave the
 * arena on that same frame.
 *
 * These tests pin both the shared rule and the end-to-end behaviour, because either
 * alone would let a regression through: correct arithmetic applied at the wrong
 * moment still lets ships escape.
 */

const arena = DEFAULT_GAME_CONFIG.arena;
const RADIUS = 20;

const minX = arena.boundsPadding + RADIUS;
const maxX = arena.width - arena.boundsPadding - RADIUS;
const minY = arena.boundsPadding + RADIUS;
const maxY = arena.height - arena.boundsPadding - RADIUS;

describe('clampInsideArena', () => {
  it('leaves a hull inside the arena untouched', () => {
    const inside = clampInsideArena(700, 400, RADIUS, arena);
    expect(inside.x).toBe(700);
    expect(inside.y).toBe(400);
  });

  it('pulls a hull back from every edge', () => {
    expect(clampInsideArena(-500, 400, RADIUS, arena).x).toBe(minX);
    expect(clampInsideArena(9_000, 400, RADIUS, arena).x).toBe(maxX);
    expect(clampInsideArena(700, -500, RADIUS, arena).y).toBe(minY);
    expect(clampInsideArena(700, 9_000, RADIUS, arena).y).toBe(maxY);
  });

  it('keeps the whole hull inside, not just its centre', () => {
    const clamped = clampInsideArena(-999, -999, RADIUS, arena);

    // The hull's edge, not its centre point, must respect the padding.
    expect(clamped.x - RADIUS).toBeGreaterThanOrEqual(arena.boundsPadding - 1e-9);
    expect(clamped.y - RADIUS).toBeGreaterThanOrEqual(arena.boundsPadding - 1e-9);

    const far = clampInsideArena(9_999, 9_999, RADIUS, arena);
    expect(far.x + RADIUS).toBeLessThanOrEqual(arena.width - arena.boundsPadding + 1e-9);
    expect(far.y + RADIUS).toBeLessThanOrEqual(arena.height - arena.boundsPadding + 1e-9);
  });

  it('reserves room for the hull radius, so a big ship is held further in', () => {
    const small = clampInsideArena(-999, -999, 10, arena);
    const large = clampInsideArena(-999, -999, 60, arena);

    expect(large.x).toBeGreaterThan(small.x);
    expect(large.y).toBeGreaterThan(small.y);
  });

  it('is pure: the inputs are never mutated', () => {
    const bounds = { width: 100, height: 100, boundsPadding: 5 };
    const result = clampInsideArena(-50, -50, 10, bounds);
    expect(result).toEqual({ x: 15, y: 15 });
    expect(bounds).toEqual({ width: 100, height: 100, boundsPadding: 5 });
  });
});

/**
 * Builds a world and drives it, which is the only level at which the ORDER of the
 * clamp can be observed. A unit test of the arithmetic cannot see it.
 */
const stepWorld = (world: GameWorld, steps: number, dt = 1 / 60): void => {
  const input: InputState = {
    turn: 0,
    forward: false,
    fireFront: false,
    fireLeft: false,
    fireRight: false,
  };

  for (let i = 0; i < steps; i += 1) world.step(dt, input);
};

const buildWorld = (config: GameConfig = DEFAULT_GAME_CONFIG): GameWorld =>
  new GameWorld(config, 0x5eed);

/** Reads enemy hulls straight out of the store: position, liveness and radius. */
const enemyHulls = (world: GameWorld): Array<{ x: number; y: number; radius: number; alive: boolean }> => {
  const out: Array<{ x: number; y: number; radius: number; alive: boolean }> = [];
  world.store.forEach((entity) => {
    if (!isEnemy(entity)) return;
    const enemy = entity as EnemyEntity;
    out.push({ x: enemy.x, y: enemy.y, radius: enemy.radius, alive: enemy.alive });
  });
  return out;
};

/**
 * True when a hull is outside the arena for ITS OWN radius.
 *
 * Per-ship radius matters: the player, chasers and shooters all have different
 * hitbox radii, so a single shared radius would flag the small hulls as escaping
 * by a couple of units when they are in fact correctly held.
 */
const outsideArena = (hull: { x: number; y: number; radius: number }): boolean =>
  hull.x < arena.boundsPadding + hull.radius - 1e-6 ||
  hull.x > arena.width - arena.boundsPadding - hull.radius + 1e-6 ||
  hull.y < arena.boundsPadding + hull.radius - 1e-6 ||
  hull.y > arena.height - arena.boundsPadding - hull.radius + 1e-6;

/** Moves every hull, used to plant an escape before the world corrects it. */
const moveShips = (world: GameWorld, mutate: (ship: PlayerEntity | EnemyEntity) => void): void => {
  world.store.forEach((entity) => {
    if (!isPlayer(entity) && !isEnemy(entity)) return;
    mutate(entity as PlayerEntity | EnemyEntity);
  });
};

describe('enemies stay inside the arena', () => {
  it('never lets a live enemy sit outside the bounds across a long run', () => {
    const world = buildWorld();
    world.start();
    stepWorld(world, 1_200);

    const escaped = enemyHulls(world).filter((ship) => ship.alive && outsideArena(ship));
    expect(escaped, `${escaped.length} enemies escaped`).toHaveLength(0);
  });

  it('holds an enemy that is deliberately placed outside the bounds', () => {
    const world = buildWorld();
    world.start();

    /* Enemies need a moment to appear before there is anything to plant. */
    for (let i = 0; i < 400 && enemyHulls(world).length === 0; i += 1) stepWorld(world, 1);

    /* Direct placement is the sharpest version of the test: no AI, no timing, just
       "is a hull outside the arena corrected". */
    let escaped = 0;
    moveShips(world, (ship) => {
      if (!isEnemy(ship)) return;
      ship.x = -400;
      ship.y = arena.height + 400;
      escaped += 1;
    });

    expect(escaped).toBeGreaterThan(0);
    stepWorld(world, 2);

    const stillOutside = enemyHulls(world).filter((ship) => ship.alive && outsideArena(ship));
    expect(stillOutside).toHaveLength(0);
  });

  /**
   * The emergent case, which is the one that matters.
   *
   * Corner the player so every chaser converges on the border: that is the only
   * situation where hulls actually try to leave. The player is made effectively
   * unkillable on purpose — a cornered player dies in a few seconds, the AI then
   * stops early because it returns when the player is gone, and the test passes
   * without ever exercising the rule.
   */
  it('holds the pack when the player is cornered against the border', () => {
    const world = buildWorld();
    world.start();

    moveShips(world, (ship) => {
      if (!isPlayer(ship)) return;
      ship.x = minX + 2;
      ship.y = minY + 2;
      // Survive the whole run so the AI keeps running.
      ship.maxHealth = 1_000_000;
      ship.health = 1_000_000;
      ship.invulnerableUntilMs = Number.MAX_SAFE_INTEGER;
    });

    stepWorld(world, 1_500);

    const enemies = enemyHulls(world).filter((ship) => ship.alive);
    /* Precondition: the situation must actually be happening, or this test proves
       nothing at all. */
    expect(enemies.length).toBeGreaterThan(0);

    const escaped = enemies.filter(outsideArena);

    expect(escaped, `${escaped.length} of ${enemies.length} enemies escaped`).toHaveLength(0);
  });
});
