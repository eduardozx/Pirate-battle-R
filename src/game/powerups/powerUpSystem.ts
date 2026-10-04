import type { PowerUpDefinition, PowerUpId } from './powerUpCatalog';
import { POWER_UPS } from './powerUpCatalog';
import {
  ACTIVE,
  COLLECTING,
  DRIFTING,
  EXPIRING,
  INITIAL_STATE,
  SPENT,
  initialStateFor,
  type PowerUpContext,
  type PowerUpState,
} from './powerUpStates';
import { PowerUpFactory, type PowerUpInstance } from './powerUpFactory';

/**
 * ============================================================================
 *  POWER-UP SYSTEM — object pool + state machine driver
 * ============================================================================
 *
 * TWO PRODUCTION TARGETS, both structural rather than incidental:
 *
 *   1. ZERO steady-state allocation. Every instance is created once at boot and
 *      recycled forever. `acquire` mutates a dormant instance in place instead of
 *      `new`, so a three-minute match performs no allocations here at all. This is
 *      what prevents GC pauses on low-end mobile, where a hitch is far more
 *      damaging than on desktop.
 *
 *   2. ZERO dead references. Instances are never nulled; they are marked inactive.
 *      An array of pooled objects has stable identities, so a view holding a
 *      reference to instance #7 keeps pointing at instance #7 — and simply sees it
 *      inactive. Recycling by nulling would force every consumer to re-check and
 *      re-bind on each spawn.
 *
 * The system is also allocator-free in the strict sense: `forEachActive` passes a
 * callback instead of returning a filtered array, and no per-frame array, object
 * or closure is created in `update`.
 */

const DEFAULT_POOL_SIZE = 12;

export interface ActivePowerUp {
  readonly instance: PowerUpInstance;
  readonly state: PowerUpState;
  readonly context: PowerUpContext;
}

export class PowerUpSystem {
  private readonly pool: PowerUpInstance[] = [];
  private readonly contexts: PowerUpContext[] = [];
  private readonly states: PowerUpState[] = [];

  /** Index into `pool`, or -1 when dormant. Parallel arrays, no wrapper objects. */
  private readonly activeIndices: number[] = [];
  private activeCount = 0;

  /** Effect currently applied to the player, if any. */
  private activeEffectId: PowerUpId | null = null;
  private effectExpiresAtMs = 0;
  /** Shield points left to absorb. Depletes independently of the timer. */
  private shieldRemaining = 0;

  constructor(
    private readonly factory: PowerUpFactory,
    private readonly spawnIntervalMs: number,
    private readonly minPlayerDistance: number,
    poolSize = DEFAULT_POOL_SIZE,
  ) {
    for (let i = 0; i < poolSize; i += 1) {
      const definition = POWER_UPS.repairKit;
      this.pool.push({
        id: definition.id,
        definition,
        x: 0,
        y: 0,
        driftPhase: 0,
        expiresAtMs: 0,
        fallSpeed: 0,
        alive: false,
      });
      // Contexts are allocated once and mutated for the instance's lifetime.
      this.contexts.push({
        phaseStartedAtMs: 0,
        expiresAtMs: 0,
        remainingMs: 0,
        isConsumable: true,
        effectDurationMs: 0,
      });
      this.states.push(INITIAL_STATE);
    }
  }

  /* --------------------------------------------------------------- spawning */

  /**
   * Copies a factory-built instance into a pool slot.
   *
   * The FACTORY decides WHAT spawns (catalogue key, weighted roll, safe location);
   * the POOL decides WHERE it lives. Keeping that split is what lets a new
   * power-up be added without touching allocation, and lets tests drive a
   * specific key through the exact same path production uses.
   *
   * @returns the pooled instance, or null when every slot is busy. Returning null
   *          rather than growing the array is deliberate: the pool size is a hard
   *          memory ceiling, and a bounded world is what keeps frame time
   *          predictable on weak hardware.
   */
  spawn(source: PowerUpInstance, nowMs: number): PowerUpInstance | null {
    const slot = this.acquireSlot();
    if (slot === -1) return null;

    const instance = this.pool[slot] as PowerUpInstance;
    const context = this.contexts[slot] as PowerUpContext;

    instance.id = source.id;
    instance.definition = source.definition;
    instance.x = source.x;
    instance.y = source.y;
    instance.driftPhase = source.driftPhase;
    instance.expiresAtMs = source.expiresAtMs;
    instance.alive = true;

    context.phaseStartedAtMs = nowMs;
    context.expiresAtMs = source.expiresAtMs;
    context.remainingMs = Math.max(0, source.expiresAtMs - nowMs);
    context.isConsumable = source.definition.kind === 'consumable';
    context.effectDurationMs = source.definition.durationMs;

    this.states[slot] = initialStateFor(source.definition);
    this.activate(slot);
    return instance;
  }

