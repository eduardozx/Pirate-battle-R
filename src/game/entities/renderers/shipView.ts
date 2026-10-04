import { Container, Sprite, Texture } from 'pixi.js';

import type { TextureRegistry } from '../../assets/textureRegistry';
import { metadataFor } from '../../assets/assetManifest';
import type { AssetKey } from '../../assets/assetManifest';
import { clamp } from '../../core/math';

/**
 * Ship view: hull sprite plus a floating health bar.
 *
 * Note what is NOT here: no movement maths, no health rules, no cooldowns. The
 * view reads entity state and draws it. That is the whole contract.
 */

const BAR_WIDTH = 44;
const BAR_HEIGHT = 6;
/** Minimum clearance between the hull centre and the bar, in world units. */
const BAR_LIFT = 40;
/** Extra clearance so the bar never touches the hull's bounding box. */
const BAR_CLEARANCE = 10;

/** Health bar colour thresholds, mirroring `config.player.lowHealthRatio`. */
const HEALTH_GREEN = 0x5ad46a;
const HEALTH_AMBER = 0xf2c14e;
const HEALTH_RED = 0xe04b4b;

export class ShipView {
  readonly root = new Container();

  readonly hull: Sprite;
  private readonly barBackdrop: Sprite;
  private readonly barFill: Sprite;

  private textureIndex = 0;
  private readonly variantCount: number;
  private readonly pivotOffset: number;
  private readonly flashTint = 0xffffff;

  /** -1 until the renderer assigns a hull variant; used to pick one per spawn. */
  textureVariantIndex = -1;

  /** Render scale of the hull sprite, cached so the lift can use it. */
  readonly renderScale: number;

  constructor(registry: TextureRegistry, assetKey: AssetKey, private readonly radius: number) {
    const metadata = metadataFor(assetKey);
    const textures = registry.texturesFor(assetKey);
    const first = textures[0];
    if (first === undefined) {
      throw new Error(`ShipView: no textures registered for "${assetKey}"`);
    }

    this.variantCount = textures.length;
    this.hull = new Sprite(first);
    this.hull.anchor.set(0.5);
    this.hull.scale.set(metadata.renderScale);

    // Art points up; the simulation's bow points +X. Keeping the correction
    // here (driven by manifest metadata) means a side-facing replacement sprite
    // only needs `artAxis: 'right'` — no code change.
    this.pivotOffset = metadata.artAxis === 'up' ? Math.PI / 2 : 0;
    this.renderScale = metadata.renderScale;

    this.barBackdrop = new Sprite(Texture.WHITE);
    this.barBackdrop.anchor.set(0.5, 0);
    this.barBackdrop.width = BAR_WIDTH + 2;
    this.barBackdrop.height = BAR_HEIGHT + 2;
    this.barBackdrop.tint = 0x10161f;
    this.barBackdrop.alpha = 0.72;

    this.barFill = new Sprite(Texture.WHITE);
    this.barFill.anchor.set(0.5, 0);
    this.barFill.height = BAR_HEIGHT;
    this.barFill.width = BAR_WIDTH;
    this.barFill.position.set(0, 1);

    // The bar lives in its own container so it can be counter-rotated each
    // frame. Without that, a ship pointing north would carry a health bar
    // rotated 90°, which is unreadable.
    this.bar = new Container();
    this.bar.addChild(this.barBackdrop, this.barFill);
    this.bar.y = -BAR_LIFT;

    this.root.addChild(this.hull, this.bar);
  }

  private readonly bar: Container;

  /** Chooses one of the asset key's variants deterministically. */
  setVariant(index: number): void {
    if (this.variantCount <= 1) return;
    this.textureIndex = index % this.variantCount;
    this.textureVariantIndex = this.textureIndex;
  }

  applyTexture(texture: Texture): void {
    if (this.hull.texture !== texture) {
      this.hull.texture = texture;
    }
  }

  update(x: number, y: number, angle: number, healthRatio: number, hitFlash: boolean): void {
    this.root.position.set(x, y);
    this.root.rotation = angle + this.pivotOffset;

    // Damage feedback: a short white flash that reads instantly at 60 fps.
    this.hull.tint = hitFlash ? this.flashTint : 0xffffff;

    const ratio = clamp(healthRatio, 0, 1);
    this.barFill.width = Math.max(0, BAR_WIDTH * ratio);
    this.barFill.tint = ratio > 0.6 ? HEALTH_GREEN : ratio > 0.3 ? HEALTH_AMBER : HEALTH_RED;

    /* Keep the bar upright AND directly above the hull, at every heading.
     *
     * Counter-rotating only the ROTATION is not enough. The bar is a child of the
     * rotated root, so its local offset is rotated too: setting `bar.y` alone
     * placed the bar along the BOW, which means a ship pointing left carried its
     * bar off to its left. The offset therefore has to be counter-rotated as well,
     * so the bar's world offset is always straight up on screen.
     *
     * Solving R(theta) * p = (0, -lift) for the local offset gives
     * p = (-lift * sin(theta), -lift * cos(theta)).
     */
    const theta = this.root.rotation;
    const lift = this.barLiftDistance;

    this.bar.rotation = -theta;
    this.bar.position.set(-lift * Math.sin(theta), -lift * Math.cos(theta));
  }

  /**
   * Distance from the hull centre to the health bar.
   *
   * Derived from the sprite's frame AND its render scale. The scale varies per
   * asset (the shooter's hull is drawn at 0.78, the player's at 1), so measuring
   * the unscaled frame gave every ship the same lift for very different hull
   * heights — one bar would sit on its ship while another floated clear of it.
   */
  private get barLiftDistance(): number {
    const halfHeight = (this.hull.texture.frame.height * 0.5) * this.renderScale;
    return Math.max(BAR_LIFT, halfHeight + BAR_CLEARANCE);
  }

  get bodyRadius(): number {
    return this.radius;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
