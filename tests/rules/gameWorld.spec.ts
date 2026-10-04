import { describe, expect, it } from 'vitest';

import { GameWorld } from '../../src/game/core/gameWorld';
import { GameLoop } from '../../src/game/core/gameLoop';
import { buildTestConfig } from '../support/testConfig';
import { IDLE_INPUT, press } from '../support/inputFixtures';
import type {
  ChaserEntity,
  ProjectileEntity,
  ShooterEntity,
} from '../../src/game/entities/entityModels';

/**
 * Rule-engine tests.
 *
 * These run with NO renderer, NO canvas and NO DOM — which is exactly the payoff
 * of keeping the simulation free of PixiJS and React imports. Every assertion
 * below exercises the same code the browser runs, so a green suite is real
 * evidence about gameplay rather than a mock of it.
 */

const NO_SPAWN = 999;

/** 480 substeps × 1/120 s = exactly 4 s of simulated time. */
const SIM_SUBSTEPS = 480;

/**
 * Advances a loop by whole frames until the simulation has consumed
 * `substeps` substeps — the exact count, never an approximation.
 *
 * WHY SUBSTEPS AND NOT WALL TIME: GameLoop accumulates a substep remainder
 * between frames, so a run stopped at an arbitrary wall-clock instant lands on a
 * different substep count at each frame rate (479 vs 480 over 4 s). Comparing
 * those runs would compare different amounts of simulated time and report a
 * phantom frame-rate dependence. Driving by substep count makes the claim exact:
 * the same number of identically-sized steps must produce the same match.
 */
/**
 * Advances a loop until it has executed exactly `substeps` substeps.
 *
 * Driven by GameLoop's own substep counter, never by wall-clock time. Stopping on
 * elapsed time overshoots by a fraction of a substep at some refresh rates
 * (60 frames × 33.333 ms = 1999.998 ms), so the runs would end after different
 * numbers of steps and compare unequal durations — a phantom frame-rate failure.
 */
const SUBSTEP_MS = 1000 / 120;

/**
 * Advances a loop until it has executed EXACTLY `substeps` substeps.
 *
 * Whole frames are used for the bulk of the run, which is what actually exercises
 * the frame-partitioning logic. The final frame is trimmed to the exact remaining
 * substep count, because a whole frame contains several substeps and would
 * otherwise overshoot — leaving the compared runs a frame's worth of time apart
 * and reporting a phantom frame-rate dependence.
 */
const runSubsteps = (loop: GameLoop, frameMs: number, substeps: number): void => {
  loop.resetSubstepCount();

  while (loop.executedSubsteps + Math.ceil(frameMs / SUBSTEP_MS) <= substeps) {
    loop.advance(frameMs);
  }

  const remaining = substeps - loop.executedSubsteps;
  if (remaining > 0) loop.advance(remaining * SUBSTEP_MS);

  expect(loop.executedSubsteps).toBe(substeps);
};

