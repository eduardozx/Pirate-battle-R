import { ASSET, type AssetKey } from '../assets/assetManifest';
import {
  clampInsideArena,
  compileIslands,
  isInsideAnyIsland,
  ISLAND_DEFINITIONS,
  type CompiledIsland,
} from '../config/arenaLayout';
import { DEFAULT_GAME_CONFIG, type GameConfig } from '../config/gameConfig';
import { EventBus } from './eventBus';
import { MatchClock } from './gameClock';
import { Rng } from './rng';
import { distanceSquared } from './math';
import type {
  EnemyKind,
  EndReason,
  EntityId,
  InputState,
  MatchPhase,
  PauseReason,
  Rect,
} from './types';

import { EntityStore } from '../entities/entityStore';
import {
  isEffect,
  isEnemy,
  isPlayer,
  isProjectile,
  isShip,
  type ChaserEntity,
  type EffectEntity,
  type EffectKind,
  type EnemyEntity,
  type GameEntity,
  type PlayerEntity,
  type ProjectileEntity,
  type ShooterEntity,
} from '../entities/entityModels';

import {
  circlesOverlap,
  resolveCircleAgainstRects,
  sweepSegmentCircle,
  sweepSegmentRect,
} from '../physics/collision';
import { SpatialHash } from '../physics/spatialHash';

import { EffectSystem } from '../systems/effectSystem';
import { EnemySystem, scoreForEnemyKilledByPlayer } from '../systems/enemySystem';
import { PlayerSystem } from '../systems/playerSystem';
import { ProjectileSystem } from '../systems/projectileSystem';
import { SpawnerSystem } from '../systems/spawnerSystem';
import { PowerUpFactory } from '../powerups/powerUpFactory';
import { PowerUpSystem } from '../powerups/powerUpSystem';
import { POWER_UPS } from '../powerups/powerUpCatalog';

/**
 * ============================================================================
 *  GAME WORLD — the rule engine
 * ============================================================================
 *
 * Owns every entity and every system, and is the ONLY place where the order of
 * operations is defined. It has no idea rendering exists.
 *
 * Substep pipeline (order is load-bearing, see ARCHITECTURE.md):
 *   clock → input → player → spawn → enemy AI → projectiles →
 *   broadphase → narrowphase → damage resolution → effects →
 *   burning upkeep → match rules
 *
 * Consequences of this order:
 *   • A chaser that spawns this substep already gets its first AI tick, so no
 *     "dead" frame where it sits inert.
 *   • Damage is resolved after all movement, so a projectile that kills on this
 *     substep removes the target before it can fire back.
 *   • Effects are created last, so they always describe what actually happened.
 */

export interface WorldStats {
  readonly score: number;
  readonly enemiesDefeated: number;
  readonly playerHealth: number;
  readonly playerMaxHealth: number;
  readonly elapsedMs: number;
  readonly remainingMs: number;
  readonly activeEntities: number;
}

const ENTITY_CAPACITY = 1024;

export class GameWorld {
  readonly store = new EntityStore(ENTITY_CAPACITY);
  readonly events = new EventBus();
  readonly islands: readonly CompiledIsland[];

  private readonly config: GameConfig;
  private readonly rng: Rng;
  private readonly clock: MatchClock;
  private readonly hash: SpatialHash;

  private readonly playerSystem: PlayerSystem;
  private readonly enemySystem: EnemySystem;
  private readonly spawner: SpawnerSystem;
  private readonly projectileSystem: ProjectileSystem;
  private readonly effectSystem: EffectSystem;

  readonly powerUpFactory: PowerUpFactory;
  readonly powerUpSystem: PowerUpSystem;
  private nextPowerUpAtMs: number;

  /** Flattened collision rects across all islands; the hot path uses one array. */
  private readonly islandRects: readonly Rect[];

  private player: PlayerEntity | null = null;
  private score = 0;
  private enemiesDefeated = 0;
  private nowMs = 0;
  private phase: MatchPhase = 'booting';
  private pauseReason: PauseReason = null;
  private endReason: EndReason | null = null;

  /** Set when a substep changed anything the HUD should re-read. */
  private statsDirty = true;

  private readonly pushOut = { x: 0, y: 0 };

  /**
   * Ship id → the hull-fire effect currently burning on it.
   *
   * The fire is a STATE, not a burst: it must follow the hull as it sails and be
   * re-lit whenever it expires, otherwise a ship that started burning 901 ms ago
   * looks perfectly healthy again. The map is what lets step() answer "does this
   * burning hull still have a fire?" without scanning the whole effect pool.
   */
  private readonly hullFires = new Map<EntityId, EntityId>();

