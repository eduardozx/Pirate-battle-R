import { Application, Container, Graphics, type Ticker } from 'pixi.js';

import type { TextureRegistry } from '../assets/textureRegistry';
import { DEFAULT_GAME_CONFIG, type GameConfig } from '../config/gameConfig';
import { clamp } from '../core/math';
import type { GameWorld } from '../core/gameWorld';
import { isEnemy, isPlayer, isProjectile } from '../entities/entityModels';
import { ArenaView } from '../entities/renderers/arenaView';
import { EffectView, ProjectileView } from '../entities/renderers/bulletViews';
import { ShipView } from '../entities/renderers/shipView';
import { PowerUpView } from '../entities/renderers/powerUpView';
import { ViewPool } from '../entities/renderers/viewPool';

/**
 * ============================================================================
 *  GAME RENDERER — the only PixiJS-aware module in the game tree
 * ============================================================================
 *
 * Responsibilities, strictly:
 *   • own the Pixi Application and its lifecycle
 *   • lay out layers and keep the letterboxed viewport correct
 *   • COPY simulation state into display objects once per frame
 *
 * It never mutates the simulation and never reads React. The HUD gets its data
 * from a store fed by the session, not from here.
 */

export interface Viewport {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
  /**
   * World-space centre the camera is locked to.
   *
   * Exposed so a camera change is testable arithmetic rather than something that
   * can only be judged by eye on a screenshot.
   */
  readonly centreX: number;
  readonly centreY: number;
}

/**
 * Clamps a camera centre so the visible rectangle stays inside the arena.
 *
 * When the visible area is larger than the arena on an axis there is nothing to
 * pan, so the axis is centred instead of clamped — clamping would push the view
 * past the arena edge and expose empty space where there is no water to draw.
 */
const clampCamera = (centre: number, half: number, extent: number): number => {
  if (half * 2 >= extent) return extent / 2;
  return Math.min(Math.max(centre, half), extent - half);
};

/** `priority` controls draw order; higher sits on top. */
const LAYER_PRIORITY = {
  background: 0,
  islands: 10,
  ships: 20,
  projectiles: 30,
  effects: 40,
  overlay: 50,
} as const;

export class GameRenderer {
  private app: Application | null = null;
  private readonly config: GameConfig;

  /** Uniformly scaled + centred: this is the letterbox. */
  private readonly root = new Container();
  private readonly layers = new Map<keyof typeof LAYER_PRIORITY, Container>();

  private readonly shipPool = new ViewPool<ShipView>();
  private readonly projectilePool = new ViewPool<ProjectileView>();
  private readonly effectPool = new ViewPool<EffectView>();

  private arena: ArenaView | null = null;
  private registry: TextureRegistry | null = null;

  private frameCount = 0;
  private variantCursor = 0;
  /**
   * Teardown is idempotent (cleanup can legitimately run more than once) and also
   * doubles as the signal an in-flight `initialise` checks once `init` resolves.
   */
  private destroyed = false;
  private viewport: Viewport = {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    width: 0,
    height: 0,
    centreX: 0,
    centreY: 0,
  };

  constructor(config: GameConfig = DEFAULT_GAME_CONFIG) {
    this.config = config;
  }

  get isInitialised(): boolean {
    return this.app !== null;
  }

  /** The Pixi ticker, used by the frame driver to obtain real frame deltas. */
  get ticker(): Ticker {
    const app = this.app;
    if (app === null) throw new Error('GameRenderer is not initialised');
    return app.ticker;
  }