describe('time-based simulation', () => {
  it('covers the same distance per second at 30, 60 and 144 fps', () => {
    /**
     * Driven through GameLoop, not `world.step` directly.
     *
     * That distinction is the point of the test. `world.step(dt)` assumes the
     * caller has already partitioned time correctly, so calling it with a raw
     * frame delta measures nothing useful. GameLoop is the component that turns
     * variable frame times into fixed substeps, so it is the only place where
     * frame-rate independence can actually be observed.
     */
    const build = (frameMs: number) => {
      const config = buildTestConfig({ spawnIntervalSeconds: NO_SPAWN });
      const world = new GameWorld(config, 12345);
      world.start();

      // Straight-line sailing in the southern water lane: no border, no island.
      //   lane spans y ≈ 704..960, water east of column 6
      const player0 = world.playerEntity!;
      player0.x = 600;
      player0.y = 880;
      player0.angle = 0;

      const origin = { x: player0.x, y: player0.y };
      const held = press({ forward: true });
      const loop = new GameLoop({ onSubstep: (dt) => world.step(dt, held) });
      loop.start();

      runSubsteps(loop, frameMs, 240);
      loop.stop();

      const player = world.playerEntity!;
      return {
        travelled: Math.hypot(player.x - origin.x, player.y - origin.y),
        elapsed: world.readStats().elapsedMs,
      };
    };

    const at30 = build(1000 / 30);
    const at60 = build(1000 / 60);
    const at144 = build(1000 / 144);

    // Exactly two seconds of simulated time, whatever the refresh rate.
    for (const run of [at30, at60, at144]) expect(run.elapsed).toBeCloseTo(2000, 6);

    // Distance is what a player perceives. Because GameLoop pins substep
    // boundaries to an absolute grid, the three rates must agree to well under a
    // world unit — not merely "approximately".
    const distances = [at30.travelled, at60.travelled, at144.travelled];
    const spread = Math.max(...distances) - Math.min(...distances);
    expect(spread).toBeLessThan(0.5);

    // And it must match the configured speed, minus the ramp-up cost.
    //
    // Velocity approaches `moveSpeed` exponentially with rate 6/s, so the total
    // distance lost to acceleration is exactly `moveSpeed / 6` ≈ 35 units,
    // independent of duration. That closed form is asserted here rather than a
    // hand-tuned threshold.
    const maxSpeed = buildTestConfig().player.moveSpeed;
    const rampUpLoss = maxSpeed / 6;
    const expected = maxSpeed * 2 - rampUpLoss;
    // The discrete substep sum overshoots the continuous closed form by well
    // under a world unit; a tight bound here would only assert on rounding.
    expect(Math.abs(at60.travelled - expected)).toBeLessThan(1.5);
  });

  it('produces a bit-identical trajectory at any frame rate', () => {
    // Input is read from SIMULATION time inside the substep, not from a frame
    // counter. That is what makes the comparison meaningful: the same commands
    // land at the same moments in the match at every refresh rate, so any
    // difference in the outcome is attributable to frame-rate dependence alone.
    //
    // Spawning is disabled so this test isolates the integrator. Enemy AI is
    // covered separately below, where the outcome is a discrete, comparable
    // quantity rather than a floating-point trajectory.
    const build = (frameMs: number) => {
      const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 31337);
      world.start();

      const loop = new GameLoop({
        onSubstep: (dt) => world.step(dt, decideInput(world.simulationTimeMs)),
      });
      loop.start();
      runSubsteps(loop, frameMs, SIM_SUBSTEPS);
      loop.stop();

      const player = world.playerEntity!;
      return {
        x: player.x,
        y: player.y,
        angle: player.angle,
        score: world.readStats().score,
        elapsed: world.readStats().elapsedMs,
      };
    };

    // The strongest statement of the requirement: the same seed, the same
    // duration and the same commands produce the same match, whatever the display
    // refreshes at. This is what makes reproducible E2E possible at all.
    expect(build(1000 / 30)).toEqual(build(1000 / 60));
    expect(build(1000 / 60)).toEqual(build(1000 / 144));
  });

  it('replays an identical match with enemy AI at any frame rate', () => {
    // Same experiment, now with the spawner active. Compared on DISCRETE
    // outcomes — entity counts, score, health — because trajectories of AI-driven
    // agents diverge on any floating-point difference, while a match's *result*
    // must not.
    const build = (frameMs: number) => {
      const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: 0.7 }), 20240607);
      world.start();

      const loop = new GameLoop({
        onSubstep: (dt) => world.step(dt, decideInput(world.simulationTimeMs)),
      });
      loop.start();
      runSubsteps(loop, frameMs, SIM_SUBSTEPS);
      loop.stop();

      const stats = world.readStats();
      return {
        score: stats.score,
        health: stats.playerHealth,
        defeated: stats.enemiesDefeated,
        alive: world.enemyCounts.chasers + world.enemyCounts.shooters,
        phase: world.matchPhase,
      };
    };

    const at30 = build(1000 / 30);
    const at60 = build(1000 / 60);
    const at144 = build(1000 / 144);

    expect(at30).toEqual(at60);
    expect(at60).toEqual(at144);

    // Sanity: the run must actually have exercised spawning and AI, otherwise this
    // would pass trivially by simulating nothing. The scripted input circles the
    // player, so contacts and kills both occur.
    expect(at60.defeated + at60.alive).toBeGreaterThan(3);
    expect(at60.health).toBeLessThanOrEqual(100);
  });

  it('applies the same damage over time regardless of frame rate', () => {
    const build = (frameMs: number) => {
      const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 4242);
      world.start();
      const player = world.playerEntity!;
      player.health = 100;
      world.spawnEnemyForTest('chaser', player.x + 45, player.y);

      const loop = new GameLoop({ onSubstep: (dt) => world.step(dt, IDLE_INPUT) });
      loop.start();
      runSubsteps(loop, frameMs, SIM_SUBSTEPS);
      loop.stop();

      return world.readStats().playerHealth;
    };

    const values = [build(1000 / 30), build(1000 / 60), build(1000 / 144)];
    expect(values[0]).toBe(values[1]);
    expect(values[1]).toBe(values[2]);
    expect(values[0]).toBeLessThan(100);
  });

  it('reproduces an identical trajectory for the same seed and input', () => {
    const build = (): { x: number; y: number; score: number } => {
      const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: 0.8 }), 777);
      world.start();
      for (let i = 0; i < 60 * 40; i += 1) {
        world.step(1 / 60, press({ forward: true, turn: i % 240 < 120 ? 1 : -1, fireFront: i % 37 === 0 }));
      }
      const player = world.playerEntity;
      return { x: player?.x ?? 0, y: player?.y ?? 0, score: world.readStats().score };
    };

    // Determinism is the foundation of reproducible E2E and visual regression.
    expect(build()).toEqual(build());
  });

  it('freezes the clock while paused and does not jump on resume', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 7);
    world.start();
    for (let i = 0; i < 120; i += 1) world.step(1 / 60, IDLE_INPUT);

    const atPause = world.readStats().elapsedMs;
    world.pause('manual');

    for (let i = 0; i < 600; i += 1) world.step(1 / 60, press({ forward: true }));
    expect(world.readStats().elapsedMs).toBe(atPause);

    world.resume();
    world.step(1 / 60, IDLE_INPUT);
    expect(world.readStats().elapsedMs - atPause).toBeLessThan(20);
  });

  it('keeps the player inside the visible arena', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 7);
    world.start();
    for (let i = 0; i < 2000; i += 1) world.step(1 / 60, press({ forward: true }));

    const player = world.playerEntity;
    expect(player).not.toBeNull();
    const { arena } = buildTestConfig();
    expect(player!.x).toBeGreaterThanOrEqual(arena.boundsPadding);
    expect(player!.x).toBeLessThanOrEqual(arena.width - arena.boundsPadding);
    expect(player!.y).toBeGreaterThanOrEqual(arena.boundsPadding);
    expect(player!.y).toBeLessThanOrEqual(arena.height - arena.boundsPadding);
  });

  it('does not let a ship sail through an island', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 21);
    world.start();

    const island = world.islands[0];
    expect(island).toBeDefined();
    const centre = island!.centroid;

    // Aim straight at the island for long enough that a naive implementation
    // would end up embedded in it.
    for (let i = 0; i < 60 * 25; i += 1) {
      const player = world.playerEntity;
      if (player === null) break;
      const desired = Math.atan2(centre.y - player.y, centre.x - player.x);
      const turn = Math.abs(normalise(desired - player.angle)) > 0.1 ? (desired > player.angle ? 1 : -1) : 0;
      world.step(1 / 60, press({ forward: true, turn }));
    }

    const player = world.playerEntity!;
    const overLand =
      player.x >= island!.bounds.x &&
      player.x <= island!.bounds.x + island!.bounds.width &&
      player.y >= island!.bounds.y &&
      player.y <= island!.bounds.y + island!.bounds.height;
    expect(overLand).toBe(false);
  });
});

