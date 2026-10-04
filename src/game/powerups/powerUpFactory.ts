import { Rng } from '../core/rng';
import { TAU, distance } from '../core/math';
import {
  POWER_UPS,
  POWER_UP_IDS,
  SPAWNABLE_POWER_UPS,
  type PowerUpDefinition,
  type PowerUpId,
} from './powerUpCatalog';

/**
 * ============================================================================
 *  POWER-UP FACTORY — Factory Pattern
 * ============================================================================
 *
 * One responsibility: turn a catalogue key into a live power-up instance.
 *
 * It owns the WEIGHTED SPAWN TABLE, which is the piece most factories get wrong.
 * Because a random draw consumes a value from the caller's PRNG stream, adding a
 * new power-up would otherwise shift every subsequent random decision in the
 * match — making a seeded match irreproducible. So the roll happens ONCE, in the
 * factory, from the shared stream the rest of the game already uses: adding a
 * power-up can change which power-up appears, but never the trajectory of a ship.
 */

/**
 * A live power-up.
 *
 * `id` and `definition` are intentionally NOT readonly: the pool overwrites them
 * in place when a slot is reused. Declaring them readonly would force the pool to
 * allocate a replacement instance per spawn, which is exactly the churn this
 * design exists to avoid.
 */
export interface PowerUpInstance {
  id: PowerUpId;
  definition: PowerUpDefinition;
  x: number;
  y: number;
  /** Bobbing offset phase, so drifting power-ups do not move in lockstep. */
  driftPhase: number;
  /** Simulation time (ms) the crate despawns if it is never collected. */
  expiresAtMs: number;
  /** Downward drift speed, world units per second. */
  fallSpeed: number;
  alive: boolean;
}

export class PowerUpFactory {
  /** Precomputed cumulative weights, so picking is a single linear scan. */
  private readonly cumulativeWeights: number[] = [];

  constructor(
    private readonly rng: Rng,
    /** How long a crate floats before despawning uncollected. */
    private readonly crateLifetimeMs: number,
  ) {
    let total = 0;
    for (const definition of SPAWNABLE_POWER_UPS) {
      total += definition.spawnWeight;
      this.cumulativeWeights.push(total);
    }
  }

  /** Deterministic pick by key. Used by tests and by seeded scenarios. */
  createById(id: PowerUpId, x: number, y: number, nowMs: number): PowerUpInstance {
    return this.materialise(POWER_UPS[id], x, y, nowMs);
  }

  /**
   * Used when every weight is zero. Returning a catalogue entry rather than
   * throwing keeps a mis-tuned weight table from taking the whole match down.
   */
  private fallbackDefinition(): PowerUpDefinition {
    return POWER_UPS[POWER_UP_IDS[0] as PowerUpId];
  }

  /** Weighted pick, driven by the shared PRNG stream. */
  createRandom(x: number, y: number, nowMs: number): PowerUpInstance {
    const total = this.cumulativeWeights[this.cumulativeWeights.length - 1] ?? 0;
    if (total <= 0 || SPAWNABLE_POWER_UPS.length === 0) {
      return this.materialise(this.fallbackDefinition(), x, y, nowMs);
    }

    const roll = this.rng.next() * total;
    let index = this.cumulativeWeights.length - 1;
    for (let i = 0; i < this.cumulativeWeights.length; i += 1) {
      const bound = this.cumulativeWeights[i] as number;
      if (roll < bound) {
        index = i;
        break;
      }
    }

    const definition = SPAWNABLE_POWER_UPS[index] ?? this.fallbackDefinition();
    return this.materialise(definition, x, y, nowMs);
  }

  /**
   * A spawn point in open water, biased away from the player.
   *
   * A power-up that materialises under the player's hull is not a reward, it is a
   * free pickup nobody had to play for.
   */
  createAtSafeLocation(
    bounds: { readonly width: number; readonly height: number },
    playerX: number,
    playerY: number,
    isBlocked: (x: number, y: number) => boolean,
    nowMs: number,
    minPlayerDistance: number,
  ): PowerUpInstance {
    const margin = 80;
    let x = margin;
    let y = margin;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      x = this.rng.range(margin, bounds.width - margin);
      y = this.rng.range(margin, bounds.height - margin);
      if (!isBlocked(x, y) && distance(x, y, playerX, playerY) >= minPlayerDistance) break;
    }

    return this.createRandom(x, y, nowMs);
  }

  private materialise(
    definition: PowerUpDefinition,
    x: number,
    y: number,
    nowMs: number,
  ): PowerUpInstance {
    return {
      id: definition.id,
      definition,
      x,
      y,
      driftPhase: this.rng.angle(),
      /* The crate's lifetime is NOT the effect's duration. A crate must stay
         reachable long enough to be worth sailing to; a bonus must be short enough
         to stay interesting. Sharing one timer makes the pickup unreachable. */
      expiresAtMs: nowMs + this.crateLifetimeMs,
      fallSpeed: 0,
      alive: true,
    };
  }

  /** Drift is a function of time, not accumulated per frame: no drift error. */
  static driftY(instance: PowerUpInstance, nowMs: number): number {
    return instance.y + Math.sin(nowMs / 620 + instance.driftPhase) * 7;
  }

  /** Angle for the renderer; derived, so nothing has to be stored per frame. */
  static spin(instance: PowerUpInstance, nowMs: number): number {
    return (nowMs / 900 + instance.driftPhase) % TAU;
  }
}