  async initialise(
    host: HTMLElement,
    registry: TextureRegistry,
    world: GameWorld,
    backgroundColor = 0x071324,
  ): Promise<void> {
    if (this.app !== null) throw new Error('GameRenderer already initialised');

    const app = new Application();

    /**
     * `init` is async and can resolve AFTER a teardown request.
     *
     * The `destroyed` flag below is the coordination point: `destroy()` cannot
     * reach this half-built application (there is no renderer yet), so instead it
     * records that teardown happened, and this function checks the flag as soon
     * as `init` resolves and releases the context itself. That is what prevents
     * StrictMode's discarded first mount from leaking a WebGL context and
     * appending a second canvas.
     */
    await app.init({
      // The host div controls the CSS size; the canvas is sized from it below.
      resizeTo: host,
      background: backgroundColor,
      antialias: true,
      // Cap at 2x: beyond that the cost is real and the gain is not.
      resolution: clamp(window.devicePixelRatio || 1, 1, 2),
      autoDensity: true,
      // No WebGPU requirement: WebGL keeps the deployed build universally safe.
      preference: 'webgl',
      powerPreference: 'high-performance',
    });

    if (this.destroyed) {
      // Teardown was requested while we were initialising: release the WebGL
      // context and attach nothing to the DOM.
      releaseApplication(app);
      return;
    }

    this.app = app;
    this.registry = registry;

    host.appendChild(app.canvas);
    app.canvas.setAttribute('aria-hidden', 'true');
    app.canvas.style.display = 'block';
    app.canvas.style.width = '100%';
    app.canvas.style.height = '100%';

    for (const key of Object.keys(LAYER_PRIORITY) as Array<keyof typeof LAYER_PRIORITY>) {
      const layer = new Container();
      layer.label = key;
      this.layers.set(key, layer);
      this.root.addChild(layer);
    }

    app.stage.addChild(this.root);

    this.arena = new ArenaView(
      registry,
      world.islands,
      this.config.arena.width,
      this.config.arena.height,
    );
    this.layer('background').addChild(this.arena.root);
    this.layer('islands').addChild(this.drawArenaBorder());

    /*
     * Power-up views are allocated ONCE, one per pool slot, and then reused for
     * the whole match. This is the render-side half of the pooling contract: the
     * simulation never allocates, and neither does the display list, so a spawn
     * costs nothing but a state change.
     */
    this.powerUpLayer = this.layer('effects');
    for (let i = 0; i < this.config.powerUps.poolSize; i += 1) {
      const view = new PowerUpView(registry, this.config.powerUps.pickupRadius);
      this.powerUpViews.push(view);
      this.powerUpLayer.addChild(view.sprite);
    }

    this.applyViewport();
  }

  private readonly powerUpViews: PowerUpView[] = [];
  private powerUpLayer: Container | null = null;

  /**
   * Frames the arena so it always FILLS the screen, with the camera following the
   * player.
   *
   * WHY COVER, NOT CONTAIN. "Contain" fits the whole arena inside the screen, which
   * means any screen whose aspect ratio differs from the arena's gets black bars.
   * The arena is 1536×960 (1.6); a 16:9 display is 1.78, so the bars appeared on the
   * left and right — roughly 11% of the screen wasted on nothing.
   *
   * WHY A CAMERA AND NOT JUST A BIGGER SCALE. Simply scaling up to "cover" would
   * crop ~11% off the arena's edges and let the ship sail into a region that is no
   * longer on screen. Scaling up AND panning keeps the player in view while the
   * bars disappear.
   *
   * WHY THE CLAMP IS SAFE. With a cover scale, the visible world rectangle is
   * exactly the arena's size on one axis and no larger than it on the other — so
   * panning can never expose a region outside the arena. Clamping to the arena is
   * therefore sufficient to guarantee no empty space, with no dead-zone fudging.
   *
   * This is presentation only. The simulation is untouched, so determinism and
   * the headless tests are unaffected.
   */
  applyViewport(focusX?: number, focusY?: number): Viewport {
    const app = this.app;
    if (app === null) {
      return {
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        width: 0,
        height: 0,
        centreX: 0,
        centreY: 0,
      };
    }

    const { arena } = this.config;
    const screenWidth = app.renderer.width / app.renderer.resolution;
    const screenHeight = app.renderer.height / app.renderer.resolution;

    const scale = Math.max(screenWidth / arena.width, screenHeight / arena.height);

    const halfW = screenWidth / scale / 2;
    const halfH = screenHeight / scale / 2;

    const centreX = clampCamera(focusX ?? arena.width / 2, halfW, arena.width);
    const centreY = clampCamera(focusY ?? arena.height / 2, halfH, arena.height);

    this.root.scale.set(scale);
    this.root.position.set(
      Math.round(screenWidth / 2 - centreX * scale),
      Math.round(screenHeight / 2 - centreY * scale),
    );

    return {
      scale,
      offsetX: screenWidth / 2 - centreX * scale,
      offsetY: screenHeight / 2 - centreY * scale,
      width: screenWidth,
      height: screenHeight,
      centreX,
      centreY,
    };
  }