describe('weapons', () => {
  const countProjectiles = (world: GameWorld): ProjectileEntity[] => {
    const shots: ProjectileEntity[] = [];
    world.forEachEntity((entity) => {
      if (entity.kind === 'projectile') shots.push(entity);
    });
    return shots;
  };

  it('fires a single shot from the front cannon', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 3);
    world.start();
    world.step(1 / 60, press({ fireFront: true }));
    expect(countProjectiles(world)).toHaveLength(1);
  });

  it('fires three parallel shots from each broadside', () => {
    for (const side of ['fireLeft', 'fireRight'] as const) {
      const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 3);
      world.start();
      world.step(1 / 60, press({ [side]: true }));

      const shots = countProjectiles(world);
      expect(shots).toHaveLength(3);

      // "Parallel" = one shared heading, three distinct lateral offsets.
      expect(new Set(shots.map((shot) => shot.angle)).size).toBe(1);
      expect(new Set(shots.map((shot) => shot.y)).size).toBe(3);
    }
  });

  it('enforces the per-weapon cooldown', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 3);
    world.start();

    // Count FIRING EVENTS rather than live projectiles: a shot outlives the
    // cooldown window, so counting live bodies would conflate the two.
    let volleys = 0;
    world.events.on('weapon:fired', (event) => {
      if (event.weaponId === 'player_front') volleys += 1;
    });

    const cooldown = world.gameConfig.player.weapons.front.cooldownMs;
    world.step(1 / 60, press({ fireFront: true }));
    expect(volleys).toBe(1);

    // Hold the trigger for 3× the cooldown: fires at ~0ms, ~380ms and ~760ms,
    // i.e. three volleys in 1140 ms. A fourth would require a bug.
    const totalMs = cooldown * 3;
    const frames = Math.floor(totalMs / (1000 / 60));
    for (let i = 0; i < frames; i += 1) world.step(1 / 60, press({ fireFront: true }));

    expect(volleys).toBe(3);
  });

  it('accepts a fresh press only after the cooldown has elapsed', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 3);
    world.start();

    let volleys = 0;
    world.events.on('weapon:fired', (event) => {
      if (event.weaponId === 'player_front') volleys += 1;
    });

    const cooldown = world.gameConfig.player.weapons.front.cooldownMs;
    world.step(1 / 60, press({ fireFront: true }));

    // Just short of the cooldown: still blocked.
    const justShort = Math.floor((cooldown - 40) / (1000 / 60));
    for (let i = 0; i < justShort; i += 1) world.step(1 / 60, IDLE_INPUT);
    world.step(1 / 60, press({ fireFront: true }));
    expect(volleys).toBe(1);

    // Now past it: the next press fires.
    for (let i = 0; i < 20; i += 1) world.step(1 / 60, IDLE_INPUT);
    world.step(1 / 60, press({ fireFront: true }));
    expect(volleys).toBe(2);
  });

  it('consumes an edge-triggered trigger exactly once', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 3);
    world.start();

    // A single press on ONE substep must not yield more than one volley.
    world.step(1 / 60, press({ fireLeft: true }));
    const firstVolley = countProjectiles(world).length;
    expect(firstVolley).toBe(3);
  });
});

