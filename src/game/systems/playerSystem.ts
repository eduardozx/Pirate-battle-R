import { DEFAULT_GAME_CONFIG, type GameConfig, type WeaponConfig } from '../config/gameConfig';
import {
  PLAYER_SPAWN,
  isInsideAnyIsland,
  type CompiledIsland,
} from '../config/arenaLayout';
import { clamp, damp, degreesToRadians } from '../core/math';
import type { EntityId, InputState, WeaponId } from '../core/types';
import type { EntityStore } from '../entities/entityStore';
import type { PlayerEntity } from '../entities/entityModels';

/**
 * PlayerSystem - Refatorado
 * 
 * Mudanças principais:
 * - Spawn garantido em água aberta (validado contra ilhas)
 * - Movimento com momentum suave mas responsivo
 * - Clamp de arena que ZERA velocidade na direção da borda
 * - Sistema de cooldown baseado em tempo de simulação (não wall-clock)
 * - Posições de canhão precisas (broadside perpendicular ao bow)
 * - Resolução de colisão com ilhas
 */

export class PlayerSystem {
  constructor(
    private readonly store: EntityStore,
    private readonly islands: readonly CompiledIsland[],
    private readonly config: GameConfig = DEFAULT_GAME_CONFIG,
  ) {}

  /** Encontra spawn válido em água aberta (não em cima de ilha). */
  findValidSpawn(): { x: number; y: number; angle: number } {
    const { arena } = this.config;
    const candidate = { ...PLAYER_SPAWN };
    const playerRadius = this.config.player.hitboxRadius;
    
    // Se spawn padrão estiver em ilha, procura em espiral
    if (isInsideAnyIsland(this.islands, candidate.x, candidate.y, playerRadius)) {
      // Busca em anéis concêntricos ao redor do centro da arena
      const centerX = arena.width / 2;
      const centerY = arena.height / 2;
      const maxRadius = Math.min(arena.width, arena.height) / 2 - 100;
      
      for (let ring = 100; ring <= maxRadius; ring += 80) {
        for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
          const x = centerX + Math.cos(angle) * ring;
          const y = centerY + Math.sin(angle) * ring;
          if (!isInsideAnyIsland(this.islands, x, y, this.config.player.hitboxRadius)) {
            return { x, y, angle: angle + Math.PI / 2 }; // Face para fora do centro
          }
        }
      }
      // Fallback: centro da arena
      return { x: centerX, y: centerY, angle: -Math.PI / 2 };
    }
    
