/**
 * Core value types shared by every simulation module.
 *
 * INVARIANT: nothing under `src/game/**` may import `pixi.js` or `react`, with the
 * single exception of the isolated view modules in `entities/renderers/` and
 * `render/`. The simulation has to be runnable headless.
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Stable numeric identifier. Recycled through pools, never reused inside a match. */
export type EntityId = number;

export type Owner = 'player' | 'enemy';
export type EnemyKind = 'chaser' | 'shooter';
export type WeaponId = 'player_front' | 'player_left' | 'player_right' | 'enemy_shooter';

export type MatchPhase = 'booting' | 'running' | 'paused' | 'ended';
export type PauseReason = 'manual' | 'focus-lost' | 'hidden-tab' | null;
export type EndReason = 'time_expired' | 'player_destroyed';

/** Logical input intents. Systems consume intents, never raw DOM events. */
export interface InputState {
  /** -1 rotate left, 0 idle, +1 rotate right. */
  turn: -1 | 0 | 1;
  /** true while the "sail forward" control is held. */
  forward: boolean;
  /** Edge-triggered: consumed by the weapon system on the next simulation step. */
  fireFront: boolean;
  fireLeft: boolean;
  fireRight: boolean;
}

export type GameEventMap = {
  'weapon:fired': { weaponId: WeaponId; x: number; y: number; angle: number };
  'entity:hit': { targetId: EntityId; damage: number; x: number; y: number };
  'enemy:killed': { enemyId: EntityId; x: number; y: number; scoreGained: number };
  'enemy:selfDestructed': { enemyId: EntityId; x: number; y: number };
  'player:damaged': { remainingHealth: number; maxHealth: number };
  /**
   * A power-up was collected or its effect ended.
   *
   * This exists because the HUD is republished from events, not from a per-frame
   * poll. Without it, picking up a bonus emits nothing the session listens to, so
   * the indicator never appears until some unrelated event — an enemy kill, a
   * point of damage — happens to fire and drags a fresh snapshot along with it.
   */
  'powerup:changed': { powerUpId: string | null };
  'projectile:spent': { x: number; y: number; onIsland: boolean };
  'match:ended': { reason: EndReason; score: number; durationMs: number };
  'pause:changed': { paused: boolean; reason: PauseReason };
};

export type GameEventName = keyof GameEventMap;
