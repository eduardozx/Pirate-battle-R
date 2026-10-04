import type { GameConfig, WeaponConfig } from '../../game/config/gameConfig';
import type { MatchConfigSummary } from './contracts';

/**
 * Stable configuration fingerprint.
 *
 * The ranking compares only matches played with the SAME configuration, so we
 * need a key that is identical for identical settings and different as soon as
 * any balance value moves.
 *
 * STABILITY RULES:
 *   • key order is sorted, so object literal order cannot change the hash;
 *   • numbers are normalised, so `60` and `60.0` hash the same;
 *   • the hash is FNV-1a, chosen because it is tiny, dependency-free and good
 *     enough to detect a config change — it is not a security primitive and is
 *     not used as one.
 */

/** Recursively sorts object keys so serialisation is order-independent. */
const canonicalise = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'number' ? normaliseNumber(value) : value;
  }

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry === undefined) continue;
    out[key] = canonicalise(entry);
  }
  return out;
};

/** Collapses `-0`, and strips float noise from values like 0.30000000000000004. */
const normaliseNumber = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? 0 : rounded;
};

const stableStringify = (value: unknown): string => JSON.stringify(canonicalise(value));

/** FNV-1a, 32-bit. */
export const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, via shifts to stay in 32-bit integer space.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * The subset of the config that meaningfully distinguishes a match.
 *
 * Cosmetic values (muzzle offsets, effect timings, art metadata) are excluded on
 * purpose: changing a sprite must not split a player's ranking into two tables.
 */
const RANKING_RELEVANT_CONFIG = (config: GameConfig): unknown => ({
  player: {
    health: config.player.maxHealth,
    speed: config.player.moveSpeed,
    turnSpeed: config.player.turnSpeedDegPerSec,
    invulnerability: config.player.invulnerabilityMs,
    weapons: {
      front: weapon(config.player.weapons.front),
      left: weapon(config.player.weapons.left),
      right: weapon(config.player.weapons.right),
    },
  },
  chaser: {
    health: config.chaser.maxHealth,
    speed: config.chaser.moveSpeed,
    turnSpeed: config.chaser.turnSpeedDegPerSec,
    damage: config.chaser.contactDamage,
    score: config.chaser.scoreOnPlayerKill,
  },
  shooter: {
    health: config.shooter.maxHealth,
    speed: config.shooter.moveSpeed,
    turnSpeed: config.shooter.turnSpeedDegPerSec,
    score: config.shooter.scoreOnPlayerKill,
    weapon: weapon(config.shooter.weapon),
  },
  spawn: {
    min: config.spawn.minIntervalSeconds,
    max: config.spawn.maxIntervalSeconds,
    maxAlive: config.spawn.maxAlive,
    chaserWeight: config.spawn.chaserWeight,
    shooterWeight: config.spawn.shooterWeight,
  },
  match: { durationSeconds: config.match.durationSeconds },
});

const weapon = (w: WeaponConfig): unknown => ({
  cooldownMs: w.cooldownMs,
  damage: w.damage,
  projectileSpeed: w.projectileSpeed,
  projectileLifetimeMs: w.projectileLifetimeMs,
  projectileRadius: w.projectileRadius,
  // Muzzle COUNT and firing ANGLE matter for balance, while exact muzzle offsets
  // are cosmetic and must not split a player's ranking.
  shotCount: w.muzzles.length,
});

export const configFingerprint = (config: GameConfig): string =>
  fnv1a(stableStringify(RANKING_RELEVANT_CONFIG(config)));

/**
 * The fingerprint that a match is recorded under.
 *
 * Includes the two player-facing options, because a 60-second match and a
 * 180-second match are genuinely different challenges and must not share a table.
 */
export const matchConfigSummary = (
  config: GameConfig,
  sessionSeconds: number,
  spawnIntervalSeconds: number,
): MatchConfigSummary => ({
  sessionSeconds,
  spawnIntervalSeconds,
  fingerprint: `${configFingerprint(config)}-${sessionSeconds}-${spawnIntervalSeconds}`,
});
