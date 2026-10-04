import type { EntityId } from '../../core/types';

/**
 * Keeps one view object per live entity, keyed by id.
 *
 * The renderer is read-only with respect to the simulation: it copies values
 * out of the entity structs each frame. This pool is what makes that cheap —
 * views are created once per entity and reused, so a three-minute match creates
 * a few hundred display objects in total rather than thousands per second.
 *
 * `beginSync` / `endSync` implement a mark-and-sweep: any view not touched this
 * frame belongs to an entity that died or expired. `endSync` hands each stale
 * view to the caller for detachment BEFORE destroying it, so the renderer never
 * has to guess which display object belonged to which id.
 */
export interface DisposableView {
  destroy(): void;
}

export class ViewPool<T extends DisposableView> {
  private readonly views = new Map<EntityId, T>();
  private readonly touched = new Set<EntityId>();

  beginSync(): void {
    this.touched.clear();
  }

  /** Returns the existing view for an id, or creates one via `factory`. */
  resolve(id: EntityId, factory: () => T): T {
    this.touched.add(id);
    const existing = this.views.get(id);
    if (existing !== undefined) return existing;

    const created = factory();
    this.views.set(id, created);
    return created;
  }

  /**
   * Pre-populates the pool with views created by `factory`, without assigning them
   * to specific entity IDs yet. Useful for fixed-size pools (e.g., enemy health bars)
   * where views are allocated upfront and then bound to entities on demand.
   */
  prime(factory: () => T): void {
    const created = factory();
    // Use a temporary negative ID that will never collide with real entity IDs.
    // The view will be re-assigned via resolve() when an entity needs it.
    this.views.set(-(this.views.size + 1) as EntityId, created);
  }

  /** Reports every view that was not touched this frame. */
  endSync(): EntityId[] {
    const stale: EntityId[] = [];
    for (const id of this.views.keys()) {
      if (!this.touched.has(id)) stale.push(id);
    }
    return stale;
  }

  /** Removes the given ids from the pool, invoking `dispose` on each view. */
  release(ids: readonly EntityId[], dispose: (view: T) => void): void {
    for (const id of ids) {
      const view = this.views.get(id);
      if (view === undefined) continue;
      this.views.delete(id);
      dispose(view);
      view.destroy();
    }
  }

  get size(): number {
    return this.views.size;
  }

  clear(dispose: (view: T) => void): void {
    for (const view of this.views.values()) dispose(view);
    this.views.clear();
    this.touched.clear();
  }
}
