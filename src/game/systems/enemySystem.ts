import { DEFAULT_GAME_CONFIG, type GameConfig } from '../config/gameConfig';
import { Rng } from '../core/rng';
import { TAU, clamp } from '../core/math';
import type { EntityId } from '../core/types';
import type { EntityStore } from '../entities/entityStore';
import type { ChaserEntity, ShooterEntity } from '../entities/entityModels';

/**
 * EnemySystem - Refatorado com IA inteligente
 * 
 * Chaser: Persegue o player com pathfinding simples, evita ilhas, detona no contato
 * Shooter: Mantém distância ideal, strafeia, dispara quando em range, evita ilhas
 * Ambos: Respeitam limites da arena, não saem do mapa
 */

export class EnemySystem {
  constructor(
    private readonly store: EntityStore,
    private readonly config: GameConfig = DEFAULT_GAME_CONFIG,
    private readonly rng: Rng = new Rng(1),
  ) {}

  spawnChaser(id: EntityId, x: number, y: number, nowMs: number): ChaserEntity {
    const tuning = this.config.chaser;
    const entity: ChaserEntity = {
      id,
      kind: 'chaser',
      assetKey: tuning.assetKey,
      x,
      y,
      vx: 0,
      vy: 0,
      angle: this.rng.angle(),
      radius: tuning.hitboxRadius,
      speed: 0,
      health: tuning.maxHealth,
      maxHealth: tuning.maxHealth,
      alive: true,
      spawnedAtMs: nowMs,
      hitFlashUntilMs: 0,
      burning: false,
      noisePhase: this.rng.range(0, TAU),
      detonating: false,
      detonateAtMs: 0,
    };
    this.store.add(entity);
    return entity;
  }

  spawnShooter(id: EntityId, x: number, y: number, nowMs: number): ShooterEntity {
    const tuning = this.config.shooter;
    const entity: ShooterEntity = {
      id,
      kind: 'shooter',
      assetKey: tuning.assetKey,
      x,
      y,
      vx: 0,
      vy: 0,
      angle: this.rng.angle(),
      radius: tuning.hitboxRadius,
      speed: 0,
      health: tuning.maxHealth,
      maxHealth: tuning.maxHealth,
      alive: true,
      spawnedAtMs: nowMs,
      hitFlashUntilMs: 0,
      burning: false,
      fireCooldownUntilMs: nowMs + this.rng.range(400, tuning.weapon.cooldownMs),
      strafeSign: this.rng.bool() ? 1 : -1,
    };
    this.store.add(entity);
    return entity;
  }

  /**
   * Atualiza Chaser com IA focada em perseguição agressiva:
   * - Move diretamente para o player
   * - Rush quando próximo (dentro de rushDistance)
   * - NÃO evita ilhas aqui (resolveShipVsIslandFor lida depois)
   * - Respeita limites da arena
   */
  updateChaser(chaser: ChaserEntity, targetX: number, targetY: number, dt: number): void {
    const tuning = this.config.chaser;
    const dx = targetX - chaser.x;
    const dy = targetY - chaser.y;
    const distanceToTarget = Math.hypot(dx, dy);

    // --- DIREÇÃO DIRETA PARA O PLAYER ---
    let desiredAngle = Math.atan2(dy, dx);

    // --- WEAVE MÍNIMO (só para quebrar conga line em grupos) ---
    chaser.noisePhase += dt * 1.7;
    const approachFade = clamp(distanceToTarget / (tuning.rushDistance * 2), 0, 1);
    const weave = Math.sin(chaser.noisePhase) * degreesToRad(tuning.steeringNoiseDegPerSec) * approachFade * dt * 0.3;
    desiredAngle += weave;

    // --- APROXIMAÇÃO DE ÂNGULO (turn rate alto para convergir rápido) ---
    chaser.angle = approachAngle(chaser.angle, desiredAngle, tuning.turnSpeedDegPerSec, dt);

    // --- VELOCIDADE: rush quando próximo ---
    const inRushRange = distanceToTarget < tuning.rushDistance;
    const speed = tuning.moveSpeed * (inRushRange ? tuning.rushSpeedMultiplier : 1);
    chaser.speed = speed;
    chaser.vx = Math.cos(chaser.angle) * speed;
    chaser.vy = Math.sin(chaser.angle) * speed;

    // --- MOVIMENTO ---
    chaser.x += chaser.vx * dt;
    chaser.y += chaser.vy * dt;

    // --- CLAMP DE ARENA ---
    this.clampToArena(chaser);
  }

