import type { EntityId } from '../core/types';
import type { GameEntity } from '../entities/entityModels';
import { isProjectile, isShip } from '../entities/entityModels';

/**
 * Uniform spatial hash for broadphase queries.
 *
 * Ship-vs-island uses a coarse AABB reject because islands are static and few.
 * Ship-vs-ship and projectile-vs-ship use this grid. With a typical match
 * holding ~15 ships and ~60 projectiles, brute force would already be fine —
 * but the grid is O(n) to rebuild and keeps the cost flat if `maxAlive` or
 * broadside fire rate are raised during balancing.
 *
 * Implemented with flat typed arrays: no Map/Set churn per frame, no GC.
 */
export class SpatialHash {
  private readonly cellSize: number;
  private readonly columns: number;
  private readonly rows: number;

  /** head[cell] → first entity index, next[index] → chain link. */
  private readonly heads: Int32Array;
  private readonly next: Int32Array;
  private readonly entries: Array<GameEntity | null> = [];
  private count = 0;

  constructor(
    worldWidth: number,
    worldHeight: number,
    cellSize = 160,
    maxEntries = 512,
  ) {
    this.cellSize = cellSize;
    this.columns = Math.max(1, Math.ceil(worldWidth / cellSize));
    this.rows = Math.max(1, Math.ceil(worldHeight / cellSize));
    this.heads = new Int32Array(this.columns * this.rows).fill(-1);
    this.next = new Int32Array(maxEntries).fill(-1);
  }

  clear(): void {
    this.heads.fill(-1);
    this.entries.length = 0;
    this.count = 0;
  }

  /** Inserts a ship. Projectiles are queried, never inserted. */
  insert(entity: GameEntity): void {
    if (this.count >= this.next.length) return; // Graceful: grid degrades to brute force
    const cell = this.cellIndexOf(entity.x, entity.y);
    const index = this.count;
    this.entries[index] = entity;
    this.next[index] = this.heads[cell] as number;
    this.heads[cell] = index;
    this.count += 1;
  }

  /**
   * Visits candidates whose cell overlaps the query circle's cell span.
   * May return false positives from adjacent cells — callers re-test precisely.
   */
  query(x: number, y: number, radius: number, visit: (entity: GameEntity) => void): void {
    const minCol = this.clampColumn(Math.floor((x - radius) / this.cellSize));
    const maxCol = this.clampColumn(Math.floor((x + radius) / this.cellSize));
    const minRow = this.clampRow(Math.floor((y - radius) / this.cellSize));
    const maxRow = this.clampRow(Math.floor((y + radius) / this.cellSize));

    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        let index = this.heads[row * this.columns + col] as number;
        while (index !== -1) {
          const entity = this.entries[index];
          if (entity !== undefined && entity !== null) visit(entity);
          index = this.next[index] as number;
        }
      }
    }
  }

  /**
   * Visits candidates along a swept segment. Walks the cells the segment passes
   * through (a simple DDA) so long, fast projectiles are not missed.
   */
  querySegment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    radius: number,
    visit: (entity: GameEntity) => void,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.max(
      1,
      Math.ceil(
        Math.max(Math.abs(dx), Math.abs(dy)) /
          Math.max(1, this.cellSize * 0.5 - radius),
      ),
    );

    for (let step = 0; step <= steps; step += 1) {
      const t = steps === 0 ? 0 : step / steps;
      this.query(x0 + dx * t, y0 + dy * t, radius, visit);
    }
  }

  private cellIndexOf(x: number, y: number): number {
    return this.clampRow(Math.floor(y / this.cellSize)) * this.columns +
      this.clampColumn(Math.floor(x / this.cellSize));
  }

  private clampColumn(value: number): number {
    return value < 0 ? 0 : value >= this.columns ? this.columns - 1 : value;
  }

  private clampRow(value: number): number {
    return value < 0 ? 0 : value >= this.rows ? this.rows - 1 : value;
  }

  get entryCount(): number {
    return this.count;
  }
}

/** Convenience: only ships go into the grid. */
export const insertShips = (
  hash: SpatialHash,
  forEach: (visit: (entity: GameEntity) => void) => void,
): void => {
  forEach((entity) => {
    if (isShip(entity)) hash.insert(entity);
  });
};

export const isQueryableProjectile = (entity: GameEntity): boolean => isProjectile(entity);

export type { EntityId };
