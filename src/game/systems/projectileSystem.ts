import { DEFAULT_GAME_CONFIG, type GameConfig, type WeaponConfig } from '../config/gameConfig';
import { rectContains } from '../core/math';
import type { EntityId, Owner, Vec2 } from '../core/types';
import type { EntityStore } from '../entities/entityStore';
import type { ProjectileEntity } from '../entities/entityModels';

/**
 * Projectile lifecycle: fire → travel → hit / expire / leave arena.
 *
 * `prevX/prevY` are recorded every substep so the physics layer can sweep the
 * whole travelled segment rather than testing a single point.
 */

export class ProjectileSystem {
  constructor(
    private readonly store: EntityStore,
    private readonly config: GameConfig = DEFAULT_GAME_CONFIG,
  ) {}

  fire(
    id: EntityId,
    weapon: WeaponConfig,
    owner: Owner,
    x: number,
    y: number,
    angle: number,
  ): ProjectileEntity {
    const entity: ProjectileEntity = {
      id,
      kind: 'projectile',
      owner,
      weaponId: weapon.id,
      assetKey: weapon.assetKey,
      x,
      y,
      prevX: x,
      prevY: y,
      angle,
      speed: weapon.projectileSpeed,
      damage: weapon.damage,
      radius: weapon.projectileRadius,
      lifetimeMs: weapon.projectileLifetimeMs,
      ageMs: 0,
      alive: true,
      hitIds: new Set<EntityId>(),
    };

    this.store.add(entity);
    return entity;
  }

  /**
   * @returns positions of shots that left the arena this substep, so the caller
   *          can spawn a splash where they hit the water.
   */
  update(dt: number): Array<{ x: number; y: number }> {
    const escaped: Array<{ x: number; y: number }> = [];
    const { arena } = this.config;

    this.store.forEach((entity) => {
      if (entity.kind !== 'projectile') return;

      const projectile = entity as ProjectileEntity;
      if (!projectile.alive) return;

      projectile.prevX = projectile.x;
      projectile.prevY = projectile.y;
      projectile.x += Math.cos(projectile.angle) * projectile.speed * dt;
      projectile.y += Math.sin(projectile.angle) * projectile.speed * dt;
      projectile.ageMs += dt * 1000;

      if (projectile.ageMs >= projectile.lifetimeMs) {
        this.retire(projectile);
        return;
      }

      // Out of arena → removed. A generous margin lets the shot visually reach
      // the border before vanishing, which reads better than popping.
      const margin = 48;
      if (
        !rectContains(
          {
            x: -margin,
            y: -margin,
            width: arena.width + margin * 2,
            height: arena.height + margin * 2,
          },
          projectile.x,
          projectile.y,
        )
      ) {
        escaped.push({ x: projectile.x, y: projectile.y });
        this.retire(projectile);
      }
    });

    return escaped;
  }

  /** Marks a projectile spent: it can never damage anything again. */
  retire(projectile: ProjectileEntity): void {
    projectile.alive = false;
    this.store.remove(projectile);
  }

  /** World position of a projectile's centre, for muzzle-anchored effects. */
  static centreOf(projectile: ProjectileEntity): Vec2 {
    return { x: projectile.x, y: projectile.y };
  }
}
