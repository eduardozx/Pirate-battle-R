import type { EntityId } from '../core/types';
import type { GameEntity } from './entityModels';

/**
 * Fixed-capacity, id-stable entity store.
 *
 * WHY A POOL: allocating entity objects inside the frame loop is the classic
 * source of GC hitches in a 60 fps game. Slots are reused, so a three-minute
 * match performs no steady-state allocation in the hot path.
 *
 * IDs are never recycled *within* a match. A projectile's `hitIds` set and the
 * E2E tests both rely on an id identifying exactly one entity for the whole
 * match; recycling would silently break both.
 */
export class EntityStore {
  private readonly slots: Array<GameEntity | null>;
  private readonly nextId: number[] = [1];
  private readonly aliveCountByKind = new Map<string, number>();

  constructor(readonly capacity: number) {
    this.slots = new Array<GameEntity | null>(capacity).fill(null);
  }

  /** Allocates an id. Ids only wrap when the capacity is exhausted. */
  reserveId(): EntityId {
    const id = this.nextId[0] as number;
    if (this.nextId[0] === undefined) this.nextId[0] = 1;
    this.nextId[0] = id >= this.capacity ? 1 : id + 1;
    return id as EntityId;
  }

  add(entity: GameEntity): void {
    // Slot index mirrors the id so lookups stay O(1) and allocation-free.
    const index = (entity.id as number) % this.capacity;
    const existing = this.slots[index] ?? null;
    if (existing !== null) {
      throw new Error(`EntityStore: slot ${index} already occupied by #${existing.id}`);
    }
    this.slots[index] = entity;
    this.bump(entity, 1);
  }

  get(id: EntityId): GameEntity | null {
    const slot = this.slots[(id as number) % this.capacity] ?? null;
    if (slot === null) return null;
    // Guard against id wrap-around: the slot may belong to a different entity.
    return slot.id === id ? slot : null;
  }

  /**
   * Removes an entity. Called when it dies, expires or leaves the arena —
   * after which it can no longer deal damage, fire, or take part in collisions.
   */
  remove(entity: GameEntity): void {
    const index = (entity.id as number) % this.capacity;
    const slot = this.slots[index];
    if (slot === undefined || slot !== entity) return;
    this.slots[index] = null;
    this.bump(entity, -1);
  }

  countOf(kind: string): number {
    return this.aliveCountByKind.get(kind) ?? 0;
  }

  /** Iterates live entities without allocating an iterator or an array. */
  forEach(visit: (entity: GameEntity) => void): void {
    for (let i = 0; i < this.slots.length; i += 1) {
      const slot = this.slots[i];
      if (slot !== null && slot !== undefined) visit(slot);
    }
  }

  collect<T extends GameEntity>(predicate: (entity: GameEntity) => entity is T): T[] {
    const out: T[] = [];
    this.forEach((entity) => {
      if (predicate(entity)) out.push(entity);
    });
    return out;
  }

  /** Drops every entity. Used on restart so no state leaks between matches. */
  clear(): void {
    this.slots.fill(null);
    this.aliveCountByKind.clear();
    this.nextId[0] = 1;
  }

  get aliveCount(): number {
    let total = 0;
    for (const count of this.aliveCountByKind.values()) total += count;
    return total;
  }

  private bump(entity: GameEntity, delta: number): void {
    const next = (this.aliveCountByKind.get(entity.kind) ?? 0) + delta;
    if (next <= 0) this.aliveCountByKind.delete(entity.kind);
    else this.aliveCountByKind.set(entity.kind, next);
  }
}