  /** Factory → pool handoff for a random power-up at an explicit position. */
  spawnRandom(x: number, y: number, nowMs: number): PowerUpInstance | null {
    return this.spawn(this.factory.createRandom(x, y, nowMs), nowMs);
  }

  /** Pool slot backing an instance, for renderers that bind per slot. */
  slotOf(instance: PowerUpInstance): number | null {
    const index = this.pool.indexOf(instance);
    return index === -1 ? null : index;
  }

  /**
   * Finds a free slot.
   *
   * The search starts at `nextScan` and wraps, so consecutive spawns land in
   * DIFFERENT slots rather than always reclaiming slot 0. Spreading the usage
   * matters because a view bound to a slot keeps its texture until that slot's
   * power-up kind changes — always reusing one slot would also mean always
   * rebuilding one sprite while the others sat stale.
   *
   * The scan is bounded by the pool size (8), so the cost is negligible.
   */
  private acquireSlot(): number {
    for (let offset = 0; offset < this.pool.length; offset += 1) {
      const index = (this.nextScan + offset) % this.pool.length;
      if (!(this.pool[index] as PowerUpInstance).alive) {
        this.nextScan = (index + 1) % this.pool.length;
        return index;
      }
    }
    return -1;
  }

  private nextScan = 0;

  private activate(slot: number): void {
    this.activeIndices[this.activeCount] = slot;
    this.activeCount += 1;
  }

  private deactivate(slot: number): void {
    (this.pool[slot] as PowerUpInstance).alive = false;
    this.activeCount -= 1;

    // Swap-remove: O(1) and order-independent, which matters because iteration is
    // by index and a hole would leave a stale entry behind.
    const last = this.activeCount;
    this.activeIndices[this.activeCount] = this.activeIndices[last] as number;
    this.activeIndices.length = last;
  }

  /* ------------------------------------------------------------------ update */

  /**
   * Advances every active instance.
   *
   * `onCollect` is invoked the frame a power-up is collected. It is passed as a
   * bound method reference rather than a fresh closure, so the caller does not
   * allocate one per frame.
   */
  update(
    nowMs: number,
    playerX: number,
    playerY: number,
    onCollect: (id: PowerUpInstance['id'], definition: PowerUpDefinition) => void,
    pickupRadius: number,
  ): void {
    for (let i = this.activeCount - 1; i >= 0; i -= 1) {
      const slot = this.activeIndices[i] as number;
      const instance = this.pool[slot] as PowerUpInstance;
      const context = this.contexts[slot] as PowerUpContext;
      let state = this.states[slot] as PowerUpState;

      context.remainingMs = Math.max(0, context.expiresAtMs - nowMs);

      const driftedY = PowerUpFactory.driftY(instance, nowMs);
      const dx = instance.x - playerX;
      const dy = driftedY - playerY;
      const withinReach = dx * dx + dy * dy <= pickupRadius * pickupRadius;

      if (state.isCollectable && withinReach) {
        state = state.collect(context, nowMs);
        this.states[slot] = state;
        if (state === ACTIVE || (state === SPENT && instance.definition.kind === 'consumable')) {
          onCollect(instance.id, instance.definition);
        }
      }

      state = state.tick(context, nowMs);
      this.states[slot] = state;

      if (state === SPENT) {
        if (instance.definition.kind === 'timed' && this.activeEffectId === instance.id) {
          this.clearEffect();
        }
        this.deactivate(slot);
      }
    }
  }

  /**
   * Iterates live instances without allocating.
   *
   * Deliberately callback-based: returning an array, or spreading an iterator,
   * would allocate per frame, which is precisely what this subsystem avoids.
   */
  forEachActive(visit: (instance: PowerUpInstance, state: PowerUpState, nowMs: number) => void, nowMs: number): void {
    for (let i = 0; i < this.activeCount; i += 1) {
      const slot = this.activeIndices[i] as number;
      visit(this.pool[slot] as PowerUpInstance, this.states[slot] as PowerUpState, nowMs);
    }
  }

