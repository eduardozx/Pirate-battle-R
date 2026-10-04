import { Assets, Rectangle, Texture, type TextureSource } from 'pixi.js';

import {
  ATLASES,
  SPRITE_SOURCES,
  referencedAtlasIds,
  referencedImageUrls,
  validateManifest,
  type AssetKey,
  type AtlasId,
  type SpriteSource,
} from './assetManifest';
import { parseStarlingAtlasXml, type AtlasFrame } from './atlasXml';

/** Parses the UI atlas JSON format (TexturePacker JSONArray/Hash). */
function parseJsonAtlas(json: string): Map<string, AtlasFrame> {
  const parsed = JSON.parse(json);
  const frames = new Map<string, AtlasFrame>();

  const frameData = parsed.frames;
  if (!frameData) {
    throw new Error('JSON atlas missing "frames" object');
  }

  for (const [name, data] of Object.entries(frameData)) {
    const frame = data as { frame: { x: number; y: number; w: number; h: number } };
    const f = frame.frame;
    frames.set(name, {
      name,
      x: f.x,
      y: f.y,
      width: f.w,
      height: f.h,
    });
  }

  if (frames.size === 0) {
    throw new Error('JSON atlas contained no usable frames');
  }

  return frames;
}

export interface LoadProgress {
  readonly loaded: number;
  readonly total: number;
  readonly ratio: number;
}

export class AssetLoadError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AssetLoadError';
  }
}

/**
 * Resolves abstract asset keys into Pixi textures.
 *
 * Responsibilities are deliberately narrow: load once, resolve many, release
 * once. The registry does NOT know what a "player" is, and the simulation does
 * not know what a PNG is — that is the whole point of the manifest boundary.
 */
export class TextureRegistry {
  private readonly atlasFrames = new Map<AtlasId, Map<string, AtlasFrame>>();
  private readonly atlasSources = new Map<AtlasId, TextureSource>();
  /** Asset key → resolved textures (one entry per art variant). */
  private readonly resolved = new Map<AssetKey, readonly Texture[]>();
  /**
   * Asset URLs that were handed to `Assets.load`, tracked so `dispose` can unload
   * them BY NAME.
   *
   * `Assets.unload` takes an asset id (a URL or bundle name), not a TextureSource.
   * Passing a source for something that was never registered makes PixiJS attempt
   * to resolve an undefined id and throw. Sub-textures carved out of a packed atlas
   * have no URL of their own, so they are simply not tracked: unregistering the
   * sheet they share is all that is needed.
   */
  private readonly loadedAssetUrls = new Set<string>();

  private ready = false;
  private loadPromise: Promise<void> | null = null;

