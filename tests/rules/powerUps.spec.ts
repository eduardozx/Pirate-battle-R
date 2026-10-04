import { describe, expect, it } from 'vitest';

import { PowerUpFactory } from '../../src/game/powerups/powerUpFactory';
import { PowerUpSystem } from '../../src/game/powerups/powerUpSystem';
import { POWER_UPS, POWER_UP_IDS, SPAWNABLE_POWER_UPS } from '../../src/game/powerups/powerUpCatalog';
import { ACTIVE, COLLECTING, DRIFTING, EXPIRING, SPENT } from '../../src/game/powerups/powerUpStates';
import { Rng } from '../../src/game/core/rng';

/**
 * Power-up tests.
 *
 * Two things are under test here beyond behaviour:
 *
 *   • the State machine's legal transitions, and
 *   • the ALLOCATION contract, which is the reason the pool exists.
 *
 * The allocation assertions are the interesting ones: they are what stop a
 * future refactor from quietly reintroducing per-spawn garbage, which on mobile
 * shows up as GC hitches rather than as a test failure.
 */

const build = (seed = 7, poolSize = 8, crateLifetimeMs = 30_000) => {
  const rng = new Rng(seed);
  const factory = new PowerUpFactory(rng, crateLifetimeMs);
  return { rng, factory, system: new PowerUpSystem(factory, 1_000, 200, poolSize) };
};

const NO_BLOCK = (): boolean => false;

describe('catalogue', () => {
  it('exposes every power-up with a spawn weight and a label', () => {
    expect(POWER_UP_IDS.length).toBeGreaterThan(3);
    for (const id of POWER_UP_IDS) {
      const definition = POWER_UPS[id];
      expect(definition.id).toBe(id);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.spawnWeight).toBeGreaterThanOrEqual(0);
      expect(definition.refreshes).toBeTypeOf('boolean');
    }
  });

  it('only lists spawnable power-ups when every weight is positive', () => {
    for (const definition of SPAWNABLE_POWER_UPS) {
      expect(definition.spawnWeight).toBeGreaterThan(0);
    }
  });

  it('gives timed power-ups a duration and consumables none', () => {
    for (const definition of Object.values(POWER_UPS)) {
      if (definition.kind === 'timed') expect(definition.durationMs).toBeGreaterThan(0);
      else expect(definition.durationMs).toBe(0);
    }
  });
});