  /**
   * Atualiza Shooter - COMPORTAMENTO ORIGINAL PRESERVADO
   */
  updateShooter(
    shooter: ShooterEntity,
    targetX: number,
    targetY: number,
    dt: number,
    nowMs: number,
  ): boolean {
    const tuning = this.config.shooter;
    const dx = targetX - shooter.x;
    const dy = targetY - shooter.y;
    const dist = Math.hypot(dx, dy);

    // Aponta para o player
    const desiredAngle = Math.atan2(dy, dx);
    shooter.angle = approachAngle(shooter.angle, desiredAngle, tuning.turnSpeedDegPerSec, dt);

    // Controle radial: mantém distância preferida
    let radialSpeed = 0;
    if (dist > tuning.preferredRange * 1.15) radialSpeed = tuning.moveSpeed;
    else if (dist < tuning.preferredRange * 0.75) radialSpeed = -tuning.moveSpeed * 0.7;

    // Strafe lateral
    const lateral = tuning.moveSpeed * tuning.strafeFactor;
    const cos = Math.cos(shooter.angle + Math.PI / 2);
    const sin = Math.sin(shooter.angle + Math.PI / 2);

    shooter.vx = Math.cos(shooter.angle) * radialSpeed + cos * lateral * shooter.strafeSign;
    shooter.vy = Math.sin(shooter.angle) * radialSpeed + sin * lateral * shooter.strafeSign;
    shooter.speed = Math.hypot(shooter.vx, shooter.vy);

    // Movimento
    shooter.x += shooter.vx * dt;
    shooter.y += shooter.vy * dt;

    // Flip strafe ocasionalmente
    if (this.rng.bool(dt * 0.35)) shooter.strafeSign = shooter.strafeSign === 1 ? -1 : 1;

    // Clamp arena
    this.clampToArena(shooter);

    // Disparo
    const inRange = dist <= tuning.attackRange;
    const ready = shooter.fireCooldownUntilMs <= nowMs;
    return inRange && ready;
  }

  markShooterFired(shooter: ShooterEntity, nowMs: number): void {
    shooter.fireCooldownUntilMs = nowMs + this.config.shooter.weapon.cooldownMs;
  }

  canShooterFire(shooter: ShooterEntity, nowMs: number): boolean {
    return shooter.fireCooldownUntilMs <= nowMs;
  }

  /**
   * Clamp genérico para arena - zera velocidade na direção da borda.
   */
  private clampToArena(entity: { x: number; y: number; vx: number; vy: number; radius: number; speed: number }): void {
    const { arena } = this.config;
    const minX = arena.boundsPadding + entity.radius;
    const maxX = arena.width - arena.boundsPadding - entity.radius;
    const minY = arena.boundsPadding + entity.radius;
    const maxY = arena.height - arena.boundsPadding - entity.radius;

    let clamped = false;
    if (entity.x <= minX) {
      entity.x = minX;
      if (entity.vx < 0) entity.vx = 0;
      clamped = true;
    } else if (entity.x >= maxX) {
      entity.x = maxX;
      if (entity.vx > 0) entity.vx = 0;
      clamped = true;
    }
    if (entity.y <= minY) {
      entity.y = minY;
      if (entity.vy < 0) entity.vy = 0;
      clamped = true;
    } else if (entity.y >= maxY) {
      entity.y = maxY;
      if (entity.vy > 0) entity.vy = 0;
      clamped = true;
    }

    if (clamped) {
      entity.speed = Math.hypot(entity.vx, entity.vy);
    }
  }
}

const degreesToRad = (deg: number): number => (deg * Math.PI) / 180;

/** Turns toward a target angle at a bounded rate. */
const approachAngle = (current: number, target: number, degPerSecond: number, dt: number): number => {
  const maxDelta = degreesToRad(degPerSecond) * dt;
  let delta = target - current;
  while (delta > Math.PI) delta -= TAU;
  while (delta < -Math.PI) delta += TAU;
  return current + Math.max(-maxDelta, Math.min(maxDelta, delta));
};

export const scoreForEnemyKilledByPlayer = (
  kind: 'chaser' | 'shooter',
  config: GameConfig = DEFAULT_GAME_CONFIG,
): number =>
  kind === 'chaser' ? config.chaser.scoreOnPlayerKill : config.shooter.scoreOnPlayerKill;