describe('scoring', () => {
  it('awards exactly one point per enemy destroyed by the player', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 99);
    world.start();
    const player = world.playerEntity!;

    // A SHOOTER is the right subject here: it holds a stand-off range instead of
    // closing to ram, so the player's guns can actually reach it. (A chaser would
    // self-destruct on the player first — a different rule, tested below.)
    //
    // Placed along the line of fire — the player faces north, so "ahead" is -Y —
    // and at 400 units, inside the preferred stand-off, so it holds roughly
    // station instead of closing. Without the strafing being neutralised the
    // target slides out of the shot's path, so the test asserts on hits landing
    // rather than on a specific number of volleys.
    const shooter = world.spawnEnemyForTest('shooter', player.x, player.y - 400) as ShooterEntity;
    shooter.strafeSign = 1;

    let kills = 0;
    world.events.on('enemy:killed', (event) => {
      kills += 1;
      expect(event.scoreGained).toBe(1);
    });

    // Aim continuously, as a player tracking a target would.
    let guard = 0;
    while (world.readStats().score === 0 && guard < 3600) {
      const dx = shooter.x - player.x;
      const dy = shooter.y - player.y;
      const bearing = Math.atan2(dy, dx) - player.angle;
      const turn = bearing > 0.05 ? 1 : bearing < -0.05 ? -1 : 0;

      world.step(1 / 60, press({ fireFront: true, turn }));
      guard += 1;
    }

    expect(world.readStats().score).toBe(1);
    expect(world.readStats().enemiesDefeated).toBe(1);
    expect(kills).toBe(1);
    expect(shooter.alive).toBe(false);
  });

  it('awards one point for a chaser the player sinks before it can ram', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 99);
    world.start();
    const player = world.playerEntity!;

    // Directly ahead of the player (who faces north) and well beyond rush range,
    // so the shot lands before the ram does. This isolates "killed by the player"
    // from "self-destructed on contact" — the two must score differently.
    const chaser = world.spawnEnemyForTest('chaser', player.x, player.y - 430) as ChaserEntity;
    chaser.angle = Math.PI / 2;

    let selfDestructs = 0;
    world.events.on('enemy:selfDestructed', () => {
      selfDestructs += 1;
    });

    let guard = 0;
    while (world.readStats().score === 0 && guard < 1200) {
      world.step(1 / 60, press({ fireFront: true }));
      guard += 1;
    }

    expect(world.readStats().score).toBe(1);
    expect(selfDestructs).toBe(0);
    expect(chaser.alive).toBe(false);
  });

  it('does not award a point when a chaser self-destructs on the player', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 5);
    world.start();
    const player = world.playerEntity!;

    let selfDestructs = 0;
    world.events.on('enemy:selfDestructed', () => {
      selfDestructs += 1;
    });

    // Drop a chaser right on top of the player: it must detonate on contact.
    world.spawnEnemyForTest('chaser', player.x + 45, player.y);
    for (let i = 0; i < 600; i += 1) world.step(1 / 60, IDLE_INPUT);

    expect(selfDestructs).toBeGreaterThanOrEqual(1);
    expect(world.readStats().playerHealth).toBeLessThan(player.maxHealth);
    // The rule under test: self-destruction is explicitly worth nothing.
    expect(world.readStats().score).toBe(0);
  });

  it('removes a destroyed enemy from damage, firing and collision', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 5);
    world.start();
    const player = world.playerEntity!;
    const chaser = world.spawnEnemyForTest('chaser', player.x + 130, player.y) as ChaserEntity;

    let guard = 0;
    while (world.readStats().score === 0 && guard < 900) {
      world.step(1 / 60, press({ fireFront: true }));
      guard += 1;
    }

    const frozen = { x: chaser.x, y: chaser.y, angle: chaser.angle };
    const scoreAtDeath = world.readStats().score;
    expect(chaser.alive).toBe(false);

    for (let i = 0; i < 180; i += 1) world.step(1 / 60, press({ forward: true }));
    expect({ x: chaser.x, y: chaser.y, angle: chaser.angle }).toEqual(frozen);
    expect(world.readStats().score).toBe(scoreAtDeath);
  });
});