  /**
   * Loads every atlas and image referenced by the manifest.
   *
   * @throws {AssetLoadError} with a per-asset breakdown so the UI can tell the
   *         player exactly what failed and offer a real retry.
   */
  async load(onProgress?: (progress: LoadProgress) => void): Promise<void> {
    if (this.ready) {
      const atlasIds = referencedAtlasIds();
      const imageUrls = referencedImageUrls();
      const total = atlasIds.length * 2 + imageUrls.length;
      onProgress?.({ loaded: total, total, ratio: 1 });
      return;
    }

    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.loadPromise = this.executeLoad(onProgress);
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async executeLoad(onProgress?: (progress: LoadProgress) => void): Promise<void> {
    validateManifest();

    const atlasIds = referencedAtlasIds();
    const imageUrls = referencedImageUrls();

    // Weighted by texture count so the bar advances smoothly.
    const total = atlasIds.length * 2 + imageUrls.length;
    let completed = 0;
    const tick = (): void => {
      completed += 1;
      onProgress?.({ loaded: completed, total, ratio: total === 0 ? 1 : completed / total });
    };

    const failures: string[] = [];

    for (const atlasId of atlasIds) {
      try {
        await this.loadAtlas(atlasId);
      } catch (error) {
        failures.push(`${atlasId}: ${describe(error)}`);
      } finally {
        tick();
      }
    }

    await Promise.all(
      imageUrls.map(async (url) => {
        try {
          await Assets.load<Texture>(url);
          this.loadedAssetUrls.add(url);
        } catch (error) {
          failures.push(`${url}: ${describe(error)}`);
        } finally {
          tick();
        }
      }),
    );

    if (failures.length > 0) {
      throw new AssetLoadError(`Failed to load ${failures.length} asset(s): ${failures.join('; ')}`);
    }

    this.resolveAll();
    this.ready = true;
    onProgress?.({ loaded: total, total, ratio: 1 });
  }

  private async loadAtlas(atlasId: AtlasId): Promise<void> {
    const definition = ATLASES[atlasId];

    // Fetch the descriptor as text so the parser stays format-agnostic.
    const [sheetTexture, descriptorText] = await Promise.all([
      Assets.load<Texture>(definition.sheetUrl),
      fetch(definition.dataUrl).then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} while fetching ${definition.dataUrl}`);
        }
        return response.text();
      }),
    ]);

    if (!sheetTexture?.source) {
      throw new Error(`Loaded atlas texture for "${atlasId}" has no valid source`);
    }

    let frames: Map<string, AtlasFrame>;
    if (definition.dataFormat === 'json') {
      frames = parseJsonAtlas(descriptorText);
    } else {
      frames = parseStarlingAtlasXml(descriptorText);
    }

    this.atlasFrames.set(atlasId, frames);
    this.atlasSources.set(atlasId, sheetTexture.source);
    // Only the sheet is an unloadable asset; the descriptor was fetched, not registered.
    this.loadedAssetUrls.add(definition.sheetUrl);
  }

  /** Turns every `SPRITE_SOURCES` entry into textures, once. */
  private resolveAll(): void {
    for (const [key, source] of Object.entries(SPRITE_SOURCES) as Array<
      [AssetKey, SpriteSource]
    >) {
      this.resolved.set(key, this.createTextures(source));
    }
  }

  private createTextures(source: SpriteSource): readonly Texture[] {
    if (source.kind === 'image') {
      // Already loaded through `Assets.load`, so `Texture.from` reuses that exact
      // Texture instance from the Assets cache rather than creating a second one.
      return [Texture.from(source.url)];
    }

    const frames = this.atlasFrames.get(source.atlas);
    const sheetSource = this.atlasSources.get(source.atlas);
    if (!frames || !sheetSource) {
      throw new Error(`Atlas "${source.atlas}" was not loaded`);
    }

    return source.frames.map((frameName) => {
      const frame = frames.get(frameName);
      if (frame === undefined) {
        throw new Error(`Frame "${frameName}" is missing from atlas "${source.atlas}"`);
      }
      // Sub-textures share the packed sheet's single GPU upload: 102 frames, 1
      // texture bind. They are not separately tracked for unloading.
      return new Texture({
        source: sheetSource,
        frame: new Rectangle(frame.x, frame.y, frame.width, frame.height),
      });
    });
  }


  /** All art variants for a key. Returns an empty array only if load() failed. */
  texturesFor(key: AssetKey): readonly Texture[] {
    return this.resolved.get(key) ?? [];
  }

  /** First variant — the common case (projectiles, water, terrain). */
  textureFor(key: AssetKey): Texture {
    const textures = this.texturesFor(key);
    const first = textures[0];
    if (first === undefined) {
      throw new Error(`Asset "${key}" has not been loaded`);
    }
    return first;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Releases every asset this registry loaded.
   *
   * Uses `Assets.unload(url)` — by ASSET ID, never by TextureSource. `unload`
   * resolves the id through the Assets cache, so handing it an unregistered object
   * makes PixiJS throw. Destroying sources directly is equally wrong: it leaves the
   * cache holding dangling references, which PixiJS warns about and which makes the
   * loading screen's "Retry" return dead textures instead of re-fetching.
   *
   * Unloading in reverse load order means dependents (the packed sheet) go before
   * the images derived from them.
   */
  dispose(): void {
    for (const url of [...this.loadedAssetUrls].reverse()) {
      try {
        Assets.unload(url);
      } catch (error) {
        console.warn(`[TextureRegistry] failed to unload ${url}`, error);
      }
    }
    this.loadedAssetUrls.clear();

    // Sub-textures carved from a packed sheet are not registered assets; dropping
    // the references lets their Texture wrappers be collected. The shared GPU
    // upload went away with the sheet above.
    this.resolved.clear();
    this.atlasSources.clear();
    this.atlasFrames.clear();
    this.ready = false;
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