  constructor(config: GameConfig = DEFAULT_GAME_CONFIG, seed = 0x1a2b3c4d) {
    this.config = config;
    this.rng = new Rng(seed).fork(0x51ed);
    this.clock = new MatchClock(config.match.durationSeconds * 1000);
    this.islands = compileIslands(ISLAND_DEFINITIONS);

    this.islandRects = this.islands.flatMap((island) => island.solids);
    this.hash = new SpatialHash(config.arena.width, config.arena.height, 160, 256);

    this.playerSystem = new PlayerSystem(this.store, this.islands, config);
    this.enemySystem = new EnemySystem(this.store, config, this.rng.fork(0x2f19));
    this.spawner = new SpawnerSystem(this.islands, config, this.rng.fork(0x77c3));
    this.projectileSystem = new ProjectileSystem(this.store, config);
    this.effectSystem = new EffectSystem(this.store, config);

    // Power-ups share the world's seeded stream, so a match stays reproducible
    // while power-ups are present.
    this.powerUpFactory = new PowerUpFactory(this.rng.fork(0x3d9a), config.powerUps.crateLifetimeMs);
    this.powerUpSystem = new PowerUpSystem(
      this.powerUpFactory,
      config.powerUps.spawnIntervalMs,
      config.powerUps.minPlayerDistance,
      config.powerUps.poolSize,
    );
    this.nextPowerUpAtMs = config.powerUps.initialDelayMs;
  }

  /* ---------------------------------------------------------------- lifecycle */

  /** Builds a brand-new match: fresh entities, score, timer and spawn schedule. */
  start(): void {
    this.store.clear();
    this.clock.reset();
    this.rng.next(); // advance the stream so a restart is not a perfect replay
    this.spawner.reset();
    this.hullFires.clear();

    this.score = 0;
    this.enemiesDefeated = 0;
    this.nowMs = 0;
    this.nextPowerUpAtMs = this.config.powerUps.initialDelayMs;
    this.powerUpSystem.reset();
    this.endReason = null;
    this.phase = 'running';

    this.player = this.playerSystem.spawn(this.store.reserveId());
    this.statsDirty = true;
  }

  pause(reason: PauseReason): void {
    if (this.phase !== 'running') return;
    this.phase = 'paused';
    this.pauseReason = reason;
    this.events.emit('pause:changed', { paused: true, reason });
  }

  resume(): void {
    if (this.phase !== 'paused') return;
    this.phase = 'running';
    this.pauseReason = null;
    this.events.emit('pause:changed', { paused: false, reason: null });
  }

  private end(reason: EndReason): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.endReason = reason;
    this.pauseReason = null;
    this.statsDirty = true;

    // Ending the match must stop everything at once: movement, attacks, damage,
    // spawns and scoring. The gate in step() enforces it from here on.
    this.store.forEach((entity) => {
      if (isProjectile(entity) || entity.kind === 'effect') {
        entity.alive = false;
        this.store.remove(entity);
      }
    });
    // Every effect is gone, so no ship has a live fire any more.
    this.hullFires.clear();

