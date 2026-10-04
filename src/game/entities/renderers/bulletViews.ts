import { Sprite, type Texture } from 'pixi.js';

import type { TextureRegistry } from '../../assets/textureRegistry';
import { metadataFor, type AssetKey } from '../../assets/assetManifest';

/** One cannonball on screen. */
export class ProjectileView {
  readonly sprite: Sprite;

  constructor(registry: TextureRegistry, assetKey: AssetKey) {
    const texture = registry.textureFor(assetKey);
    this.sprite = new Sprite(texture);
    this.sprite.anchor.set(0.5);
    this.sprite.scale.set(metadataFor(assetKey).renderScale);
  }

  update(x: number, y: number, angle: number): void {
    this.sprite.position.set(x, y);
    // Cannonballs are radially symmetric, but a slight rotation reads as spin.
    this.sprite.rotation = angle;
  }

  destroy(): void {
    this.sprite.destroy();
  }
}

/** A muzzle flash anchored to the barrel that just fired. */
export class EffectView {
  readonly sprite: Sprite;
  private readonly frames: readonly Texture[];
  private readonly renderScale: number;

  constructor(
    registry: TextureRegistry,
    assetKey: AssetKey,
    private readonly frameDurationMs: number,
  ) {
    this.frames = registry.texturesFor(assetKey);
    const first = this.frames[0];
    if (first === undefined) {
      throw new Error(`EffectView: no textures registered for "${assetKey}"`);
    }

    this.renderScale = metadataFor(assetKey).renderScale;
    this.sprite = new Sprite(first);
    this.sprite.anchor.set(0.5);
  }

  update(
    x: number,
    y: number,
    angle: number,
    ageMs: number,
    durationMs: number,
    scaleFrom: number,
    scaleTo: number,
  ): void {
    const progress = durationMs <= 0 ? 1 : Math.min(1, ageMs / durationMs);

    const frameIndex = Math.min(
      this.frames.length - 1,
      Math.floor(ageMs / Math.max(1, this.frameDurationMs)),
    );
    const frame = this.frames[frameIndex];
    if (frame !== undefined && this.sprite.texture !== frame) {
      this.sprite.texture = frame;
    }

    this.sprite.position.set(x, y);
    this.sprite.rotation = angle;

    const scale = (scaleFrom + (scaleTo - scaleFrom) * progress) * this.renderScale;
    this.sprite.scale.set(scale);

    // Fade out over the last 60% of the effect.
    this.sprite.alpha = progress < 0.6 ? 1 : 1 - (progress - 0.6) / 0.4;
  }

  /**
   * Retints the sprite, used to make a flame frame read as water spray.
   *
   * The asset set ships no dedicated splash frame, so the flame texture is reused
   * and tinted. The effect still references an abstract asset KEY, so replacing
   * this with real splash art later is a manifest edit and nothing else.
   */
  setTint(tint: number): void {
    this.sprite.tint = tint;
  }

  destroy(): void {
    this.sprite.destroy();
  }
}