  /** Screen (client) coordinates → arena world coordinates. */
  toWorld(clientX: number, clientY: number, host: HTMLElement): { x: number; y: number } {
    const viewport = this.viewport;
    const bounds = host.getBoundingClientRect();
    const localX = clientX - bounds.left - viewport.offsetX;
    const localY = clientY - bounds.top - viewport.offsetY;
    return { x: localX / viewport.scale, y: localY / viewport.scale };
  }

  private layer(key: keyof typeof LAYER_PRIORITY): Container {
    const layer = this.layers.get(key);
    if (layer === undefined) throw new Error(`Layer "${key}" was not created`);
    return layer;
  }

  /** Subtle boundary so the play area reads as an arena, not a cropped texture. */
  private drawArenaBorder(): Graphics {
    const { arena } = this.config;
    const graphics = new Graphics();
    graphics.rect(0, 0, arena.width, arena.height).stroke({
      width: 6,
      color: 0x0b1b2b,
      alpha: 0.55,
    });
    return graphics;
  }

  /* ------------------------------------------------------------------- frame */

  /**
   * Copies simulation state into the display list.
   *
   * Called once per rendered frame, AFTER the simulation has stepped. This is
   * the only place per-frame visual work happens, and it never triggers React.
   */
  sync(world: GameWorld): void {
    const registry = this.registry;
    if (registry === null) return;

    this.frameCount += 1;

    // The camera tracks the ship so the arena can fill the screen without cropping
    // the player out of view. Recomputed before anything reads the viewport.
    const ship = world.playerPosition;
    this.viewport = this.applyViewport(ship?.x, ship?.y);

    const running = world.matchPhase === 'running';
    this.arena?.update(world.simulationTimeMs, running);

    this.shipPool.beginSync();
    this.projectilePool.beginSync();
    this.effectPool.beginSync();

    const shipLayer = this.layer('ships');
    const projectileLayer = this.layer('projectiles');
    const effectLayer = this.layer('effects');
    const nowMs = world.simulationTimeMs;

    world.forEachEntity((entity) => {
      if (isPlayer(entity)) {
        const view = this.shipPool.resolve(entity.id, () => {
          const created = new ShipView(registry, entity.assetKey, entity.radius);
          shipLayer.addChild(created.root);
          return created;
        });
        const flashing = entity.hitFlashUntilMs > nowMs;
        view.update(
          entity.x,
          entity.y,
          entity.angle,
          entity.health / entity.maxHealth,
          flashing,
        );
        return;
      }

      if (isEnemy(entity)) {
        const view = this.shipPool.resolve(entity.id, () => {
          const created = new ShipView(registry, entity.assetKey, entity.radius);
          shipLayer.addChild(created.root);
          return created;
        });

        // Assign a hull variant the first time this enemy is seen.
        if (view.textureVariantIndex === -1) {
          this.variantCursor += 1;
          view.setVariant(this.variantCursor);
          const textures = registry.texturesFor(entity.assetKey);
          const texture = textures[view.textureVariantIndex % Math.max(1, textures.length)];
          if (texture !== undefined) view.applyTexture(texture);
        }

        const healthRatio = entity.health / entity.maxHealth;

        const flashing = entity.hitFlashUntilMs > nowMs;
        view.root.alpha = 0.94;
        view.update(
          entity.x,
          entity.y,
          entity.angle,
          healthRatio,
          flashing,
        );
        return;
      }

      if (isProjectile(entity)) {
        const view = this.projectilePool.resolve(entity.id, () => {
          const created = new ProjectileView(registry, entity.assetKey);
          projectileLayer.addChild(created.sprite);
          return created;
        });
        view.update(entity.x, entity.y, entity.angle);
        return;
      }

      const effectView = this.effectPool.resolve(entity.id, () => {
        const created = new EffectView(registry, entity.assetKey, entity.frameDurationMs);
        effectLayer.addChild(created.sprite);
        return created;
      });
      effectView.update(
        entity.x,
        entity.y,
        entity.angle,
        entity.ageMs,
        entity.durationMs,
        entity.scaleFrom,
        entity.scaleTo,
      );

      // Water spray is drawn from a flame frame, so it is retinted cold to read
      // as spray rather than fire. Tinting belongs to the view, not the rules.
      if (entity.effectKind === 'splash') effectView.setTint(0xbfe8ff);
    });

    // Mark-and-sweep: detach exactly the views whose entities are gone.
    this.shipPool.release(this.shipPool.endSync(), (view) => detach(view.root));
    this.projectilePool.release(this.projectilePool.endSync(), (view) => detach(view.sprite));
    this.effectPool.release(this.effectPool.endSync(), (view) => detach(view.sprite));

    this.syncPowerUps(world, nowMs);
  }

