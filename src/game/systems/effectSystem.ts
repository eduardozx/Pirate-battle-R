import { DEFAULT_GAME_CONFIG, type GameConfig } from '../config/gameConfig';
import type { AssetKey } from '../assets/assetManifest';
import type { EntityId } from '../core/types';
import type { EntityStore } from '../entities/entityStore';
import type { EffectEntity, EffectKind } from '../entities/entityModels';

/**
 * Transient visual feedback: muzzle flashes, explosions, wood impacts, splashes.
 *
 * Effects live in the simulation, not in the renderer, so their timing follows
 * simulation time and freezes together with everything else during a pause.
 */

const EFFECT_TUNING: Record<
  EffectKind,
  { durationMs: number; frameDurationMs: number; scaleFrom: number; scaleTo: number }
> = {
  muzzleFlash: { durationMs: 160, frameDurationMs: 80, scaleFrom: 0.7, scaleTo: 1.05 },
  explosion: { durationMs: 520, frameDurationMs: 130, scaleFrom: 0.45, scaleTo: 1.5 },
  woodImpact: { durationMs: 300, frameDurationMs: 150, scaleFrom: 1.0, scaleTo: 0.55 },
  splash: { durationMs: 420, frameDurationMs: 140, scaleFrom: 0.35, scaleTo: 1.25 },
  /**
   * Long-lived and near-static: burning is a STATE, not a one-shot burst. It is
   * re-spawned each time it expires for as long as the hull stays hurt.
   */
  hullFire: { durationMs: 900, frameDurationMs: 300, scaleFrom: 0.9, scaleTo: 1.05 },
};

export class EffectSystem {
  constructor(
    private readonly store: EntityStore,
    private readonly config: GameConfig = DEFAULT_GAME_CONFIG,
  ) {}

  spawn(
    id: EntityId,
    effectKind: EffectKind,
    assetKey: AssetKey,
    x: number,
    y: number,
    angle = 0,
    scaleMultiplier = 1,
  ): EffectEntity {
    const tuning = EFFECT_TUNING[effectKind];

    const entity: EffectEntity = {
      id,
      kind: 'effect',
      effectKind,
      assetKey,
      x,
      y,
      angle,
      scaleFrom: tuning.scaleFrom * scaleMultiplier,
      scaleTo: tuning.scaleTo * scaleMultiplier,
      durationMs: tuning.durationMs,
      frameDurationMs: tuning.frameDurationMs,
      ageMs: 0,
      alive: true,
    };

    this.store.add(entity);
    return entity;
  }

  update(dt: number): void {
    this.store.forEach((entity) => {
      if (entity.kind !== 'effect') return;
      const effect = entity as EffectEntity;
      effect.ageMs += dt * 1000;
      if (effect.ageMs >= effect.durationMs) {
        effect.alive = false;
        this.store.remove(effect);
      }
    });
  }

  get fxConfig(): GameConfig['fx'] {
    return this.config.fx;
  }
}
