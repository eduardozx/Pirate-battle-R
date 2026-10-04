/**
 * ============================================================================
 *  ASSET MANIFEST — the single source of truth for "what art does this key mean"
 * ============================================================================
 *
 * CONTRACT
 *   Simulation code stores *asset keys* (strings from `ASSET`), never URLs, never
 *   frame names, never file paths. Renderers ask the texture registry to resolve
 *   a key into textures. Swapping a sprite, a whole spritesheet or an image
 *   format is a one-line edit in `SPRITE_SOURCES` below — zero gameplay changes.
 *
 * WHY A SEPARATE FILE
 *   Art iteration and balance iteration have different owners and different
 *   blast radius. Keeping them apart is what lets a designer change the player's
 *   hull without ever touching the weapon cooldown table, and vice versa.
 *
 * EVERYTHING IN THIS FILE IS ENGLISH-ONLY AND TOOL-AGNOSTIC: it contains no
 * PixiJS types, so it can be imported by the headless simulation if needed.
 */

/* -------------------------------------------------------------------------- */
/* 1. Abstract asset keys — the only vocabulary the game code may use           */
/* -------------------------------------------------------------------------- */

export const ASSET = {
  SHIP: {
    PLAYER: 'ship.player',
    CHASER: 'ship.chaser',
    SHOOTER: 'ship.shooter',
  },
  PROJECTILE: {
    PLAYER: 'projectile.player',
    ENEMY: 'projectile.enemy',
  },
  EFFECT: {
    MUZZLE_FLASH: 'effect.muzzleFlash',
    EXPLOSION: 'effect.explosion',
    WOOD_IMPACT: 'effect.woodImpact',
    /** Cannonball striking open water at the arena border. */
    WATER_SPLASH: 'effect.waterSplash',
    /** Attached to a hull that has taken damage: persistent while hurt. */
    HULL_FIRE: 'effect.hullFire',
  },
  TILE: {
    WATER: 'tile.water',
    SAND: 'tile.sand',
    SAND_CORNER_NW: 'tile.sandCornerNw',
    SAND_CORNER_NE: 'tile.sandCornerNe',
    SAND_CORNER_SW: 'tile.sandCornerSw',
    SAND_CORNER_SE: 'tile.sandCornerSe',
    GRASS: 'tile.grass',
    ROCK: 'tile.rock',
    PLANT: 'tile.plant',
  },
  UI: {
    /** Menu panel background (9-slice). */
    PANEL_MENU: 'ui.panelMenu',
    /** Game title logo. */
    TITLE: 'ui.title',
    /** Primary button states. */
    BUTTON_PRIMARY_NORMAL: 'ui.buttonPrimaryNormal',
    BUTTON_PRIMARY_HOVER: 'ui.buttonPrimaryHover',
    BUTTON_PRIMARY_PRESSED: 'ui.buttonPrimaryPressed',
    BUTTON_PRIMARY_DISABLED: 'ui.buttonPrimaryDisabled',
    /** Secondary button states. */
    BUTTON_SECONDARY_NORMAL: 'ui.buttonSecondaryNormal',
    BUTTON_SECONDARY_PRESSED: 'ui.buttonSecondaryPressed',
    /** Round icon buttons (touch controls). */
    BUTTON_ROUND_NORMAL: 'ui.buttonRoundNormal',
    BUTTON_ROUND_HOVER: 'ui.buttonRoundHover',
    BUTTON_ROUND_PRESSED: 'ui.buttonRoundPressed',
    /** Counter/score panel. */
    COUNTER_PANEL: 'ui.counterPanel',
    /** Health bar components (HUD). */
    HEALTH_FRAME: 'ui.healthFrame',
    HEALTH_FILL_GREEN: 'ui.healthFillGreen',
    HEALTH_FILL_AMBER: 'ui.healthFillAmber',
    HEALTH_FILL_RED: 'ui.healthFillRed',
    /** Enemy health bar (above ships). */
    ENEMY_HEALTH_FRAME: 'ui.enemyHealthFrame',
    ENEMY_HEALTH_FILL_GREEN: 'ui.enemyHealthFillGreen',
    ENEMY_HEALTH_FILL_RED: 'ui.enemyHealthFillRed',
    /** Icons. */
    ICON_CLOSE: 'ui.iconClose',
    ICON_FIRE_FRONT: 'ui.iconFireFront',
    ICON_FIRE_LEFT: 'ui.iconFireLeft',
    ICON_FIRE_RIGHT: 'ui.iconFireRight',
    ICON_FORWARD: 'ui.iconForward',
    ICON_HEART: 'ui.iconHeart',
    ICON_HOME: 'ui.iconHome',
    ICON_MINUS: 'ui.iconMinus',
    ICON_PAUSE: 'ui.iconPause',
    ICON_PLAY: 'ui.iconPlay',
    ICON_PLUS: 'ui.iconPlus',
    ICON_RESTART: 'ui.iconRestart',
    ICON_SCORE: 'ui.iconScore',
    ICON_SETTINGS: 'ui.iconSettings',
    ICON_TIME: 'ui.iconTime',
    ICON_TURN_LEFT: 'ui.iconTurnLeft',
    ICON_TURN_RIGHT: 'ui.iconTurnRight',
  },
} as const;