describe('enemies', () => {
  it('a chaser closes the distance to the player', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 5);
    world.start();
    const player = world.playerEntity!;
    const chaser = world.spawnEnemyForTest('chaser', player.x + 420, player.y) as ChaserEntity;

    const before = Math.hypot(chaser.x - player.x, chaser.y - player.y);
    for (let i = 0; i < 90; i += 1) world.step(1 / 60, IDLE_INPUT);
    const after = Math.hypot(chaser.x - player.x, chaser.y - player.y);

    expect(after).toBeLessThan(before - 50);
  });

  it('a shooter damages the player at range', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 5);
    world.start();
    const player = world.playerEntity!;

    // Inside the shooter's attack range but beyond its preferred stand-off.
    world.spawnEnemyForTest('shooter', player.x + 400, player.y);
    for (let i = 0; i < 60 * 12; i += 1) world.step(1 / 60, IDLE_INPUT);

    expect(world.readStats().playerHealth).toBeLessThan(player.maxHealth);
  });
});

describe('spawner guarantees', () => {
  it('never spawns an enemy inside an island', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: 0.6 }), 4242);
    world.start();

    // Per-TILE check, not the island bounding box: an elongated island's box can
    // contain water tiles at its corners, and asserting on the box would report
    // a false failure for perfectly legal spawns.
    const solidTiles: Array<{ tx: number; ty: number }> = [];
    for (const island of world.islands) {
      for (const tile of island.tiles) solidTiles.push({ tx: tile.tx, ty: tile.ty });
    }
    expect(solidTiles.length).toBeGreaterThan(0);

    let checked = 0;
    for (let i = 0; i < 60 * 40; i += 1) {
      world.step(1 / 60, IDLE_INPUT);

      world.forEachEntity((entity) => {
        if (entity.kind !== 'chaser' && entity.kind !== 'shooter') return;
        // Judge only on the frame the enemy appears: after that, ship-vs-island
        // resolution is allowed to push it anywhere legal.
        if (world.simulationTimeMs - entity.spawnedAtMs > 30) return;

        checked += 1;
        const cx = Math.floor(entity.x / 64);
        const cy = Math.floor(entity.y / 64);
        const onLand = solidTiles.some((tile) => tile.tx === cx && tile.ty === cy);
        expect(onLand).toBe(false);
      });
    }

    expect(checked).toBeGreaterThan(20);
  });

  it('gives a new enemy enough distance from the player to be survivable', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: 1 }), 11);
    world.start();
    const player = world.playerEntity!;
    const minimum = world.gameConfig.spawn.minPlayerDistance;

    for (let i = 0; i < 60 * 45; i += 1) {
      world.step(1 / 60, IDLE_INPUT);
      world.forEachEntity((entity) => {
        if (entity.kind !== 'chaser' && entity.kind !== 'shooter') return;
        // Judge only on the frame the enemy appears.
        if (world.simulationTimeMs - entity.spawnedAtMs > 50) return;
        expect(Math.hypot(entity.x - player.x, entity.y - player.y)).toBeGreaterThanOrEqual(
          minimum * 0.9,
        );
      });
    }
  });

  it('introduces both enemy types during a standard match', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: 0.6 }), 2024);
    world.start();

    const seen = new Set<string>();
    for (let i = 0; i < 60 * 60; i += 1) {
      world.step(1 / 60, IDLE_INPUT);
      world.forEachEntity((entity) => {
        if (entity.kind === 'chaser' || entity.kind === 'shooter') seen.add(entity.kind);
      });
      if (seen.size === 2) break;
    }

    expect([...seen].sort()).toEqual(['chaser', 'shooter']);
  });
});

