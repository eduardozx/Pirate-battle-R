import { ASSET, type AssetKey } from '../assets/assetManifest';
import { degreesToRadians } from '../core/math';
import type { Vec2 } from '../core/types';

/**
 * ============================================================================
 *  GAMEPLAY CONFIGURATION — every balance number lives here
 * ============================================================================
 *
 * Retuning the game is a data edit; no system, entity or renderer needs to know
 * a literal value. Values marked "tuned" were chosen against the reference
 * environment documented in docs/PERFORMANCE.md.
 */

export const TILE_SIZE = 64;

export interface WeaponConfig {
  readonly id: 'player_front' | 'player_left' | 'player_right' | 'enemy_shooter';
  readonly cooldownMs: number;
  readonly damage: number;
  readonly projectileSpeed: number;
  readonly projectileLifetimeMs: number;
  readonly projectileRadius: number;
  /** Muzzle positions in ship-local space: +X is the bow, +Y is starboard. */
  readonly muzzles: readonly Vec2[];
  readonly assetKey: AssetKey;
  readonly muzzleFlashAssetKey: AssetKey;
}

export interface ShipConfig {
  readonly assetKey: AssetKey;
  /** Collision radius. Deliberately smaller than the sprite for fair dodges. */
  readonly hitboxRadius: number;
  readonly maxHealth: number;
  readonly moveSpeed: number;
  readonly turnSpeedDegPerSec: number;
}

export interface PlayerConfig extends ShipConfig {
  readonly weapons: {
    readonly front: WeaponConfig;
    readonly left: WeaponConfig;
    readonly right: WeaponConfig;
  };
  readonly invulnerabilityMs: number;
}

export interface ChaserConfig extends ShipConfig {
  /**
   * Contact damage.
   *
   * Deliberately modest relative to player health: chasers arrive in packs, so a
   * large per-contact value compounds into an unavoidable death. The threat is
   * meant to come from having to keep moving, not from a single unblockable hit.
   */
  readonly contactDamage: number;
  readonly detonationDelayMs: number;
  /** Destroyed by the player's guns → scores. */
  readonly scoreOnPlayerKill: 1;
  /** Its own detonation against the player explicitly must NOT score. */
  readonly scoreOnSelfDestruct: 0;
  /** Speed gain as it closes the last stretch, so it always commits. */
  readonly rushSpeedMultiplier: number;
  readonly rushDistance: number;
  readonly steeringNoiseDegPerSec: number;
}

export interface ShooterConfig extends ShipConfig {
  readonly weapon: WeaponConfig;
  /** Below this range it backs off; inside `attackRange` it fires. */
  readonly preferredRange: number;
  readonly attackRange: number;
  readonly scoreOnPlayerKill: 1;
  readonly strafeFactor: number;
}

export interface SpawnConfig {
  readonly initialDelayMs: number;
  readonly minIntervalSeconds: number;
  readonly maxIntervalSeconds: number;
  /** Weighted distribution; both types must appear in a standard match. */
  readonly chaserWeight: number;
  readonly shooterWeight: number;
  readonly maxAlive: number;
  /** Spawn band hugging the arena border. */
  readonly edgeBandWidth: number;
  /** Obstacle clearance so ships never materialise inside an island. */
  readonly islandPadding: number;
  /** Guarantees no unavoidable immediate damage on spawn. */
  readonly minPlayerDistance: number;
  readonly maxPlacementAttempts: number;
}

export interface ArenaConfig {
  readonly width: number;
  readonly height: number;
  /** Distance kept between a hull and the visible arena edge. */
  readonly boundsPadding: number;
  readonly islandCount: number;
}

export interface MatchConfig {
  readonly durationSeconds: number;
  readonly countdownMs: number;
}