    return candidate;
  }

  spawn(id: EntityId): PlayerEntity {
    const { player } = this.config;
    const spawnPos = this.findValidSpawn();
    
    const entity: PlayerEntity = {
      id,
      kind: 'player',
      assetKey: player.assetKey,
      x: spawnPos.x,
      y: spawnPos.y,
      vx: 0,
      vy: 0,
      angle: spawnPos.angle,
      radius: player.hitboxRadius,
      speed: 0,
      health: player.maxHealth,
      maxHealth: player.maxHealth,
      alive: true,
      invulnerableUntilMs: 0,
      cooldownUntilMs: {
        player_front: 0,
        player_left: 0,
        player_right: 0,
        enemy_shooter: 0,
      },
      hitFlashUntilMs: 0,
      burning: false,
    };

    this.store.add(entity);
    return entity;
  }

  update(player: PlayerEntity, input: InputState, dt: number): void {
    const { player: tuning } = this.config;

    // --- ROTAÇÃO ---
    if (input.turn !== 0) {
      const turnRate = degreesToRadians(tuning.turnSpeedDegPerSec);
      player.angle += input.turn * turnRate * dt;
      // Normaliza ângulo
      if (player.angle > Math.PI) player.angle -= Math.PI * 2;
      if (player.angle < -Math.PI) player.angle += Math.PI * 2;
    }

    // --- MOVIMENTO COM MOMENTUM ---
    const targetSpeed = input.forward ? tuning.moveSpeed : 0;
    // Damp exponencial: taxa 6/s aceleração, 4/s desaceleração
    player.speed = damp(player.speed, targetSpeed, input.forward ? 6 : 4, dt);

    if (player.speed > 0.1) {
      const cos = Math.cos(player.angle);
      const sin = Math.sin(player.angle);
      player.vx = cos * player.speed;
      player.vy = sin * player.speed;
      player.x += player.vx * dt;
      player.y += player.vy * dt;
    } else {
      player.vx = 0;
      player.vy = 0;
      player.speed = 0;
    }

    // --- CLAMP DE ARENA (zera velocidade na direção da borda) ---
    this.clampToArena(player);

    // --- COLISÃO COM ILHAS ---
    this.resolveIslandCollisions(player);
  }

  /**
   * Mantém o jogador dentro da arena E zera componente de velocidade
   * que empurra para fora. Isso evita "colar" na borda acelerando.
   */
  private clampToArena(player: PlayerEntity): void {
    const { arena } = this.config;
    const minX = arena.boundsPadding + player.radius;
    const maxX = arena.width - arena.boundsPadding - player.radius;
    const minY = arena.boundsPadding + player.radius;
    const maxY = arena.height - arena.boundsPadding - player.radius;

    let clamped = false;
    if (player.x <= minX) {
      player.x = minX;
      if (player.vx < 0) player.vx = 0;
      clamped = true;
    } else if (player.x >= maxX) {
      player.x = maxX;
      if (player.vx > 0) player.vx = 0;
      clamped = true;
    }
    if (player.y <= minY) {
      player.y = minY;
      if (player.vy < 0) player.vy = 0;
      clamped = true;
    } else if (player.y >= maxY) {
      player.y = maxY;
      if (player.vy > 0) player.vy = 0;
      clamped = true;
    }

    // Recalcula speed após clamp
    if (clamped) {
      player.speed = Math.hypot(player.vx, player.vy);
    }
  }

  /** Colisão com ilhas - empurra para fora suavemente. */
  resolveIslandCollisions(player: PlayerEntity): void {
    for (const island of this.islands) {
      for (const solid of island.solids) {
        // AABB vs círculo
        const closestX = clamp(player.x, solid.x, solid.x + solid.width);
        const closestY = clamp(player.y, solid.y, solid.y + solid.height);
        const dx = player.x - closestX;
        const dy = player.y - closestY;
        const distSq = dx * dx + dy * dy;
        const radius = player.radius + 2; // margem

        if (distSq < radius * radius && distSq > 0.001) {
          const dist = Math.sqrt(distSq);
          const pushX = (dx / dist) * (radius - dist);
          const pushY = (dy / dist) * (radius - dist);
          player.x += pushX;
          player.y += pushY;
        }
      }
    }
  }

  // --- ARMAS ---

  canFire(player: PlayerEntity, weaponId: WeaponId, nowMs: number): boolean {
    return (player.cooldownUntilMs[weaponId] ?? 0) <= nowMs;
  }

  markFired(player: PlayerEntity, weaponId: WeaponId, nowMs: number, cooldownScale = 1): void {
    const weapon = this.weaponFor(weaponId);
    player.cooldownUntilMs[weaponId] = nowMs + weapon.cooldownMs * cooldownScale;
  }

  weaponFor(weaponId: WeaponId): WeaponConfig {
    const { player } = this.config;
    switch (weaponId) {
      case 'player_front':
        return player.weapons.front;
      case 'player_left':
        return player.weapons.left;
      case 'player_right':
        return player.weapons.right;
      case 'enemy_shooter':
        return this.config.shooter.weapon;
    }
  }

  /**
   * Posições de canhão em coordenadas de mundo.
   * Broadside é perpendicular ao bow (ângulo + 90° ou -90°).
   */
  muzzlePositions(player: PlayerEntity, weapon: WeaponConfig): Array<{ x: number; y: number; angle: number }> {
    const cos = Math.cos(player.angle);
    const sin = Math.sin(player.angle);

    const offset = weapon.id === 'player_left' ? -Math.PI / 2
      : weapon.id === 'player_right' ? Math.PI / 2
      : 0;

    const baseAngle = player.angle + offset;

    return weapon.muzzles.map((muzzle) => ({
      x: player.x + muzzle.x * cos - muzzle.y * sin,
      y: player.y + muzzle.x * sin + muzzle.y * cos,
      angle: baseAngle,
    }));
  }

  /** Distance from the arena centre — used by the spawner. */
  static distanceTo(player: PlayerEntity, x: number, y: number): number {
    const dx = x - player.x;
    const dy = y - player.y;
    return clamp(Math.hypot(dx, dy), 0, Number.POSITIVE_INFINITY);
  }

  get arenaIslands(): readonly CompiledIsland[] {
    return this.islands;
  }

  get isInsideLand(): (x: number, y: number) => boolean {
    return (x, y) => isInsideAnyIsland(this.islands, x, y);
  }
}