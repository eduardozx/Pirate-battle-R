import type { AssetKey } from '../assets/assetManifest';
import type { EntityId, EnemyKind, Owner, WeaponId } from '../core/types';

/**
 * Simulation entity models.
 *
 * These are PLAIN DATA. No PixiJS, no React, no DOM. A renderer keeps a parallel
 * view object per id and copies from these structs each frame — the classic
 * "model / view split" that keeps 60 fps rendering from ever touching React.
 */

export interface ShipBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radians; 0 means the bow points toward +X. */
  angle: number;
  radius: number;
  /** Current / maximum velocity, used for momentum feel. */
  speed: number;
}

export interface HealthState {
  health: number;
  maxHealth: number;
}

export interface PlayerEntity extends ShipBody, HealthState {
  readonly id: EntityId;
  readonly kind: 'player';
  readonly assetKey: AssetKey;
  alive: boolean;
  /** Absolute simulation time (ms) until which further damage is ignored. */
  invulnerableUntilMs: number;
  /** Absolute simulation time (ms) of the next allowed shot, per weapon. */
  readonly cooldownUntilMs: Record<WeaponId, number>;
  hitFlashUntilMs: number;
  /** True while the hull is visibly burning. See `fx.deteriorationHealthRatio`. */
  burning: boolean;
}

export interface ChaserEntity extends ShipBody, HealthState {
  readonly id: EntityId;
  readonly kind: 'chaser';
  readonly assetKey: AssetKey;
  alive: boolean;
  spawnedAtMs: number;
  hitFlashUntilMs: number;
  /** True while the hull is visibly burning. */
  burning: boolean;
  /** Steering noise phase, advanced by the AI each step. */
  noisePhase: number;
  /** Set when the chaser latched on: it commits and detonates on contact. */
  detonating: boolean;
  detonateAtMs: number;
}

export interface ShooterEntity extends ShipBody, HealthState {
  readonly id: EntityId;
  readonly kind: 'shooter';
  readonly assetKey: AssetKey;
  alive: boolean;
  spawnedAtMs: number;
  hitFlashUntilMs: number;
  /** True while the hull is visibly burning. */
  burning: boolean;
  fireCooldownUntilMs: number;
  /** +1 or -1, flipped occasionally so it doesn't orbit predictably. */
  strafeSign: 1 | -1;
}

export type EnemyEntity = ChaserEntity | ShooterEntity;

export interface ProjectileEntity {
  readonly id: EntityId;
  readonly kind: 'projectile';
  readonly owner: Owner;
  readonly weaponId: WeaponId;
  readonly assetKey: AssetKey;
  x: number;
  y: number;
  /** Previous position, so collision can sweep the whole substep. */
  prevX: number;
  prevY: number;
  angle: number;
  speed: number;
  /**
   * Mutable so a fired shot can be scaled by a power-up at the moment of firing.
   * After that point it stays fixed, so the collision pass always reads a stable
   * value.
   */
  damage: number;
  readonly radius: number;
  readonly lifetimeMs: number;
  ageMs: number;
  alive: boolean;
  /** Damage is applied at most once per target, even across a swept segment. */
  readonly hitIds: Set<EntityId>;
}

export type EffectKind = 'muzzleFlash' | 'explosion' | 'woodImpact' | 'splash' | 'hullFire';

export interface EffectEntity {
  readonly id: EntityId;
  readonly kind: 'effect';
  readonly effectKind: EffectKind;
  readonly assetKey: AssetKey;
  x: number;
  y: number;
  angle: number;
  /** Multiplies the sprite scale over the effect's life. */
  scaleFrom: number;
  scaleTo: number;
  readonly durationMs: number;
  readonly frameDurationMs: number;
  ageMs: number;
  alive: boolean;
}

export type GameEntity = PlayerEntity | EnemyEntity | ProjectileEntity | EffectEntity;

export const isPlayer = (entity: GameEntity): entity is PlayerEntity => entity.kind === 'player';
export const isEnemy = (entity: GameEntity): entity is EnemyEntity =>
  entity.kind === 'chaser' || entity.kind === 'shooter';
export const isShip = (entity: GameEntity): entity is PlayerEntity | EnemyEntity =>
  isPlayer(entity) || isEnemy(entity);
export const isProjectile = (entity: GameEntity): entity is ProjectileEntity =>
  entity.kind === 'projectile';
export const isEffect = (entity: GameEntity): entity is EffectEntity => entity.kind === 'effect';

export const enemyKindOf = (entity: EnemyEntity): EnemyKind => entity.kind;