type Leaves<T> = T extends string ? T : { [K in keyof T]: Leaves<T[K]> }[keyof T];

/** Union of every valid asset key. Typo-proof: unknown keys fail to compile. */
export type AssetKey = Leaves<typeof ASSET>;

/* -------------------------------------------------------------------------- */
/* 2. Source bindings — THE ONLY FILE THAT KNOWS ABOUT PATHS AND FRAME NAMES   */
/* -------------------------------------------------------------------------- */

export type AtlasId = 'ships' | 'ui';

export interface AtlasDefinition {
  /** The packed PNG holding every frame. */
  readonly sheetUrl: string;
  /** The descriptor describing frame rectangles inside `sheetUrl`. */
  readonly dataUrl: string;
  readonly dataFormat: 'starling-xml' | 'json';
}

/**
 * Base path for every art file. `import.meta.env.BASE_URL` keeps this correct
 * when the build is served from a sub-path.
 */
const ART_BASE = `${import.meta.env.BASE_URL}assets`;

/* --- To retarget ALL ship/effect art at once, edit these two entries. ----- */
export const ATLASES: Record<AtlasId, AtlasDefinition> = {
  ships: {
    sheetUrl: `${ART_BASE}/spritesheet/ships_miscellaneous_sheet.png`,
    dataUrl: `${ART_BASE}/spritesheet/ships_miscellaneous_sheet.xml`,
    dataFormat: 'starling-xml',
  },
  ui: {
    sheetUrl: `${ART_BASE}/spritesheet/ui_sheet.png`,
    dataUrl: `${ART_BASE}/spritesheet/ui_sheet.json`,
    dataFormat: 'json',
  },
};

const tile = (index: number): string => `${ART_BASE}/png/default/tiles/tile_${index}.png`;

/**
 * A source is either one or more frames inside a packed atlas, or a standalone
 * image. Both are resolved to `Texture[]` by the registry, so renderers only
 * ever deal in textures.
 */
export type SpriteSource =
  | { readonly kind: 'atlas'; readonly atlas: AtlasId; readonly frames: readonly string[] }
  | { readonly kind: 'image'; readonly url: string };