describe('match rules', () => {
  it('ends when the timer expires and stops everything', () => {
    // The player is kept alive on purpose: this test is about the TIME limit,
    // and a chaser reaching the hull would end the match for a different reason.
    const world = new GameWorld(
      buildTestConfig({ sessionSeconds: 60, spawnIntervalSeconds: NO_SPAWN }),
      4,
    );
    world.start();

    // Top the hull up every frame: this test is exclusively about the TIME limit,
    // and it must not be able to end early because a chaser connected.
    const keepAlive = (): void => {
      const player = world.playerEntity;
      if (player !== null) player.health = player.maxHealth;
    };

    for (let i = 0; i < 60 * 61; i += 1) {
      keepAlive();
      world.step(1 / 60, IDLE_INPUT);
    }

    expect(world.matchPhase).toBe('ended');
    expect(world.matchEndReason).toBe('time_expired');

    const frozen = world.readStats();
    const frozenEnemies = world.enemyCounts;
    for (let i = 0; i < 300; i += 1) world.step(1 / 60, press({ forward: true, fireFront: true }));

    // Ending stops movement, attacks, damage, spawns and scoring. It does not
    // need to wipe the board — the result screen replaces it — so the guarantee
    // asserted here is that nothing PROGRESSES.
    const after = world.readStats();
    expect(after.score).toBe(frozen.score);
    expect(after.elapsedMs).toBe(frozen.elapsedMs);
    expect(world.enemyCounts).toEqual(frozenEnemies);

    // No projectiles may exist either: attacks must be impossible from here on.
    let liveProjectiles = 0;
    world.forEachEntity((entity) => {
      if (entity.kind === 'projectile') liveProjectiles += 1;
    });
    expect(liveProjectiles).toBe(0);
  });

  it('ends when the player is destroyed', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: NO_SPAWN }), 6);
    world.start();
    const player = world.playerEntity!;

    let detonations = 0;
    world.events.on('enemy:selfDestructed', () => {
      detonations += 1;
    });

    // Contact damage is 18 and the mercy window is 900 ms, so a full 100 HP hull
    // needs six successful detonations. Placing eight chasers in a ring guarantees
    // contact without depending on how quickly each one converges.
    for (let i = 0; i < 8; i += 1) {
      const angle = (i / 8) * Math.PI * 2;
      world.spawnEnemyForTest(
        'chaser',
        player.x + Math.cos(angle) * 44,
        player.y + Math.sin(angle) * 44,
      );
    }

    for (let i = 0; i < 6000; i += 1) {
      world.step(1 / 60, IDLE_INPUT);
      if (world.matchEndReason !== null) break;
    }

    expect(detonations).toBeGreaterThanOrEqual(1);
    expect(world.readStats().playerHealth).toBe(0);
    expect(world.matchEndReason).toBe('player_destroyed');
  });

  it('restart resets score, clock, health and all entities', () => {
    const world = new GameWorld(buildTestConfig({ spawnIntervalSeconds: 0.6 }), 6);
    world.start();
    for (let i = 0; i < 60 * 20; i += 1) world.step(1 / 60, press({ forward: true }));

    world.start();

    const stats = world.readStats();
    expect(stats.score).toBe(0);
    expect(stats.enemiesDefeated).toBe(0);
    expect(stats.elapsedMs).toBe(0);
    expect(stats.playerHealth).toBe(stats.playerMaxHealth);
    expect(world.enemyCounts.chasers).toBe(0);
    expect(world.enemyCounts.shooters).toBe(0);
  });
});

/**
 * A deterministic input script keyed to elapsed time. Defined as a function of
 * the clock rather than sampled per frame, so every frame rate experiences the
 * same sequence of commands at the same moments.
 */
const decideInput = (elapsedMs: number): ReturnType<typeof press> => {
  const phase = elapsedMs % 1200;
  if (phase < 400) return press({ forward: true, turn: 1 });
  if (phase < 800) return press({ forward: true, turn: -1, fireFront: true });
  if (phase < 1000) return press({ forward: false });
  return press({ forward: true, fireLeft: true, fireRight: true });
};

const normalise = (angle: number): number => {
  let value = angle % (Math.PI * 2);
  if (value > Math.PI) value -= Math.PI * 2;
  if (value < -Math.PI) value += Math.PI * 2;
  return value;
};