/**
 * Deeply immutable view of the config.
 *
 * A match records the config it was played with, and that record is sent to the
 * server as `configSnapshot`. `DeepReadonly` makes it a compile error to mutate a
 * recorded match's settings — which is what "each match uses a snapshot of the
 * configuration in effect when it started" has to mean in practice.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type GameConfigSnapshot = DeepReadonly<GameConfig>;

export interface GameConfig {
  readonly arena: ArenaConfig;
  readonly player: PlayerConfig;
  readonly chaser: ChaserConfig;
  readonly shooter: ShooterConfig;
  readonly spawn: SpawnConfig;
  readonly match: MatchConfig;
  readonly powerUps: {
    readonly initialDelayMs: number;
    readonly spawnIntervalMs: number;
    /** Hard memory ceiling: the pool never grows past this. */
    readonly poolSize: number;
    /** Distance at which sailing over a power-up collects it. */
    readonly pickupRadius: number;
    /**
     * How long a crate floats before despawning uncollected.
     *
     * Deliberately longer than any effect duration, and deliberately NOT the same
     * field: a crate 1 000 units away must still be there when a ship arrives.
     */
    readonly crateLifetimeMs: number;
    /** Spawns land clear of land and clear of the player. */
    readonly islandPadding: number;
    readonly minPlayerDistance: number;
  };
  readonly fx: {
    readonly muzzleFlashMs: number;
    readonly explosionMs: number;
    readonly woodImpactMs: number;
    readonly splashMs: number;
    readonly hitFlashMs: number;
    /**
     * Health ratio at or below which a hull is visibly burning.
     * 0.35 means "once a ship has lost more than half its health".
     */
    readonly deteriorationHealthRatio: number;
  };
}

const projectileDefaults = {
  projectileSpeed: 620,
  projectileRadius: 6,
};

