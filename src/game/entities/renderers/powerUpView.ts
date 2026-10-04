import { Sprite } from 'pixi.js';

import type { TextureRegistry } from '../../assets/textureRegistry';
import { PowerUpFactory, type PowerUpInstance } from '../../powerups/powerUpFactory';
import { ACTIVE, EXPIRING } from '../../powerups/powerUpSystem';
import type { PowerUpState } from '../../powerups/powerUpStates';

/**
 * Power-up view.
 *
 * The pool is indexed by SLOT, and slots are stable for the life of the match, so
 * every view keeps its sprite permanently bound to its slot. The texture is only
 * rebound when that slot's power-up kind actually changes — a handful of times
 * across a whole match, rather than on every spawn.
 *
 * There is no `destroy` here by design: nothing is allocated or freed during play.
 */

const POP_IN_MS = 160;

export class PowerUpView {
  readonly sprite: Sprite;

  private boundAssetKey: string | null = null;

  constructor(registry: TextureRegistry, readonly pickupRadius: number) {
    this.sprite = new Sprite(registry.textureFor('effect.hullFire'));
    this.sprite.anchor.set(0.5);
    this.sprite.scale.set(0.9);
    this.sprite.visible = false;
  }

  bind(registry: TextureRegistry, instance: PowerUpInstance): void {
    if (this.boundAssetKey === instance.definition.assetKey) return;
    this.boundAssetKey = instance.definition.assetKey;
    this.sprite.texture = registry.textureFor(instance.definition.assetKey);
  }

  update(instance: PowerUpInstance, state: PowerUpState, nowMs: number): void {
    this.sprite.visible = true;
    this.sprite.position.set(instance.x, PowerUpFactory.driftY(instance, nowMs));
    this.sprite.rotation = PowerUpFactory.spin(instance, nowMs);
    this.sprite.tint = instance.definition.tint;

    if (state === ACTIVE || state === EXPIRING) {
      // An applied power-up keeps a faint halo so the player can see it is on.
      this.sprite.alpha = state === EXPIRING ? 0.3 + 0.3 * Math.sin(nowMs / 90) : 0.22;
      return;
    }

    // Pop in rather than materialising at full size.
    this.sprite.alpha = Math.min(1, (nowMs % 1000) / POP_IN_MS + 0.6);
  }

  hide(): void {
    this.sprite.visible = false;
  }
}
