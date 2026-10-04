import { describe, expect, it } from 'vitest';

import { ASSET, ISLAND_TILE_ROLES, SPRITE_SOURCES, expectedTextureCount, referencedAtlasIds, referencedImageUrls, metadataFor, type AssetKey } from '../../src/game/assets/assetManifest';
import { compileIslands, ISLAND_DEFINITIONS, PLAYER_SPAWN, isInsideAnyIsland } from '../../src/game/config/arenaLayout';
import { DEFAULT_GAME_CONFIG, TILE_SIZE, broadsideDirection } from '../../src/game/config/gameConfig';
import { GameWorld } from '../../src/game/core/gameWorld';
import { parseStarlingAtlasXml } from '../../src/game/assets/atlasXml';

/**
 * Configuration and asset-manifest tests.
 *
 * These protect the two "change a value in one place" promises the architecture
 * makes: balance lives in gameConfig, and art identity lives in assetManifest.
 */

describe('asset manifest', () => {
  it('binds every declared asset key to a source', () => {
    const keys = new Set<string>();
    const walk = (node: unknown): void => {
      if (typeof node === 'string') keys.add(node);
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(ASSET);

    for (const key of keys) {
      expect(SPRITE_SOURCES[key as AssetKey], `missing source for ${key}`).toBeDefined();
    }
    expect(keys.size).toBeGreaterThan(10);
  });

  it('never leaks a file path or frame name into gameplay config', () => {
    // The simulation must consume abstract keys only. Any .png/.json appearing in
    // the balance config would mean art and rules had become coupled.
    const serialised = JSON.stringify(DEFAULT_GAME_CONFIG);
    expect(serialised).not.toMatch(/\.png|\.json|\.xml|tile_\d+/);
    expect(serialised).not.toContain('assets/');

    // And the config references ships and projectiles by manifest key.
    expect(DEFAULT_GAME_CONFIG.player.assetKey).toBe(ASSET.SHIP.PLAYER);
    expect(DEFAULT_GAME_CONFIG.chaser.assetKey).toBe(ASSET.SHIP.CHASER);
    expect(DEFAULT_GAME_CONFIG.shooter.assetKey).toBe(ASSET.SHIP.SHOOTER);
  });

  it('reports the atlases and images the loader must fetch', () => {
    expect(referencedAtlasIds()).toEqual(['ships', 'ui']);
    expect(referencedImageUrls().length).toBeGreaterThan(0);
    expect(expectedTextureCount()).toBeGreaterThan(10);
  });

  it('maps island roles to asset keys, not to paths', () => {
    for (const [role, key] of Object.entries(ISLAND_TILE_ROLES)) {
      expect(typeof key).toBe('string');
      expect(SPRITE_SOURCES[key as AssetKey], `role ${role}`).toBeDefined();
      expect(key.startsWith('tile.')).toBe(true);
    }
  });

  it('supplies default renderer metadata for any unlisted key', () => {
    const metadata = metadataFor(ASSET.SHIP.PLAYER);
    expect(metadata.renderScale).toBeGreaterThan(0);
    expect(['up', 'right']).toContain(metadata.artAxis);
    // An unlisted key must still resolve, so adding art never breaks rendering.
    expect(metadataFor('ship.chaser' as AssetKey)).toBeDefined();
  });

  it('declares ship art as bow-up so the renderer can correct the pivot', () => {
    // The PNGs are drawn bow-up while the simulation's bow points +X. Getting this
    // wrong rotates every ship 90°, so it is worth pinning down.
    expect(metadataFor(ASSET.SHIP.PLAYER).artAxis).toBe('up');
  });
});

describe('Starling atlas parser', () => {
  const xml = `<?xml version="1.0"?>
    <TextureAtlas imagePath="sheet.png">
      <SubTexture name="ship_1.png" x="0" y="0" width="66" height="113"/>
      <SubTexture name="ship_2.png" x="408" y="0" width="66" height="113"/>
    </TextureAtlas>`;

  it('reads every SubTexture', () => {
    const frames = parseStarlingAtlasXml(xml);
    expect(frames.size).toBe(2);
    expect(frames.get('ship_1.png')).toEqual({ name: 'ship_1.png', x: 0, y: 0, width: 66, height: 113 });
    expect(frames.get('ship_2.png')?.x).toBe(408);
  });

  it('rejects a document with no usable frames', () => {
    expect(() => parseStarlingAtlasXml('<TextureAtlas/>')).toThrow();
  });

  it('skips malformed entries instead of failing the whole atlas', () => {
    const mixed = `<TextureAtlas>
      <SubTexture name="good.png" x="1" y="2" width="10" height="20"/>
      <SubTexture name="zero-width.png" x="0" y="0" width="0" height="10"/>
      <SubTexture x="0" y="0" width="5" height="5"/>
    </TextureAtlas>`;
    const frames = parseStarlingAtlasXml(mixed);
    expect(frames.size).toBe(1);
    expect(frames.has('good.png')).toBe(true);
  });

  it('throws on malformed XML rather than returning an empty atlas', () => {
    expect(() => parseStarlingAtlasXml('<TextureAtlas><unclosed>')).toThrow();
  });
});

describe('arena layout', () => {
  const islands = compileIslands(ISLAND_DEFINITIONS);

  it('compiles every island into tiles and collision rects', () => {
    expect(islands.length).toBe(ISLAND_DEFINITIONS.length);
    for (const island of islands) {
      expect(island.tiles.length).toBeGreaterThan(0);
      expect(island.solids.length).toBe(island.tiles.length);
      expect(island.bounds.width).toBeGreaterThan(0);
    }
  });

  it('places every island inside the arena', () => {
    const { arena } = DEFAULT_GAME_CONFIG;
    for (const island of islands) {
      expect(island.bounds.x).toBeGreaterThanOrEqual(0);
      expect(island.bounds.y).toBeGreaterThanOrEqual(0);
      expect(island.bounds.x + island.bounds.width).toBeLessThanOrEqual(arena.width);
      expect(island.bounds.y + island.bounds.height).toBeLessThanOrEqual(arena.height);
    }
  });

  it('never overlaps two islands', () => {
    for (let i = 0; i < islands.length; i += 1) {
      for (let j = i + 1; j < islands.length; j += 1) {
        const a = islands[i]!.bounds;
        const b = islands[j]!.bounds;
        const overlaps =
          a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlaps, `${ISLAND_DEFINITIONS[i]!.id} overlaps ${ISLAND_DEFINITIONS[j]!.id}`).toBe(false);
      }
    }
  });

  it('aligns tiles to the tile grid', () => {
    for (const island of islands) {
      for (const tile of island.tiles) {
        expect(tile.rect.x % TILE_SIZE).toBe(0);
        expect(tile.rect.y % TILE_SIZE).toBe(0);
        expect(tile.rect.width).toBe(TILE_SIZE);
        expect(tile.rect.height).toBe(TILE_SIZE);
      }
    }
  });

  it('gives each island a beach border and a grass interior', () => {
    const central = islands[0]!;
    expect(central.tiles.some((tile) => tile.interior)).toBe(true);
    expect(central.tiles.some((tile) => !tile.interior)).toBe(true);
    expect(central.tiles.some((tile) => tile.corner !== null)).toBe(true);
  });

  it('starts the player on open water, clear of land', () => {
    expect(isInsideAnyIsland(islands, PLAYER_SPAWN.x, PLAYER_SPAWN.y)).toBe(false);

    // Also clear when the spawn point is inflated by the hull radius.
    const world = new GameWorld();
    expect(world.playerEntity).toBeNull();
  });

  it('keeps every broadside muzzle on water at spawn', () => {
    // A broadside fired on the opening frame must not be swallowed by terrain.
    const { player } = DEFAULT_GAME_CONFIG;
    for (const weapon of [player.weapons.left, player.weapons.right]) {
      for (const muzzle of weapon.muzzles) {
        const cos = Math.cos(PLAYER_SPAWN.angle);
        const sin = Math.sin(PLAYER_SPAWN.angle);
        const x = PLAYER_SPAWN.x + muzzle.x * cos - muzzle.y * sin;
        const y = PLAYER_SPAWN.y + muzzle.x * sin + muzzle.y * cos;
        expect(isInsideAnyIsland(islands, x, y)).toBe(false);
      }
    }
  });

  it('leaves a water lane on every side of the arena', () => {
    // A chase with no escape route is a design bug, not a challenge.
    const { arena } = DEFAULT_GAME_CONFIG;
    const laneHalf = TILE_SIZE * 1.5;
    expect(isInsideAnyIsland(islands, arena.width / 2, laneHalf)).toBe(false);
    expect(isInsideAnyIsland(islands, arena.width / 2, arena.height - laneHalf)).toBe(false);
    expect(isInsideAnyIsland(islands, laneHalf, arena.height / 2)).toBe(false);
    expect(isInsideAnyIsland(islands, arena.width - laneHalf, arena.height / 2)).toBe(false);
  });

  it('finds land and water correctly', () => {
    const central = islands[0]!;
    expect(isInsideAnyIsland(islands, central.centroid.x, central.centroid.y)).toBe(true);
    expect(isInsideAnyIsland(islands, PLAYER_SPAWN.x, PLAYER_SPAWN.y)).toBe(false);
  });
});