export const SPRITE_SOURCES: Record<AssetKey, SpriteSource> = {
  /* --- Ships: art points UP in the PNG; simulation's bow points +X. ------- */
  'ship.player': {
    kind: 'atlas',
    atlas: 'ships',
    frames: ['ship_6.png'],
  },
  // Three hull variants share the black-skull livery so chasers read as a family.
  'ship.chaser': {
    kind: 'atlas',
    atlas: 'ships',
    frames: ['ship_2.png', 'ship_8.png', 'ship_14.png'],
  },
  // Blue livery + smaller silhouette: unmistakably a different threat class.
  'ship.shooter': {
    kind: 'atlas',
    atlas: 'ships',
    frames: ['ship_5.png', 'ship_11.png', 'ship_17.png'],
  },

  /* --- Projectiles ------------------------------------------------------- */
  'projectile.player': { kind: 'atlas', atlas: 'ships', frames: ['cannon_ball.png'] },
  'projectile.enemy': { kind: 'atlas', atlas: 'ships', frames: ['cannon_ball.png'] },

  /* --- Effects: multi-frame lists are played as a one-shot animation ------ */
  'effect.muzzleFlash': { kind: 'atlas', atlas: 'ships', frames: ['fire_1.png', 'fire_2.png'] },
  'effect.explosion': {
    kind: 'atlas',
    atlas: 'ships',
    frames: ['explosion_1.png', 'explosion_2.png', 'explosion_3.png'],
  },
  'effect.woodImpact': { kind: 'atlas', atlas: 'ships', frames: ['wood_1.png', 'wood_2.png'] },
  // The flame frames double as a water-impact burst: tinted white-blue by the
  // renderer so it reads as spray rather than fire.
  'effect.waterSplash': { kind: 'atlas', atlas: 'ships', frames: ['fire_2.png'] },
  'effect.hullFire': { kind: 'atlas', atlas: 'ships', frames: ['fire_1.png', 'fire_2.png'] },

  /* --- Terrain ----------------------------------------------------------- */
  'tile.water': { kind: 'image', url: tile(73) },
  'tile.sand': { kind: 'image', url: tile(68) },
  'tile.sandCornerNw': { kind: 'image', url: tile(1) },
  'tile.sandCornerNe': { kind: 'image', url: tile(3) },
  'tile.sandCornerSw': { kind: 'image', url: tile(34) },
  'tile.sandCornerSe': { kind: 'image', url: tile(35) },
  'tile.grass': { kind: 'image', url: tile(40) },
  'tile.rock': { kind: 'image', url: tile(50) },
  'tile.plant': { kind: 'image', url: tile(71) },

  /* --- UI (ui_sheet_retina.json) ----------------------------------------- */
  'ui.panelMenu': { kind: 'atlas', atlas: 'ui', frames: ['panel_menu'] },
  'ui.title': { kind: 'atlas', atlas: 'ui', frames: ['title_pirate_battle'] },
  'ui.buttonPrimaryNormal': { kind: 'atlas', atlas: 'ui', frames: ['button_primary_normal'] },
  'ui.buttonPrimaryHover': { kind: 'atlas', atlas: 'ui', frames: ['button_primary_hover'] },
  'ui.buttonPrimaryPressed': { kind: 'atlas', atlas: 'ui', frames: ['button_primary_pressed'] },
  'ui.buttonPrimaryDisabled': { kind: 'atlas', atlas: 'ui', frames: ['button_primary_disabled'] },
  'ui.buttonSecondaryNormal': { kind: 'atlas', atlas: 'ui', frames: ['button_secondary_normal'] },
  'ui.buttonSecondaryPressed': { kind: 'atlas', atlas: 'ui', frames: ['button_secondary_pressed'] },
  'ui.buttonRoundNormal': { kind: 'atlas', atlas: 'ui', frames: ['button_round_normal'] },
  'ui.buttonRoundHover': { kind: 'atlas', atlas: 'ui', frames: ['button_round_hover'] },
  'ui.buttonRoundPressed': { kind: 'atlas', atlas: 'ui', frames: ['button_round_pressed'] },
  'ui.counterPanel': { kind: 'atlas', atlas: 'ui', frames: ['counter_panel'] },
  'ui.healthFrame': { kind: 'atlas', atlas: 'ui', frames: ['health_frame'] },
  'ui.healthFillGreen': { kind: 'atlas', atlas: 'ui', frames: ['health_fill_green'] },
  'ui.healthFillAmber': { kind: 'atlas', atlas: 'ui', frames: ['health_fill_amber'] },
  'ui.healthFillRed': { kind: 'atlas', atlas: 'ui', frames: ['health_fill_red'] },
  'ui.enemyHealthFrame': { kind: 'atlas', atlas: 'ui', frames: ['enemy_health_frame'] },
  'ui.enemyHealthFillGreen': { kind: 'atlas', atlas: 'ui', frames: ['enemy_health_fill_green'] },
  'ui.enemyHealthFillRed': { kind: 'atlas', atlas: 'ui', frames: ['enemy_health_fill_red'] },
  'ui.iconClose': { kind: 'atlas', atlas: 'ui', frames: ['icon_close'] },
  'ui.iconFireFront': { kind: 'atlas', atlas: 'ui', frames: ['icon_fire_front'] },
  'ui.iconFireLeft': { kind: 'atlas', atlas: 'ui', frames: ['icon_fire_left'] },
  'ui.iconFireRight': { kind: 'atlas', atlas: 'ui', frames: ['icon_fire_right'] },
  'ui.iconForward': { kind: 'atlas', atlas: 'ui', frames: ['icon_forward'] },
  'ui.iconHeart': { kind: 'atlas', atlas: 'ui', frames: ['icon_heart'] },
  'ui.iconHome': { kind: 'atlas', atlas: 'ui', frames: ['icon_home'] },
  'ui.iconMinus': { kind: 'atlas', atlas: 'ui', frames: ['icon_minus'] },
  'ui.iconPause': { kind: 'atlas', atlas: 'ui', frames: ['icon_pause'] },
  'ui.iconPlay': { kind: 'atlas', atlas: 'ui', frames: ['icon_play'] },
  'ui.iconPlus': { kind: 'atlas', atlas: 'ui', frames: ['icon_plus'] },
  'ui.iconRestart': { kind: 'atlas', atlas: 'ui', frames: ['icon_restart'] },
  'ui.iconScore': { kind: 'atlas', atlas: 'ui', frames: ['icon_score'] },
  'ui.iconSettings': { kind: 'atlas', atlas: 'ui', frames: ['icon_settings'] },
  'ui.iconTime': { kind: 'atlas', atlas: 'ui', frames: ['icon_time'] },
  'ui.iconTurnLeft': { kind: 'atlas', atlas: 'ui', frames: ['icon_turn_left'] },
  'ui.iconTurnRight': { kind: 'atlas', atlas: 'ui', frames: ['icon_turn_right'] },
};