  get active(): number {
    return this.activeCount;
  }

  get capacity(): number {
    return this.pool.length;
  }

  /* ------------------------------------------------------------------ effects */

  /**
   * Registers an active timed effect on the player.
   *
   * `refreshes` decides whether re-collecting extends the timer or is ignored,
   * which is what keeps a lucky player from stacking an unbounded bonus.
   */
  applyEffect(definition: PowerUpDefinition, nowMs: number): void {
    if (definition.kind === 'consumable') return;

    if (this.activeEffectId !== definition.id) {
      this.activeEffectId = definition.id;
      this.effectExpiresAtMs = nowMs + definition.durationMs;
      if (definition.effect.kind === 'absorbDamage') this.shieldRemaining = definition.effect.points;
      return;
    }

    if (definition.effect.kind === 'absorbDamage') {
      // Re-collecting tops the shield back up rather than stacking it
      // multiplicatively, so it stays a rescue tool and not a strategy.
      this.shieldRemaining = definition.effect.points;
    }

    if (definition.refreshes) {
      this.effectExpiresAtMs = nowMs + definition.durationMs;
    }
  }

  /** Multiplier applied to score right now. 1 when nothing is active. */
  scoreMultiplier(nowMs: number): number {
    const effect = this.currentEffect(nowMs);
    return effect !== null && effect.kind === 'scoreMultiplier' ? effect.factor : 1;
  }

  /** Multiplier applied to projectile damage right now. */
  damageMultiplier(nowMs: number): number {
    const effect = this.currentEffect(nowMs);
    return effect !== null && effect.kind === 'damageScale' ? effect.factor : 1;
  }

  /** Multiplier applied to weapon cooldowns right now. Below 1 = faster. */
  cooldownScale(nowMs: number): number {
    const effect = this.currentEffect(nowMs);
    return effect !== null && effect.kind === 'weaponCooldownScale' ? effect.factor : 1;
  }

  /** Remaining shield points. 0 when no shield is active. */
  shieldPoints(nowMs: number): number {
    if (this.activeEffectIdAt(nowMs) === null) return 0;
    return this.shieldRemaining;
  }

  /** Spends shield points. Returns the amount actually absorbed. */
  consumeShield(points: number): number {
    const absorbed = Math.min(this.shieldRemaining, Math.max(0, points));
    this.shieldRemaining -= absorbed;
    return absorbed;
  }

  activeEffectIdAt(nowMs: number): PowerUpId | null {
    return this.currentEffect(nowMs) === null ? null : this.activeEffectId;
  }

  effectRemainingMs(nowMs: number): number {
    return this.activeEffectId === null ? 0 : Math.max(0, this.effectExpiresAtMs - nowMs);
  }

  private currentEffect(nowMs: number): PowerUpDefinition['effect'] | null {
    if (this.activeEffectId === null) return null;
    if (nowMs < this.effectExpiresAtMs) return POWER_UPS[this.activeEffectId].effect;
    this.clearEffect();
    return null;
  }

  private clearEffect(): void {
    this.activeEffectId = null;
    this.effectExpiresAtMs = 0;
    this.shieldRemaining = 0;
  }

  /* --------------------------------------------------------------- lifecycle */

  /**
   * Returns every instance to the pool and clears player effects.
   *
   * Called on match end and restart: no power-up, timer or shield may survive into
   * a new match.
   */
  reset(): void {
    for (let i = 0; i < this.pool.length; i += 1) {
      (this.pool[i] as PowerUpInstance).alive = false;
      this.states[i] = INITIAL_STATE;
    }
    this.activeIndices.length = 0;
    this.activeCount = 0;
    this.clearEffect();
  }

  /** Pool occupancy, for the performance harness and the memory test. */
  stats(): { readonly active: number; readonly capacity: number; readonly pooled: number } {
    return { active: this.activeCount, capacity: this.pool.length, pooled: this.pool.length };
  }

  get spawnInterval(): number {
    return this.spawnIntervalMs;
  }

  get minDistance(): number {
    return this.minPlayerDistance;
  }
}

export { DRIFTING, COLLECTING, ACTIVE, EXPIRING, SPENT };
export type { PowerUpInstance };