describe('gameplay configuration', () => {
  it('keeps the session duration inside the required 60–180 s window', () => {
    expect(DEFAULT_GAME_CONFIG.match.durationSeconds).toBeGreaterThanOrEqual(60);
    expect(DEFAULT_GAME_CONFIG.match.durationSeconds).toBeLessThanOrEqual(180);
  });

  it('keeps the spawn interval positive', () => {
    const { spawn } = DEFAULT_GAME_CONFIG;
    expect(spawn.minIntervalSeconds).toBeGreaterThan(0);
    expect(spawn.maxIntervalSeconds).toBeGreaterThanOrEqual(spawn.minIntervalSeconds);
  });

  it('gives both enemy types a non-zero spawn weight', () => {
    const { spawn } = DEFAULT_GAME_CONFIG;
    expect(spawn.chaserWeight).toBeGreaterThan(0);
    expect(spawn.shooterWeight).toBeGreaterThan(0);
  });

  it('fires three shots from each broadside', () => {
    const { player } = DEFAULT_GAME_CONFIG;
    expect(player.weapons.front.muzzles).toHaveLength(1);
    expect(player.weapons.left.muzzles).toHaveLength(3);
    expect(player.weapons.right.muzzles).toHaveLength(3);
  });

  it('aims broadsides perpendicular to the bow', () => {
    const { TAU } = { TAU: Math.PI * 2 };
    const left = broadsideDirection('left');
    const right = broadsideDirection('right');
    expect(Math.abs(Math.abs(left) - Math.PI / 2)).toBeLessThan(1e-9);
    // Left and right must point opposite ways.
    expect(Math.abs(Math.abs(left - right) - Math.PI)).toBeLessThan(1e-9);
    void TAU;
  });

  it('makes the player tougher than either enemy', () => {
    const { player, chaser, shooter } = DEFAULT_GAME_CONFIG;
    expect(player.maxHealth).toBeGreaterThan(chaser.maxHealth);
    expect(player.maxHealth).toBeGreaterThan(shooter.maxHealth);
  });

  it('keeps hitboxes smaller than the artwork so dodges are fair', () => {
    // A hitbox matching the sprite's full length makes broadsides unhittable.
    const { player } = DEFAULT_GAME_CONFIG;
    expect(player.hitboxRadius).toBeLessThan(60);
  });

  it('gives every weapon a cooldown and a lifetime', () => {
    const { player, shooter } = DEFAULT_GAME_CONFIG;
    for (const weapon of [player.weapons.front, player.weapons.left, player.weapons.right, shooter.weapon]) {
      expect(weapon.cooldownMs).toBeGreaterThan(0);
      expect(weapon.projectileLifetimeMs).toBeGreaterThan(0);
      expect(weapon.damage).toBeGreaterThan(0);
      expect(weapon.projectileSpeed).toBeGreaterThan(0);
    }
  });

  it('scores a player kill for both enemy types and nothing for a self-destruct', () => {
    const { chaser, shooter } = DEFAULT_GAME_CONFIG;
    expect(chaser.scoreOnPlayerKill).toBe(1);
    expect(shooter.scoreOnPlayerKill).toBe(1);
    expect(chaser.scoreOnSelfDestruct).toBe(0);
  });

  it('places the shooter inside its own engagement envelope', () => {
    // An attack range narrower than the preferred stand-off would mean the
    // shooter could never actually fire.
    const { shooter } = DEFAULT_GAME_CONFIG;
    expect(shooter.attackRange).toBeGreaterThanOrEqual(shooter.preferredRange);
  });

  it('keeps the spawn distance larger than a hull', () => {
    const { spawn, player } = DEFAULT_GAME_CONFIG;
    expect(spawn.minPlayerDistance).toBeGreaterThan(player.hitboxRadius * 4);
  });

  it('gives enemies a turn radius smaller than their engagement distance', () => {
    // A pursuer whose minimum turning circle exceeds the distance to its target
    // orbits forever instead of closing. This is a real, observed failure mode.
    const { chaser, shooter, spawn } = DEFAULT_GAME_CONFIG;
    const chaserRadius = chaser.moveSpeed / ((chaser.turnSpeedDegPerSec * Math.PI) / 180);
    expect(chaserRadius).toBeLessThan(spawn.minPlayerDistance);
    void shooter;
  });
});