  /**
   * Mirrors the pooled power-up state onto the fixed set of views.
   *
   * Index `i` of the active list maps to view `i`, not to a slot in the pool: the
   * simulation already owns slot identity, and re-binding by slot would require
   * asking it, which would break the "views are stable" contract.
   */
  private syncPowerUps(world: GameWorld, nowMs: number): void {
    const registry = this.registry;
    if (registry === null) return;

    let used = 0;
    world.powerUpSystem.forEachActive(
      (instance, state, timeMs) => {
        const view = this.powerUpViews[used];
        used += 1;
        if (view === undefined) return;
        view.bind(registry, instance);
        view.update(instance, state, timeMs);
      },
      nowMs,
    );

    // Slots beyond the active count are hidden, not destroyed.
    for (let i = used; i < this.powerUpViews.length; i += 1) {
      (this.powerUpViews[i] as PowerUpView).hide();
    }
  }

  /* -------------------------------------------------------------- lifecycle */

  /** Drops every view. Called on restart so no sprite survives into a new match. */
  resetViews(): void {
    this.shipPool.clear((view) => detach(view.root));
    this.projectilePool.clear((view) => detach(view.sprite));
    this.effectPool.clear((view) => detach(view.sprite));
    this.frameCount = 0;
  }

  /**
   * Full teardown.
   *
   * ORDER IS LOAD-BEARING:
   *   1. detach the canvas from the DOM while `app.canvas` is still a live node;
   *   2. THEN destroy the application.
   * Reversing these makes `app.destroy()` null out `app.canvas` first, so the
   * subsequent `removeChild` throws on null and leaves the canvas orphaned.
   *
   * Note also that `texture: false, textureSource: false` is deliberate: textures
   * belong to the TextureRegistry and outlive any single match. Destroying them
   * here would force a full atlas re-upload on every restart.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.resetViews();
    this.arena?.destroy();
    this.arena = null;
    this.registry = null;

    // An initialisation still in flight will see `destroyed` and release itself.
    const app = this.app;
    this.app = null;
    if (app === null) return;

    releaseApplication(app);
  }

  get displayObjectCount(): number {
    return this.app === null ? 0 : this.app.stage.children.length;
  }
}

/** Removes a display object from its parent, if it still has one. */
const detach = (node: Container): void => {
  node.parent?.removeChild(node);
};

/**
 * Detaches a canvas from the DOM.
 *
 * Must happen BEFORE `Application.destroy()`: destroying the app nulls
 * `app.canvas`, so a later `removeChild` throws on null and leaves the canvas
 * orphaned in the document.
 */
const detachCanvas = (app: Application): void => {
  const canvas = app.canvas;
  if (canvas !== null && canvas.parentElement !== null) {
    canvas.parentElement.removeChild(canvas);
  }
};

/**
 * Tears down a Pixi Application, in the only order that is safe.
 *
 * Textures are deliberately left alone: they are owned by the TextureRegistry and
 * outlive any single match, so destroying them here would force a full atlas
 * re-upload on every restart.
 */
const releaseApplication = (app: Application): void => {
  detachCanvas(app);
  app.ticker.stop();
  app.stage.removeChildren();
  app.destroy(false, { children: true, texture: false, textureSource: false });
};
