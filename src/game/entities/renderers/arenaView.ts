import { Container, Sprite, TilingSprite } from 'pixi.js';

import { ASSET, ISLAND_TILE_ROLES, type AssetKey } from '../../assets/assetManifest';
import type { TextureRegistry } from '../../assets/textureRegistry';
import { TILE_SIZE } from '../../config/gameConfig';
import type { CompiledIsland } from '../../config/arenaLayout';

/**
 * Static playfield: water, islands and scattered decor.
 *
 * Built ONCE per match and never touched again — there is no per-frame work here
 * except the water scroll, which is driven by simulation time so it freezes with
 * everything else on pause.
 *
 * Decor placement is a pure hash of the tile coordinate, not a random draw, so
 * the arena is pixel-identical on every run. That is what makes the visual
 * regression baseline meaningful.
 */

const decorHash = (tx: number, ty: number): number => {
  let hash = (tx * 73856093) ^ (ty * 19349663);
  hash = (hash ^ (hash >>> 13)) >>> 0;
  return hash;
};

export class ArenaView {
  readonly root = new Container();

  private readonly water: TilingSprite;

  constructor(
    registry: TextureRegistry,
    islands: readonly CompiledIsland[],
    arenaWidth: number,
    arenaHeight: number,
  ) {
    this.water = new TilingSprite({
      texture: registry.textureFor(ASSET.TILE.WATER),
      width: arenaWidth,
      height: arenaHeight,
    });
    this.root.addChild(this.water);

    const islandLayer = new Container();
    for (const island of islands) {
      islandLayer.addChild(this.buildIsland(registry, island));
    }
    this.root.addChild(islandLayer);
  }

  private buildIsland(registry: TextureRegistry, island: CompiledIsland): Container {
    const layer = new Container();
    layer.label = island.id;

    const decor = registry.textureFor(ISLAND_TILE_ROLES.decor);

    for (const tile of island.tiles) {
      // Corners get their own rounded art; edges get beach; the inside gets grass.
      const key: AssetKey =
        tile.corner !== null
          ? ISLAND_TILE_ROLES[`corner-${tile.corner}`]
          : tile.interior
            ? ISLAND_TILE_ROLES.interior
            : ISLAND_TILE_ROLES.beach;

      const sprite = new Sprite(registry.textureFor(key));
      sprite.position.set(tile.rect.x, tile.rect.y);
      sprite.width = TILE_SIZE;
      sprite.height = TILE_SIZE;
      layer.addChild(sprite);

      // Deterministic decor: roughly one rock every fifth interior tile.
      if (tile.interior && decorHash(tile.tx, tile.ty) % 5 === 0) {
        const rock = new Sprite(decor);
        rock.anchor.set(0.5);
        rock.position.set(
          tile.rect.x + TILE_SIZE / 2,
          tile.rect.y + TILE_SIZE / 2,
        );
        rock.scale.set(0.55);
        rock.alpha = 0.95;
        layer.addChild(rock);
      }
    }

    return layer;
  }

  /**
   * @param simulationTimeMs advances the water from SIMULATION time, not the
   *        render clock, so a paused match shows a frozen sea.
   */
  update(simulationTimeMs: number, running: boolean): void {
    if (!running) return;
    const t = simulationTimeMs / 1000;
    this.water.tilePosition.x = Math.sin(t * 0.35) * 14;
    this.water.tilePosition.y = t * 5;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
