import type { AssetKey } from '../assets/assetManifest';

/**
 * ============================================================================
 *  POWER-UP CATALOGUE — the single definition of every power-up
 * ============================================================================
 *
 * Adding a power-up means adding ONE entry here. The factory, the state machine,
 * the spawner and the renderer all derive from this catalogue, so the core of the
 * game never changes when the content grows.
 *
 * Every field is plain data for two reasons: it keeps the catalogue trivially
 * serialisable for remote config, and it means a designer can balance a new
 * power-up without touching a system file.
 */

export type PowerUpId =
  | 'repairKit'
  | 'rapidFire'
  | 'shield'
  | 'doubleScore'
  | 'overcharge';

export type PowerUpKind = 'consumable' | 'timed';

/** Which stat a power-up moves. Keeps effects data-driven instead of a switch. */
export type PowerUpEffect =
  | { readonly kind: 'heal'; readonly amount: number }
  | { readonly kind: 'weaponCooldownScale'; readonly factor: number }
  | { readonly kind: 'absorbDamage'; readonly points: number }
  | { readonly kind: 'scoreMultiplier'; readonly factor: number }
  | { readonly kind: 'damageScale'; readonly factor: number };

export interface PowerUpDefinition {
  readonly id: PowerUpId;
  readonly label: string;
  /** Abstract art key. The catalogue never references a file path. */
  readonly assetKey: AssetKey;
  /** 'timed' powers expire on their own; 'consumable' ones apply instantly. */
  readonly kind: PowerUpKind;
  /** Duration in ms. Meaningless for consumables. */
  readonly durationMs: number;
  /** Relative spawn weight. Zero removes a power-up without deleting it. */
  readonly spawnWeight: number;
  readonly effect: PowerUpEffect;
  /** Stacking the same power-up refreshes rather than doubling. */
  readonly refreshes: boolean;
  readonly tint: number;
}

export const POWER_UPS: Readonly<Record<PowerUpId, PowerUpDefinition>> = {
  repairKit: {
    id: 'repairKit',
    label: 'Repair Kit',
    assetKey: 'effect.hullFire',
    kind: 'consumable',
    durationMs: 0,
    spawnWeight: 30,
    effect: { kind: 'heal', amount: 35 },
    refreshes: false,
    tint: 0x5ad46a,
  },
  rapidFire: {
    id: 'rapidFire',
    label: 'Rapid Fire',
    assetKey: 'effect.muzzleFlash',
    kind: 'timed',
    durationMs: 9_000,
    spawnWeight: 22,
    effect: { kind: 'weaponCooldownScale', factor: 0.45 },
    refreshes: true,
    tint: 0xf2c14e,
  },
  shield: {
    id: 'shield',
    label: 'Timber Shield',
    assetKey: 'effect.explosion',
    kind: 'timed',
    durationMs: 12_000,
    spawnWeight: 18,
    effect: { kind: 'absorbDamage', points: 45 },
    refreshes: true,
    tint: 0x6fc7ff,
  },
  doubleScore: {
    id: 'doubleScore',
    label: 'Double Score',
    assetKey: 'effect.waterSplash',
    kind: 'timed',
    durationMs: 15_000,
    spawnWeight: 16,
    effect: { kind: 'scoreMultiplier', factor: 2 },
    refreshes: true,
    tint: 0xffd76b,
  },
  overcharge: {
    id: 'overcharge',
    label: 'Overcharge',
    assetKey: 'effect.woodImpact',
    kind: 'timed',
    durationMs: 8_000,
    spawnWeight: 14,
    effect: { kind: 'damageScale', factor: 1.75 },
    refreshes: false,
    tint: 0xff8a5c,
  },
};

/** Iteration order is stable, so a seeded weighted pick is reproducible. */
export const POWER_UP_IDS: readonly PowerUpId[] = Object.keys(POWER_UPS) as PowerUpId[];

export const SPAWNABLE_POWER_UPS: readonly PowerUpDefinition[] = POWER_UP_IDS.map(
  (id) => POWER_UPS[id],
).filter((definition) => definition.spawnWeight > 0);