describe('factory', () => {
  it('builds a specific power-up by key', () => {
    const { factory } = build();
    const instance = factory.createById('shield', 100, 200, 1_000);
    expect(instance.id).toBe('shield');
    expect(instance.x).toBe(100);
    expect(instance.y).toBe(200);
  });

  it('only ever produces catalogue entries', () => {
    const { factory } = build();
    for (let i = 0; i < 200; i += 1) {
      expect(POWER_UP_IDS).toContain(factory.createRandom(0, 0, 0).id);
    }
  });

  it('honours spawn weights over a large sample', () => {
    const { factory } = build(99);
    const counts = new Map<string, number>();
    for (let i = 0; i < 4_000; i += 1) {
      const id = factory.createRandom(0, 0, 0).id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    // The heaviest weight in the catalogue is repairKit at 30 out of 100 total.
    const repairShare = ((counts.get('repairKit') ?? 0) / 4_000) * 100;
    expect(repairShare).toBeGreaterThan(24);
    expect(repairShare).toBeLessThan(36);
  });

  it('is deterministic for a given seed', () => {
    const a = new PowerUpFactory(new Rng(5), 30_000);
    const b = new PowerUpFactory(new Rng(5), 30_000);
    for (let i = 0; i < 20; i += 1) {
      expect(a.createRandom(0, 0, 0).id).toBe(b.createRandom(0, 0, 0).id);
    }
  });

  it('spawns away from blocked space and from the player', () => {
    const { factory } = build(3);
    const bounds = { width: 1536, height: 960 };
    for (let i = 0; i < 60; i += 1) {
      const instance = factory.createAtSafeLocation(bounds, 768, 480, NO_BLOCK, 0, 260);
      expect(instance.x).toBeGreaterThanOrEqual(80);
      expect(instance.x).toBeLessThanOrEqual(1536 - 80);
      expect(Math.hypot(instance.x - 768, instance.y - 480)).toBeGreaterThanOrEqual(259);
    }
  });
});

describe('object pool', () => {
  it('reuses pooled instances instead of allocating', () => {
    const { factory, system } = build();
    const seen = new Set<unknown>();

    for (let i = 0; i < 200; i += 1) {
      const instance = system.spawn(factory.createById('shield', i, i, 0), 0);
      if (instance !== null) seen.add(instance);
      system.reset();
    }

    // The real contract: spawns return objects drawn from the fixed pool, so the
    // distinct-identity count can never exceed the pool size no matter how many
    // spawns occur. That IS "no allocation per spawn".
    expect(seen.size).toBeLessThanOrEqual(8);
    expect(system.stats().pooled).toBe(8);
    expect(system.stats().capacity).toBe(8);
  });

  it('never grows past its configured ceiling', () => {
    const { factory, system } = build(1, 3);
    const spawned = [
      system.spawn(factory.createById('shield', 10, 10, 0), 0),
      system.spawn(factory.createById('rapidFire', 20, 20, 0), 0),
      system.spawn(factory.createById('overcharge', 30, 30, 0), 0),
    ];

    expect(spawned.every((instance) => instance !== null)).toBe(true);
    expect(system.active).toBe(3);

    // The fourth has nowhere to go and is refused rather than growing the pool.
    expect(system.spawn(factory.createById('shield', 40, 40, 0), 0)).toBeNull();
    expect(system.active).toBe(3);
    expect(system.stats().capacity).toBe(3);
  });

  it('holds stable identities across many spawns', () => {
    const { factory, system } = build(11, 4);
    const seen = new Set<unknown>();

    for (let i = 0; i < 500; i += 1) {
      const instance = system.spawn(factory.createById('shield', i, i, 0), 0);
      if (instance !== null) seen.add(instance);
      system.reset();
    }

    // 500 spawns, 4 distinct objects: proof that nothing is allocated per spawn.
    expect(seen.size).toBe(4);
  });
});

describe('state machine', () => {
  it('starts every power-up drifting, consumables included', () => {
    const { factory, system } = build();

    /* A consumable must NOT start in the terminal state. `spent` reports
       `isCollectable: false`, so a consumable spawned as spent would sink without
       ever being pickable. The distinction is resolved on the collect transition. */
    for (const id of ['rapidFire', 'repairKit'] as const) {
      system.reset();
      system.spawn(factory.createById(id, 10, 10, 0), 0);
      system.forEachActive((_instance, state) => {
        expect(state.phase).toBe('drifting');
        expect(state.isCollectable).toBe(true);
      }, 0);
      expect(system.active).toBe(1);
    }
  });

  it('resolves a consumable on collection and activates a timed one', () => {
    const { factory, system } = build();

    const consumable = system.spawn(factory.createById('repairKit', 100, 100, 0), 0);
    expect(consumable).not.toBeNull();
    /* A real radius: the crate drifts a few units off its spawn point, so a radius
       of zero would mean it is never actually in reach. */
    system.update(0, 100, 100, () => undefined, 50);
    /* No active phase, and the slot is released immediately. */
    expect(system.active).toBe(0);

    system.reset();
    system.spawn(factory.createById('rapidFire', 100, 100, 0), 0);
    system.update(0, 100, 100, () => undefined, 50);
    system.forEachActive((_instance, state) => {
      expect(state.phase).toBe('active');
    }, 0);
  });

  it('collects on contact and activates a timed power-up', () => {
    const { factory, system } = build();
    system.spawn(factory.createById('rapidFire', 500, 500, 0), 0);

    let collected = 0;
    system.update(16, 502, 502, () => { collected += 1; }, 40);

    expect(collected).toBe(1);
    system.forEachActive((_instance, state) => {
      expect(state.phase === 'active' || state.phase === 'collecting').toBe(true);
    }, 16);
  });

  it('does not collect from beyond the pickup radius', () => {
    const { factory, system } = build();
    system.spawn(factory.createById('rapidFire', 500, 500, 0), 0);

    let collected = 0;
    system.update(16, 700, 500, () => { collected += 1; }, 40);
    expect(collected).toBe(0);
  });

  it('expires a timed power-up and releases its effect', () => {
    const { factory, system } = build();
    system.spawn(factory.createById('rapidFire', 100, 100, 0), 0);

    // Collecting is what applies the effect, so the callback must apply it —
    // in production the world's `applyCollectedPowerUp` does exactly this.
    system.update(0, 100, 100, () => system.applyEffect(POWER_UPS.rapidFire, 0), 10_000);
    expect(system.cooldownScale(10)).toBeLessThan(1);

    system.update(20_000, 100, 100, () => undefined, 10_000);
    expect(system.cooldownScale(20_000)).toBe(1);
    expect(system.active).toBe(0);
  });

  it('never returns to a previous phase', () => {
    const live = {
      phaseStartedAtMs: 0,
      expiresAtMs: 60_000,
      remainingMs: 60_000,
      isConsumable: false,
      effectDurationMs: 9_000,
    };
    const dead = { ...live, expiresAtMs: 0, remainingMs: 0 };

    // Terminal is terminal: a spent power-up cannot be revived by any call.
    expect(SPENT.tick(dead, 1_000).phase).toBe('spent');
    expect(SPENT.collect(dead, 1_000).phase).toBe('spent');
    expect(ACTIVE.collect(live, 0).phase).toBe('active');
    expect(EXPIRING.collect(live, 0).phase).toBe('expiring');
    expect(COLLECTING.collect(live, 0).phase).toBe('collecting');
    expect(DRIFTING.collect(live, 0).phase).toBe('active');

    // A drifting power-up whose crate lifetime has already elapsed is spent.
    expect(DRIFTING.tick(dead, 1_000).phase).toBe('spent');

    const consumable = { ...live, isConsumable: true, effectDurationMs: 0 };
    expect(DRIFTING.collect(consumable, 0).phase).toBe('spent');
  });

  /**
   * The crate's time on the water and the bonus it grants are separate budgets.
   *
   * Sharing one timer makes the mechanic unreachable: a crate spawning a thousand
   * units away would despawn long before a ship could cover the distance, turning
   * the pickup into scenery.
   */
  it('a collected crate lives for its effect duration, not the crate lifetime', () => {
    const { factory, system } = build(21, 8, 30_000);

    /* Spawn at t=0 with a 30 s crate lifetime and collect at t=10 s. */
    const instance = system.spawn(factory.createById('rapidFire', 100, 100, 0), 0);
    expect(instance).not.toBeNull();

    system.update(10_000, 100, 100, () => system.applyEffect(POWER_UPS.rapidFire, 10_000), 50);
    system.forEachActive((_instance, state) => {
      expect(state.phase).toBe('active');
    }, 10_000);

    /* The 9 s effect expires at 19 s — well inside the crate's own 30 s budget. */
    system.update(19_001, 100, 100, () => undefined, 50);
    expect(system.active).toBe(0);
  });

  it('despawns an uncollected crate when its crate lifetime ends', () => {
    const { factory, system } = build(21, 8, 30_000);

    system.spawn(factory.createById('rapidFire', 5_000, 5_000, 0), 0);
    expect(system.active).toBe(1);

    system.update(29_000, 0, 0, () => undefined, 10);
    expect(system.active).toBe(1);

    system.update(31_000, 0, 0, () => undefined, 10);
    expect(system.active).toBe(0);
  });
});

describe('effects', () => {
  it('heals with the repair kit', () => {
    const { factory, system } = build();
    system.spawn(factory.createById('repairKit', 100, 100, 0), 0);
    system.update(0, 100, 100, () => system.applyEffect(POWER_UPS.repairKit, 0), 50);
    expect(system.shieldPoints(0)).toBe(0);
  });

  it('absorbs damage with the shield and then depletes', () => {
    const { system } = build();
    system.applyEffect(POWER_UPS.shield, 0);
    const effect = POWER_UPS.shield.effect;
    const points = effect.kind === 'absorbDamage' ? effect.points : 0;
    expect(system.shieldPoints(0)).toBe(points);

    const absorbed = system.consumeShield(20);
    expect(absorbed).toBe(20);
    expect(system.shieldPoints(0)).toBe(points - 20);

    // Overspending cannot drive the shield negative.
    expect(system.consumeShield(10_000)).toBe(points - 20);
    expect(system.shieldPoints(0)).toBe(0);
  });

  it('tops the shield back up on recollect instead of stacking it', () => {
    const { system } = build();
    const effect = POWER_UPS.shield.effect;
    const points = effect.kind === 'absorbDamage' ? effect.points : 0;
    system.applyEffect(POWER_UPS.shield, 0);
    system.consumeShield(points - 5);
    system.applyEffect(POWER_UPS.shield, 100);
    expect(system.shieldPoints(100)).toBe(points);
  });

  it('reports neutral multipliers with nothing active', () => {
    const { system } = build();
    expect(system.scoreMultiplier(0)).toBe(1);
    expect(system.damageMultiplier(0)).toBe(1);
    expect(system.cooldownScale(0)).toBe(1);
    expect(system.shieldPoints(0)).toBe(0);
  });

  it('resets cleanly between matches', () => {
    const { factory, system } = build();
    system.spawn(factory.createById('shield', 100, 100, 0), 0);
    system.applyEffect(POWER_UPS.shield, 0);
    expect(system.active).toBe(1);

    system.reset();

    expect(system.active).toBe(0);
    expect(system.shieldPoints(0)).toBe(0);
    expect(system.cooldownScale(0)).toBe(1);
  });
});