export const DEFAULT_GAME_CONFIG: GameConfig = {
  arena: {
    width: 1536,
    height: 960,
    boundsPadding: 48,
    islandCount: 3,
  },

  player: {
    assetKey: ASSET.SHIP.PLAYER,
    hitboxRadius: 22,
    maxHealth: 100,
    moveSpeed: 210, // world units / second
    turnSpeedDegPerSec: 165,
    /**
     * Mercy window after taking damage.
     *
     * This is the single most important fairness setting in the game. Without it,
     * a broadside volley or a pair of converging chasers applies damage several
     * times within a single frame, and the player dies to something they had no
     * chance to react to. At 900 ms the player always gets a visible beat to turn
     * and escape before the next hit can land.
     */
    invulnerabilityMs: 900,
    weapons: {
      front: {
        id: 'player_front',
        cooldownMs: 380,
        damage: 34,
        ...projectileDefaults,
        projectileLifetimeMs: 1500,
        muzzles: [{ x: 58, y: 0 }],
        assetKey: ASSET.PROJECTILE.PLAYER,
        muzzleFlashAssetKey: ASSET.EFFECT.MUZZLE_FLASH,
      },
      // Broadside: three parallel shots fanned along the hull, as specified.
      left: {
        id: 'player_left',
        cooldownMs: 720,
        damage: 18,
        ...projectileDefaults,
        projectileSpeed: 540,
        projectileLifetimeMs: 1100,
        muzzles: [
          { x: 18, y: -34 },
          { x: 0, y: -36 },
          { x: -18, y: -34 },
        ],
        assetKey: ASSET.PROJECTILE.PLAYER,
        muzzleFlashAssetKey: ASSET.EFFECT.MUZZLE_FLASH,
      },
      right: {
        id: 'player_right',
        cooldownMs: 720,
        damage: 18,
        ...projectileDefaults,
        projectileSpeed: 540,
        projectileLifetimeMs: 1100,
        muzzles: [
          { x: 18, y: 34 },
          { x: 0, y: 36 },
          { x: -18, y: 34 },
        ],
        assetKey: ASSET.PROJECTILE.PLAYER,
        muzzleFlashAssetKey: ASSET.EFFECT.MUZZLE_FLASH,
      },
    },
  },

  chaser: {
    assetKey: ASSET.SHIP.CHASER,
    hitboxRadius: 20,
    maxHealth: 45,
    moveSpeed: 165,
    /**
     * Turn rate is the single most important number for a pursuer, because it
     * sets the minimum circle it can describe: radius = speed / angularSpeed.
     *
     * A chaser that spawns INSIDE that radius can never reach its target — it
     * simply orbits forever. At 165 u/s and 420°/s the radius is ~22 units,
     * well under the ~40-unit combined collision distance of two hulls, so the
     * chaser always converges instead of circling.
     */
    turnSpeedDegPerSec: 420,
    contactDamage: 18,
    detonationDelayMs: 260,
    scoreOnPlayerKill: 1,
    scoreOnSelfDestruct: 0,
    rushSpeedMultiplier: 1.45,
    rushDistance: 190,
    steeringNoiseDegPerSec: 26,
  },

  shooter: {
    assetKey: ASSET.SHIP.SHOOTER,
    hitboxRadius: 18,
    maxHealth: 60,
    moveSpeed: 145,
    turnSpeedDegPerSec: 95,
    preferredRange: 330,
    attackRange: 430,
    scoreOnPlayerKill: 1,
    strafeFactor: 0.6,
    weapon: {
      id: 'enemy_shooter',
      // A long cooldown is what makes shooters a positioning puzzle rather than a
      // damage race: the player must close the gap between shots, not tank them.
      cooldownMs: 1900,
      damage: 9,
      ...projectileDefaults,
      projectileSpeed: 400,
      projectileLifetimeMs: 2200,
      muzzles: [{ x: 44, y: 0 }],
      assetKey: ASSET.PROJECTILE.ENEMY,
      muzzleFlashAssetKey: ASSET.EFFECT.MUZZLE_FLASH,
    },
  },

  spawn: {
    initialDelayMs: 1200,
    minIntervalSeconds: 1.6,
    maxIntervalSeconds: 4.2,
    /**
     * Type weights. Shooters lead because they threaten from a distance and give
     * the player something to aim at; chasers alone produce an unsurvivable
     * rush that ends every match in ~20 s.
     */
    chaserWeight: 0.35,
    shooterWeight: 0.65,
    /**
     * Concurrency cap. Combined with spawn pacing this is the primary difficulty
     * dial: it bounds how much simultaneous pressure the player must survive.
     */
    maxAlive: 9,
    edgeBandWidth: 340,
    islandPadding: 96,
    minPlayerDistance: 420,
    maxPlacementAttempts: 24,
  },

  match: {
    durationSeconds: 90,
    countdownMs: 1200,
  },

  powerUps: {
    initialDelayMs: 6_000,
    spawnIntervalMs: 9_000,
    // Eight slots is enough for a readable arena while bounding memory and draw
    // calls. A full pool simply skips the spawn rather than growing.
    poolSize: 8,
    pickupRadius: 42,
    /* Roughly 15 s of sailing at the ship's top speed, which is what makes a
       distant crate worth crossing the arena for. */
    crateLifetimeMs: 24_000,
    islandPadding: 80,
    minPlayerDistance: 260,
  },

  fx: {
    muzzleFlashMs: 160,
    explosionMs: 520,
    woodImpactMs: 300,
    splashMs: 420,
    hitFlashMs: 130,
    deteriorationHealthRatio: 0.35,
  },
};

/**
 * Broadside firing offsets from the bow, in degrees.
 *
 * These are OFFSETS, not world directions. A broadside must stay perpendicular to
 * the bow as the ship turns, so the offset is added to the ship's own heading:
 *
 *   worldAngle = player.angle + broadsideDirection(side)
 *
 * Treating these constants as absolute world angles happens to look right while the
 * ship sails along +X, which is exactly why the bug survived: the shots left the
 * hull sideways when the ship was horizontal and shot out of the BOW when it was
 * vertical.
 */
export const BROADSIDE_DIRECTION_DEG = { left: -90, right: 90 } as const;

/** Signed offset from the bow to a broadside, in radians. */
export const broadsideDirection = (side: 'left' | 'right'): number =>
  degreesToRadians(BROADSIDE_DIRECTION_DEG[side]);