    this.events.emit('match:ended', {
      reason,
      score: this.score,
      durationMs: this.clock.elapsedMsTotal,
    });
  }

  /**
   * Advances the simulation by one fixed substep.
   *
   * The phase gate is the single structural guarantee that a paused or finished
   * match cannot move, shoot, take damage, spawn or score.
   */
  step(dt: number, input: InputState): void {
    if (this.phase !== 'running') return;

    this.clock.advance(dt);
    this.nowMs += dt * 1000;

    /* 1. Player ------------------------------------------------------------ */
    const player = this.player;
    if (player !== null && player.alive) {
      this.playerSystem.update(player, input, dt);
      this.handlePlayerWeapons(player, input);
    }

    /* 2. Spawning ---------------------------------------------------------- */
    this.updateSpawner();

    /* 3. Enemy AI ---------------------------------------------------------- */
    this.updateEnemyAi(dt);

    /* 3b. Power-ups ------------------------------------------------------- */
    this.updatePowerUps(dt);

    /* 4. Projectiles ------------------------------------------------------- */
    const escaped = this.projectileSystem.update(dt);
    for (const point of escaped) {
      // A shot leaving the arena hits WATER, so it gets the water effect. Using
      // the wood-impact sprite here produced splinters on the open sea.
      this.spawnEffect('splash', ASSET.EFFECT.WATER_SPLASH, point.x, point.y);
    }

    /* 5. Broadphase -------------------------------------------------------- */
    this.hash.clear();
    this.store.forEach((entity) => {
      if (isPlayer(entity) || isEnemy(entity)) this.hash.insert(entity);
    });

    /* 6. Narrowphase + damage --------------------------------------------- */
    this.resolveProjectileHits();
    this.resolveShipVsIsland();
    this.resolveShipSeparation();
    this.resolveChaserContact();

    /* 6b. Confinement ---------------------------------------------------------
     *
     * ONE choke point rather than a clamp at each place a hull can be moved.
     *
     * Three separate sources displace a hull — the player's own input, the enemy
     * AI, and hull-versus-hull separation — and clamping at two of the three let
     * this rule fail twice: first because enemies were clamped only on the island
     * path, then because separation still pushed hulls out with nothing after it.
     * Any future displacement added here would silently re-open the hole.
     *
     * Running confinement once, after everything that moves a hull, means the
     * guarantee is structural instead of something each call site has to remember.
     */
    this.confineAllHulls();

    /* 7. Effects ----------------------------------------------------------- */
    this.effectSystem.update(dt);
    /* 7b. Continuous deterioration — follows hulls, re-lights expired fires. */
    this.maintainBurningShips();

    /* 8. Match rules ------------------------------------------------------- */
    if (player !== null && player.health <= 0) {
      this.end('player_destroyed');
      return;
    }
    if (this.clock.isExpired) {
      this.end('time_expired');
    }
  }

  /* ------------------------------------------------------------------ systems */

  private handlePlayerWeapons(player: PlayerEntity, input: InputState): void {
    const weapons = [
      { id: 'player_front' as const, pressed: input.fireFront, weapon: this.config.player.weapons.front },
      { id: 'player_left' as const, pressed: input.fireLeft, weapon: this.config.player.weapons.left },
      { id: 'player_right' as const, pressed: input.fireRight, weapon: this.config.player.weapons.right },
    ];

    for (const entry of weapons) {
      if (!entry.pressed) continue;
      if (!this.playerSystem.canFire(player, entry.id, this.nowMs)) continue;

      this.playerSystem.markFired(player, entry.id, this.nowMs, this.powerUpSystem.cooldownScale(this.nowMs));
      const muzzles = this.playerSystem.muzzlePositions(player, entry.weapon);

      for (const muzzle of muzzles) {
        const shot = this.projectileSystem.fire(
          this.store.reserveId(),
          entry.weapon,
          'player',
          muzzle.x,
          muzzle.y,
          muzzle.angle,
        );
        // Overcharge scales the shot when it leaves the barrel, so the
        // projectile's damage stays immutable for the collision pass.
        shot.damage = Math.round(entry.weapon.damage * this.powerUpSystem.damageMultiplier(this.nowMs));
        // Visible feedback at the barrel. Without this the gun fires silently and
        // the brief's "efeitos de disparo" requirement is unmet.
        this.spawnEffect(
          'muzzleFlash',
          entry.weapon.muzzleFlashAssetKey,
          muzzle.x,
          muzzle.y,
          muzzle.angle,
        );
      }

      this.events.emit('weapon:fired', {
        weaponId: entry.id,
        x: muzzles[0]?.x ?? player.x,
        y: muzzles[0]?.y ?? player.y,
        angle: muzzles[0]?.angle ?? player.angle,
      });
    }
  }

  private updateSpawner(): void {
    if (!this.spawner.shouldSpawn(this.nowMs)) return;

    const player = this.player;
    if (player === null) return;

    // Cap concurrent enemies; if the arena is full, retry shortly instead of
    // banking up a burst of spawns.
    const enemyCount = this.store.countOf('chaser') + this.store.countOf('shooter');
    if (enemyCount >= this.config.spawn.maxAlive) {
      this.spawner.scheduleNext(this.nowMs);
      return;
    }

    const kind = this.spawner.pickKind();
    const point = this.spawner.findSpawnPoint(player, kind);
    const id = this.store.reserveId();

    if (kind === 'chaser') {
      const chaser = this.enemySystem.spawnChaser(id, point.x, point.y, this.nowMs);
      chaser.angle = Math.atan2(player.y - point.y, player.x - point.x);
    } else {
      const shooter = this.enemySystem.spawnShooter(id, point.x, point.y, this.nowMs);
      shooter.angle = Math.atan2(player.y - point.y, player.x - point.x);
    }

    this.spawner.scheduleNext(this.nowMs);
    this.statsDirty = true;
  }

  private updateEnemyAi(dt: number): void {
    const player = this.player;
    if (player === null || !player.alive) return;

    this.store.forEach((entity) => {
      if (!isEnemy(entity)) return;
      const enemy = entity as EnemyEntity;
      if (!enemy.alive) return;

      // Islands stop enemies just like they stop the player. The arena border is
      // handled once for every hull at the end of the step, not here.
      this.resolveShipVsIslandFor(enemy);

      if (enemy.kind === 'chaser') {
        this.enemySystem.updateChaser(enemy, player.x, player.y, dt);
        return;
      }

      const shooter = enemy as ShooterEntity;
      const shouldFire = this.enemySystem.updateShooter(
        shooter,
        player.x,
        player.y,
        dt,
        this.nowMs,
      );

      if (shouldFire) {
        this.fireEnemyShot(shooter);
      }
    });
  }

  private fireEnemyShot(shooter: ShooterEntity): void {
    const weapon = this.config.shooter.weapon;
    this.enemySystem.markShooterFired(shooter, this.nowMs);

    const cos = Math.cos(shooter.angle);
    const sin = Math.sin(shooter.angle);
    const muzzle = weapon.muzzles[0] ?? { x: 40, y: 0 };

    const x = shooter.x + muzzle.x * cos - muzzle.y * sin;
    const y = shooter.y + muzzle.x * sin + muzzle.y * cos;

    this.projectileSystem.fire(this.store.reserveId(), weapon, 'enemy', x, y, shooter.angle);
    this.spawnEffect('muzzleFlash', weapon.muzzleFlashAssetKey, x, y, shooter.angle);
    this.events.emit('weapon:fired', {
      weaponId: 'enemy_shooter',
      x,
      y,
      angle: shooter.angle,
    });
  }

  /**
   * Spawns and advances power-ups.
   *
   * Spawning reuses the island test, so a crate never materialises inside land,
   * and enforces a minimum distance from the player so a pickup is something the
   * player played for rather than something handed to them.
   *
   * `onCollect` is a bound method, not a closure: the update path allocates
   * nothing per frame.
   */
  private updatePowerUps(dt: number): void {
    void dt;
    const player = this.player;
    if (player === null || !player.alive) return;

    if (this.nowMs >= this.nextPowerUpAtMs) {
      const { arena } = this.config;
      const candidate = this.powerUpFactory.createAtSafeLocation(
        arena,
        player.x,
        player.y,
        (x, y) => isInsideAnyIsland(this.islands, x, y, this.config.powerUps.islandPadding),
        this.nowMs,
        this.config.powerUps.minPlayerDistance,
      );
      // The factory chooses the kind and a legal position; the pool places it.
      this.powerUpSystem.spawn(candidate, this.nowMs);
      this.nextPowerUpAtMs = this.nowMs + this.config.powerUps.spawnIntervalMs;
    }

    this.powerUpSystem.update(
      this.nowMs,
      player.x,
      player.y,
      this.applyCollectedPowerUp,
      this.config.powerUps.pickupRadius,
    );
  }

  /**
   * Applies a collected power-up.
   *
   * Consumables resolve immediately; timed ones register with the effect system,
   * which owns stacking rules and expiry. Both paths are data-driven from the
   * catalogue, so a new power-up needs no change here.
   */
  private readonly applyCollectedPowerUp = (
    _id: (typeof POWER_UPS)[keyof typeof POWER_UPS]['id'],
    definition: (typeof POWER_UPS)[keyof typeof POWER_UPS],
  ): void => {
    const player = this.player;
    if (player === null || !player.alive) return;

    this.powerUpSystem.applyEffect(definition, this.nowMs);

    switch (definition.effect.kind) {
      case 'heal': {
        const healed = Math.min(player.maxHealth, player.health + definition.effect.amount);
        player.health = healed;
        this.events.emit('player:damaged', {
          remainingHealth: player.health,
          maxHealth: player.maxHealth,
        });
        break;
      }
      default:
        break;
    }

    this.spawnEffect('muzzleFlash', definition.assetKey, player.x, player.y, player.angle, 0.6);

    /* The HUD republishes from events, so this is what makes the indicator appear.
       Without it the pickup is applied silently and the player is never told. */
    this.events.emit('powerup:changed', { powerUpId: this.activePowerUpLabel(this.nowMs) });
  };

  /* ---------------------------------------------------------------- collision */

  private resolveProjectileHits(): void {
    this.store.forEach((entity) => {
      if (!isProjectile(entity)) return;
      const projectile = entity as ProjectileEntity;
      if (!projectile.alive) return;

      if (projectile.owner === 'player') {
        this.resolvePlayerProjectile(projectile);
      } else {
        this.resolveEnemyProjectile(projectile);
      }
    });
  }

  private resolvePlayerProjectile(projectile: ProjectileEntity): void {
    let hitAny = false;

    // Sweep along the travelled segment so a fast shot cannot tunnel past a hull.
    this.hash.querySegment(
      projectile.prevX,
      projectile.prevY,
      projectile.x,
      projectile.y,
      projectile.radius,
      (candidate) => {
        if (hitAny) return;
        if (!isEnemy(candidate)) return;

        const enemy = candidate as EnemyEntity;
        if (!enemy.alive) return;
        // Damage once per projectile per target.
        if (projectile.hitIds.has(enemy.id)) return;

        const sweep = sweepSegmentCircle(
          projectile.prevX,
          projectile.prevY,
          projectile.x,
          projectile.y,
          enemy.x,
          enemy.y,
          enemy.radius + projectile.radius,
        );
        if (!sweep.hit) return;

        hitAny = true;
        projectile.hitIds.add(enemy.id);
        this.damageEnemy(enemy, projectile.damage, sweep.x, sweep.y, true);
      },
    );

    if (hitAny) {
      this.projectileSystem.retire(projectile);
      return;
    }

    // Islands block shots just as they block ships.
    if (this.sweepAgainstIslands(projectile)) {
      this.projectileSystem.retire(projectile);
    }
  }

  private resolveEnemyProjectile(projectile: ProjectileEntity): void {
    const player = this.player;
    if (player !== null && player.alive) {
      const sweep = sweepSegmentCircle(
        projectile.prevX,
        projectile.prevY,
        projectile.x,
        projectile.y,
        player.x,
        player.y,
        player.radius + projectile.radius,
      );
      if (sweep.hit) {
        this.damagePlayer(projectile.damage, sweep.x, sweep.y);
        this.projectileSystem.retire(projectile);
        return;
      }
    }

    if (this.sweepAgainstIslands(projectile)) {
      this.projectileSystem.retire(projectile);
    }
  }

  /** @returns true when the projectile struck land (and a wood impact was spawned). */
  private sweepAgainstIslands(projectile: ProjectileEntity): boolean {
    for (const island of this.islands) {
      // Cheap AABB reject using the island's overall bounds.
      if (!sweepSegmentRect(
        projectile.prevX,
        projectile.prevY,
        projectile.x,
        projectile.y,
        island.bounds,
        projectile.radius,
      ).hit) {
        continue;
      }

      for (const rect of island.solids) {
        const hit = sweepSegmentRect(
          projectile.prevX,
          projectile.prevY,
          projectile.x,
          projectile.y,
          rect,
          projectile.radius,
        );
        if (hit.hit) {
          this.spawnEffect('woodImpact', ASSET.EFFECT.WOOD_IMPACT, hit.x, hit.y);
          this.events.emit('projectile:spent', { x: hit.x, y: hit.y, onIsland: true });
          return true;
        }
      }
    }
    return false;
  }

  private resolveShipVsIsland(): void {
    const player = this.player;
    if (player !== null && player.alive) this.resolveShipVsIslandFor(player);

    this.store.forEach((entity) => {
      if (isEnemy(entity) && entity.alive) this.resolveShipVsIslandFor(entity as EnemyEntity);
    });
  }

  private resolveShipVsIslandFor(ship: PlayerEntity | EnemyEntity): void {
    const push = resolveCircleAgainstRects(
      ship.x,
      ship.y,
      ship.radius,
      this.islandRects,
      this.pushOut,
    );
    if (push.x === 0 && push.y === 0) return;

    ship.x += push.x;
    ship.y += push.y;

    // Slide along the obstacle instead of bouncing: re-project velocity onto the
    // contact normal so a ship never sticks to an island.
    const normalLength = Math.hypot(push.x, push.y);
    if (normalLength > 0) {
      const nx = push.x / normalLength;
      const ny = push.y / normalLength;
      const intoSurface = ship.vx * nx + ship.vy * ny;
      if (intoSurface < 0) {
        ship.vx -= intoSurface * nx;
        ship.vy -= intoSurface * ny;
      }
      ship.speed = Math.hypot(ship.vx, ship.vy);
    }

    // Re-apply the arena clamp after displacement, or a push could shove a hull
    // past the border.
    this.clampToArena(ship);
  }

  /**
   * Keeps any hull inside the visible arena, with a small island-safe margin.
   *
   * Thin wrapper over the shared pure function so player and enemy confinement are
   * literally the same rule rather than two implementations that happen to agree.
   */
  private clampToArena(ship: PlayerEntity | EnemyEntity): void {
    const clamped = clampInsideArena(ship.x, ship.y, ship.radius, this.config.arena);
    ship.x = clamped.x;
    ship.y = clamped.y;
  }

  /**
   * Confinement for every hull, run once per step after all displacement.
   *
   * The player is included because hull-versus-hull separation displaces it too,
   * not just the enemies. Velocity is deliberately left alone here: the player's
   * input-driven velocity is zeroed by its own system, which is the only place
   * that knows the input state.
   */
  private confineAllHulls(): void {
    if (this.player !== null && this.player.alive) this.clampToArena(this.player);
    this.store.forEach((entity) => {
      if (isEnemy(entity) && entity.alive) this.clampToArena(entity as EnemyEntity);
    });
  }

  /**
   * Soft separation between hulls. Not required by the rules, but without it
   * enemies stack into an unreadable blob and the arena becomes hard to parse —
   * which the spec explicitly asks us to preserve.
   */
  private resolveShipSeparation(): void {
    const ships: Array<PlayerEntity | EnemyEntity> = [];
    if (this.player !== null && this.player.alive) ships.push(this.player);
    this.store.forEach((entity) => {
      if (isEnemy(entity) && entity.alive) ships.push(entity as EnemyEntity);
    });

    for (let i = 0; i < ships.length; i += 1) {
      const a = ships[i];
      if (a === undefined) continue;

      for (let j = i + 1; j < ships.length; j += 1) {
        const b = ships[j];
        if (b === undefined) continue;

        const combined = a.radius + b.radius;
        const distSq = distanceSquared(a.x, a.y, b.x, b.y);
        if (distSq >= combined * combined || distSq === 0) continue;

        const dist = Math.sqrt(distSq);
        const overlap = combined - dist;
        const nx = (b.x - a.x) / dist;
        const ny = (b.y - a.y) / dist;

        // The player yields less than the enemies do, so contact still reads as
        // the player's responsibility.
        const aShare = isPlayer(a) ? 0.35 : 0.65;
        a.x -= nx * overlap * aShare;
        a.y -= ny * overlap * aShare;
        b.x += nx * overlap * (1 - aShare);
        b.y += ny * overlap * (1 - aShare);
      }
    }
  }

  /** Chaser contact: damage on contact, then it explodes and is removed. */
  private resolveChaserContact(): void {
    const player = this.player;
    if (player === null || !player.alive) return;

    this.store.forEach((entity) => {
      if (entity.kind !== 'chaser') return;
      const chaser = entity as ChaserEntity;
      if (!chaser.alive) return;

      const touching = circlesOverlap(
        chaser.x,
        chaser.y,
        chaser.radius,
        player.x,
        player.y,
        player.radius,
      );

      // Contact starts the fuse; it does not end it. The short delay gives the
      // player a sliver of reaction time and produces a visible explosion beat.
      if (touching && !chaser.detonating) {
        chaser.detonating = true;
        chaser.detonateAtMs = this.nowMs + this.config.chaser.detonationDelayMs;
      }

      if (chaser.detonating && this.nowMs >= chaser.detonateAtMs) {
        this.detonateChaser(chaser, player);
      }
    });
  }

  private detonateChaser(chaser: ChaserEntity, player: PlayerEntity): void {
    this.spawnEffect('explosion', ASSET.EFFECT.EXPLOSION, chaser.x, chaser.y);
    this.events.emit('enemy:selfDestructed', { enemyId: chaser.id, x: chaser.x, y: chaser.y });

    if (circlesOverlap(chaser.x, chaser.y, chaser.radius * 1.5, player.x, player.y, player.radius)) {
      this.damagePlayer(this.config.chaser.contactDamage, chaser.x, chaser.y);
    }

    // Removed immediately: a dead enemy can no longer damage, fire or collide.
    chaser.alive = false;
    this.store.remove(chaser);
    this.statsDirty = true;
  }

  /* ------------------------------------------------------------------- damage */

  private damageEnemy(
    enemy: EnemyEntity,
    damage: number,
    x: number,
    y: number,
    byPlayer: boolean,
  ): void {
    if (!enemy.alive) return;

    enemy.health -= damage;
    enemy.hitFlashUntilMs = this.nowMs + this.config.fx.hitFlashMs;
    this.events.emit('entity:hit', { targetId: enemy.id, damage, x, y });

    if (enemy.health > 0) {
      this.updateDeterioration(enemy);
      return;
    }

    const scoreGained = byPlayer ? scoreForEnemyKilledByPlayer(enemy.kind, this.config) : 0;

    enemy.alive = false;
    this.store.remove(enemy);

    this.spawnEffect('explosion', ASSET.EFFECT.EXPLOSION, enemy.x, enemy.y);
    this.events.emit('enemy:killed', {
      enemyId: enemy.id,
      x: enemy.x,
      y: enemy.y,
      scoreGained,
    });

    if (scoreGained > 0) {
      // Applied at the moment of the kill, so the recorded score is final rather
      // than needing recomputation afterwards.
      this.score += scoreGained * this.powerUpSystem.scoreMultiplier(this.nowMs);
      this.enemiesDefeated += 1;
    }
    this.statsDirty = true;
  }

  /**
   * Hull deterioration.
   *
   * The brief asks for "visual deterioration of the ships according to remaining
   * health". A health bar alone does not convey it — a wreck at 5% looks like a
   * healthy ship apart from a small red bar. Burning is attached once the hull
   * drops below the configured threshold and stays attached while it is hurt, so
   * the state is readable at a glance and from any distance.
   *
   * Damage alone is not enough to trigger it: a ship that has been hit but is
   * still healthy must not look wrecked.
   */
  private updateDeterioration(ship: PlayerEntity | EnemyEntity): void {
    if (!ship.alive) return;
    const ratio = ship.health / ship.maxHealth;
    const burning = ratio <= this.config.fx.deteriorationHealthRatio;

    if (burning === ship.burning) return;
    ship.burning = burning;

    if (burning) {
      /* The map still holds a live fire if the hull only dipped below the
         threshold and came back within one substep — re-lighting would orphan
         the first flame. Absence of an entry is therefore the real condition. */
      if (!this.hullFires.has(ship.id)) {
        const fire = this.spawnEffect(
          'hullFire',
          ASSET.EFFECT.HULL_FIRE,
          ship.x,
          ship.y,
          ship.angle,
          isPlayer(ship) ? 1 : 0.8,
        );
        this.hullFires.set(ship.id, fire.id);
      }
    }
    /* When the hull is repaired the fire is NOT removed here: `maintainBurningShips`
       runs once per substep, after every system that can change `burning`, and
       tears it down there. One owner for the teardown, rather than two. */
  }

  private damagePlayer(damage: number, x: number, y: number): void {
    const player = this.player;
    if (player === null || !player.alive) return;
    // Brief mercy window stops a shooter volley from deleting the player instantly.
    if (this.nowMs < player.invulnerableUntilMs) return;

    // A shield eats damage before the hull does, which is what makes it read as
    // protection rather than as a smaller health bar.
    const absorbed = this.powerUpSystem.consumeShield(damage);
    const hullDamage = damage - absorbed;
    if (hullDamage <= 0) return;

    player.health = Math.max(0, player.health - hullDamage);
    player.invulnerableUntilMs = this.nowMs + this.config.player.invulnerabilityMs;
    player.hitFlashUntilMs = this.nowMs + this.config.fx.hitFlashMs;

    this.events.emit('entity:hit', { targetId: player.id, damage: hullDamage, x, y });
    this.events.emit('player:damaged', {
      remainingHealth: player.health,
      maxHealth: player.maxHealth,
    });
    this.updateDeterioration(player);
    this.statsDirty = true;
  }

  private spawnEffect(
    kind: EffectKind,
    assetKey: AssetKey,
    x: number,
    y: number,
    angle = 0,
    scaleMultiplier = 1,
  ): EffectEntity {
    return this.effectSystem.spawn(
      this.store.reserveId(),
      kind,
      assetKey,
      x,
      y,
      angle,
      scaleMultiplier,
    );
  }

  /**
   * Keeps every burning hull actually on fire.
   *
   * Three jobs, in one place, because they are one invariant:
   *   1. move each fire with its ship — a flame left at the spot where the hull
   *      crossed the threshold reads as a bug, not as damage;
   *   2. drop the fire the moment the hull is repaired or destroyed;
   *   3. re-light a fire that has run its course while the hull is still hurt,
   *      which is what makes deterioration continuous rather than a one-off burst.
   *
   * Runs immediately after the effect system ages effects, so a fire that expires
   * this substep is replaced on the same substep and never leaves a gap.
   */
  private maintainBurningShips(): void {
    this.hullFires.forEach((effectId, shipId) => {
      const ship = this.store.get(shipId);
      const effect = this.store.get(effectId);

      const orphaned =
        effect === null ||
        !isEffect(effect) ||
        ship === null ||
        !isShip(ship) ||
        !ship.burning ||
        !ship.alive;

      if (orphaned) {
        if (effect !== null && isEffect(effect)) {
          effect.alive = false;
          this.store.remove(effect);
        }
        this.hullFires.delete(shipId);
        return;
      }

      effect.x = ship.x;
      effect.y = ship.y;
      effect.angle = ship.angle;
    });

    this.store.forEach((entity) => {
      if (!isShip(entity) || !entity.burning || !entity.alive) return;
      if (this.hullFires.has(entity.id)) return;

      const fire = this.spawnEffect(
        'hullFire',
        ASSET.EFFECT.HULL_FIRE,
        entity.x,
        entity.y,
        entity.angle,
        isPlayer(entity) ? 1 : 0.8,
      );
      this.hullFires.set(entity.id, fire.id);
    });
  }

  /* ------------------------------------------------------------- read models */

  /** Cheap snapshot for the HUD. Only read when `statsDirty` flips to true. */
  readStats(): WorldStats {
    const player = this.player;
    return {
      score: this.score,
      enemiesDefeated: this.enemiesDefeated,
      playerHealth: player?.health ?? 0,
      playerMaxHealth: player?.maxHealth ?? this.config.player.maxHealth,
      elapsedMs: this.clock.elapsedMsTotal,
      remainingMs: this.clock.remainingMs,
      activeEntities: this.store.aliveCount,
    };
  }

  /**
   * Ship position for the renderer's camera.
   *
   * A dedicated read-only accessor rather than exposing the entity: the camera
   * needs a point, and handing out the mutable `PlayerEntity` would let the
   * renderer reach into simulation state — which is exactly the boundary this
   * architecture keeps one-directional.
   */
  get playerPosition(): { readonly x: number; readonly y: number } | null {
    return this.player === null ? null : { x: this.player.x, y: this.player.y };
  }

  /**
   * How many entities are alive right now.
   *
   * The load a frame had to simulate, render and collide. Read by the profiler
   * so its timings can be quoted against the world size that produced them;
   * counting the store's kinds costs a handful of reads and allocates nothing,
   * which is what makes it safe to ask once per frame.
   */
  get entityCount(): number {
    return this.store.aliveCount;
  }

  get statsAreDirty(): boolean {
    return this.statsDirty;
  }

  markStatsClean(): void {
    this.statsDirty = false;
  }

  get matchPhase(): MatchPhase {
    return this.phase;
  }

  get currentPauseReason(): PauseReason {
    return this.pauseReason;
  }

  get matchEndReason(): EndReason | null {
    return this.endReason;
  }

  get simulationTimeMs(): number {
    return this.nowMs;
  }

  get playerEntity(): PlayerEntity | null {
    return this.player;
  }

  get gameConfig(): GameConfig {
    return this.config;
  }

  /** Iterate live entities for the renderer. Read-only by convention. */
  forEachEntity(visit: (entity: GameEntity) => void): void {
    this.store.forEach(visit);
  }

  get enemyCounts(): { chasers: number; shooters: number } {
    return {
      chasers: this.store.countOf('chaser'),
      shooters: this.store.countOf('shooter'),
    };
  }

  get idAllocator(): () => EntityId {
    return () => this.store.reserveId();
  }

  /* ----------------------------------------------------------------- seams */

  /**
   * Spawns an enemy at an exact position, bypassing the spawner.
   *
   * This is a deliberate TEST SEAM, used by the rule-engine tests and by the
   * deterministic E2E harness to set up a known board. It goes through the real
   * EnemySystem, so a hand-placed enemy is indistinguishable from a spawned one —
   * which is precisely why the tests can trust it.
   */
  spawnEnemyForTest(kind: EnemyKind, x: number, y: number): EnemyEntity {
    const id = this.store.reserveId();
    return kind === 'chaser'
      ? this.enemySystem.spawnChaser(id, x, y, this.nowMs)
      : this.enemySystem.spawnShooter(id, x, y, this.nowMs);
  }

  /** Label of the running timed power-up, for the HUD. */
  activePowerUpLabel(nowMs: number): string | null {
    const id = this.powerUpSystem.activeEffectIdAt(nowMs);
    return id === null ? null : POWER_UPS[id].label;
  }

  /** Applies damage as if a projectile had connected. Test seam only. */
  damagePlayerForTest(amount: number): void {
    this.damagePlayer(amount, this.player?.x ?? 0, this.player?.y ?? 0);
  }
}