/* -------------------------------------------------------------------------- */
/* 3. Presentation metadata — concerns of the RENDERER, never of the rules    */
/* -------------------------------------------------------------------------- */

export interface SpriteMetadata {
  /**
   * Direction the artwork points in screen space.
   * Ship PNGs are drawn bow-up, but the simulation uses +X as the bow, so the
   * renderer adds a -90° offset. Encoding that here means a horizontally-authored
   * replacement sprite needs no code change beyond flipping this flag.
   */
  readonly artAxis: 'up' | 'right';
  /** Uniform scale applied on top of the intrinsic texture size. */
  readonly renderScale: number;
}

const DEFAULT_METADATA: SpriteMetadata = { artAxis: 'up', renderScale: 1 };

export const SPRITE_METADATA: Partial<Record<AssetKey, SpriteMetadata>> = {
  'ship.player': { artAxis: 'up', renderScale: 1 },
  'ship.chaser': { artAxis: 'up', renderScale: 0.92 },
  'ship.shooter': { artAxis: 'up', renderScale: 0.78 },
  'projectile.player': { artAxis: 'up', renderScale: 1.6 },
  'projectile.enemy': { artAxis: 'up', renderScale: 1.5 },
  'effect.muzzleFlash': { artAxis: 'up', renderScale: 0.85 },
  'effect.explosion': { artAxis: 'up', renderScale: 1.1 },
  'effect.woodImpact': { artAxis: 'up', renderScale: 0.45 },
  'effect.waterSplash': { artAxis: 'up', renderScale: 0.8 },
  'effect.hullFire': { artAxis: 'up', renderScale: 0.42 },
};

export const metadataFor = (key: AssetKey): SpriteMetadata =>
  SPRITE_METADATA[key] ?? DEFAULT_METADATA;

/* -------------------------------------------------------------------------- */
/* 4. Island tile roles — layout semantics, expressed purely in asset keys     */
/* -------------------------------------------------------------------------- */

export type IslandTileRole =
  | 'interior'
  | 'beach'
  | 'corner-nw'
  | 'corner-ne'
  | 'corner-sw'
  | 'corner-se'
  | 'decor';

/**
 * Maps an island tile role to art. Changing the beach look = edit this table.
 * `corner-*` are rounded beach tiles placed on the convex corners of the shape.
 */
export const ISLAND_TILE_ROLES: Record<IslandTileRole, AssetKey> = {
  interior: ASSET.TILE.GRASS,
  beach: ASSET.TILE.SAND,
  'corner-nw': ASSET.TILE.SAND_CORNER_NW,
  'corner-ne': ASSET.TILE.SAND_CORNER_NE,
  'corner-sw': ASSET.TILE.SAND_CORNER_SW,
  'corner-se': ASSET.TILE.SAND_CORNER_SE,
  decor: ASSET.TILE.ROCK,
};

/* -------------------------------------------------------------------------- */
/* 5. Derived helpers used by the loader                                       */
/* -------------------------------------------------------------------------- */

/** Every distinct atlas referenced by any asset — drives what must be preloaded. */
export const referencedAtlasIds = (): AtlasId[] => {
  const ids = new Set<AtlasId>();
  for (const source of Object.values(SPRITE_SOURCES)) {
    if (source.kind === 'atlas') ids.add(source.atlas);
  }
  return [...ids];
};

/** Every distinct image URL referenced by any asset. */
export const referencedImageUrls = (): string[] => {
  const urls = new Set<string>();
  for (const source of Object.values(SPRITE_SOURCES)) {
    if (source.kind === 'image') urls.add(source.url);
  }
  return [...urls];
};

/** Total textures the loader must acquire — surfaced on the loading screen. */
export const expectedTextureCount = (): number =>
  Object.values(SPRITE_SOURCES).reduce(
    (total, source) => total + (source.kind === 'atlas' ? source.frames.length : 1),
    0,
  );

/**
 * Development guard: fails loudly at boot if the two tables drift apart, which
 * would otherwise surface as an invisible (transparent) sprite much later.
 */
export function validateManifest(): void {
  if (!import.meta.env.DEV) return;

  const keySet = new Set<string>(Object.keys(SPRITE_SOURCES));
  const declared = collectDeclaredKeys();
  const missing = [...declared].filter((key) => !keySet.has(key));
  if (missing.length > 0) {
    throw new Error(
      `[assetManifest] These keys are declared in ASSET but have no SPRITE_SOURCES entry: ${missing.join(', ')}`,
    );
  }
  const orphans = [...keySet].filter((key) => !declared.has(key));
  if (orphans.length > 0) {
    console.warn(
      `[assetManifest] SPRITE_SOURCES contains unreachable keys (typo?): ${orphans.join(', ')}`,
    );
  }
}

function collectDeclaredKeys(): Set<string> {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.add(node);
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(ASSET);
  return out;
}
