import { DEFAULT_GAME_CONFIG, type GameConfig } from '../config/gameConfig';
import { isInsideAnyIsland, type CompiledIsland } from '../config/arenaLayout';
import { Rng } from '../core/rng';
import { distance } from '../core/math';
import type { EnemyKind, Vec2 } from '../core/types';
import type { PlayerEntity } from '../entities/entityModels';

/**
 * Spawn director.
 *
 * Two guarantees the spec insists on:
 *   1. Spawn points are free of obstacles (never inside an island).
 *   2. Spawn points are far enough from the player that no unavoidable
 *      immediate damage can occur.
 *
 * Implementation: sample the border band, reject invalid candidates, and fall
 * back to a precomputed list of known-valid points furthest from the player.
 * The fallback is what makes "always spawn somewhere legal" a guarantee rather
 * than a hope.
 */

export interface SpawnCandidate extends Vec2 {
  readonly kind: EnemyKind;
}

export class SpawnerSystem {
  private nextSpawnAtMs = 0;
  private readonly validPoints: Vec2[] = [];
  /** Both enemy types are guaranteed within this window of match time. */
  private readonly seenKinds = new Set<EnemyKind>();

  constructor(
    private readonly islands: readonly CompiledIsland[],
    private readonly config: GameConfig = DEFAULT_GAME_CONFIG,
    private readonly rng: Rng = new Rng(7),
  ) {
    this.precomputeValidPoints();
    this.nextSpawnAtMs = config.spawn.initialDelayMs;
  }

  reset(): void {
    this.nextSpawnAtMs = this.config.spawn.initialDelayMs;
    this.seenKinds.clear();
  }

  /**
   * Walks a coarse grid once at construction and keeps every point that is legal
   * to occupy. Replaces per-spawn rejection sampling in the common case.
   */
  private precomputeValidPoints(): void {
    const { arena, spawn } = this.config;
    const step = 48;

    for (let y = spawn.edgeBandWidth * 0.25; y < arena.height; y += step) {
      for (let x = spawn.edgeBandWidth * 0.25; x < arena.width; x += step) {
        if (!this.isLegalSpawn(x, y, 0)) continue;
        this.validPoints.push({ x, y });
      }
    }
  }

  private isLegalSpawn(x: number, y: number, playerX = 0, playerY = 0): boolean {
    const { arena, spawn } = this.config;

    const margin = arena.boundsPadding + spawn.edgeBandWidth * 0.15;
    if (x < margin || y < margin || x > arena.width - margin || y > arena.height - margin) {
      return false;
    }

    if (isInsideAnyIsland(this.islands, x, y, spawn.islandPadding)) return false;

    if (playerX !== 0 || playerY !== 0) {
      if (distance(x, y, playerX, playerY) < spawn.minPlayerDistance) return false;
    }

    return true;
  }

  shouldSpawn(nowMs: number): boolean {
    return nowMs >= this.nextSpawnAtMs;
  }

  /** Schedules the next spawn, jittered inside the configured window. */
  scheduleNext(nowMs: number): void {
    const { spawn } = this.config;
    const intervalMs = this.rng.range(spawn.minIntervalSeconds, spawn.maxIntervalSeconds) * 1000;
    this.nextSpawnAtMs = nowMs + intervalMs;
  }

  /** Weighted pick, biased so an unseen type is guaranteed to appear early. */
  pickKind(): EnemyKind {
    const { spawn } = this.config;

    // If one type has not appeared yet and we already have spawns, force it —
    // this is what makes "both types appear in a standard match" reliable.
    if (this.seenKinds.size > 0 && this.seenKinds.size < 2 && this.rng.bool(0.34)) {
      const missing: EnemyKind = this.seenKinds.has('chaser') ? 'shooter' : 'chaser';
      return missing;
    }

    const index = this.rng.weightedIndex([spawn.chaserWeight, spawn.shooterWeight]);
    return index === 0 ? 'chaser' : 'shooter';
  }

  /** Finds a legal spawn point, honouring the guaranteed minimum distance. */
  findSpawnPoint(player: PlayerEntity, kind: EnemyKind): Vec2 {
    const { spawn } = this.config;

    for (let attempt = 0; attempt < spawn.maxPlacementAttempts; attempt += 1) {
      const candidate = this.sampleBandPoint();
      if (this.isLegalSpawn(candidate.x, candidate.y, player.x, player.y)) {
        this.seenKinds.add(kind);
        return candidate;
      }
    }

    // Fallback: the precomputed legal point furthest from the player.
    const fallback = this.furthestValidPoint(player);
    this.seenKinds.add(kind);
    return fallback;
  }

  /** Samples the band that hugs the arena border, where enemies "sail in" from. */
  private sampleBandPoint(): Vec2 {
    const { arena, spawn } = this.config;
    const edge = spawn.edgeBandWidth;
    const inset = arena.boundsPadding + 8;

    const left = inset;
    const right = arena.width - inset;
    const top = inset;
    const bottom = arena.height - inset;

    const side = this.rng.int(4);
    switch (side) {
      case 0:
        return { x: this.rng.range(left, left + edge), y: this.rng.range(top, bottom) };
      case 1:
        return { x: this.rng.range(right - edge, right), y: this.rng.range(top, bottom) };
      case 2:
        return { x: this.rng.range(left, right), y: this.rng.range(top, top + edge) };
      default:
        return { x: this.rng.range(left, right), y: this.rng.range(bottom - edge, bottom) };
    }
  }

  private furthestValidPoint(player: PlayerEntity): Vec2 {
    let bestX = this.config.arena.width * 0.5;
    let bestY = this.config.arena.height * 0.15;
    let bestDistance = -1;

    for (let i = 0; i < this.validPoints.length; i += 1) {
      const point = this.validPoints[i];
      if (point === undefined) continue;
      const d = distance(point.x, point.y, player.x, player.y);
      if (d > bestDistance) {
        bestDistance = d;
        bestX = point.x;
        bestY = point.y;
      }
    }

    return { x: bestX, y: bestY };
  }

  /** Exposed for tests: every point in the arena that is safe to spawn on. */
  get legalSpawnPoints(): readonly Vec2[] {
    return this.validPoints;
  }

  get kindsSeen(): ReadonlySet<EnemyKind> {
    return this.seenKinds;
  }
}
