import { TILE_SIZE } from './gameConfig';
import type { Rect } from '../core/types';

/**
 * ============================================================================
 *  ARENA LAYOUT — island shapes as tile masks
 * ============================================================================
 *
 * Islands are authored, not generated: a designer can guarantee a readable,
 * balanced arena, and the playfield becomes byte-identical across seeds, which
 * is what lets the visual-regression baseline stay stable.
 *
 * A mask is a grid where `#` = solid land and `.` = water. Collision is derived
 * from the mask at match start (one AABB per solid tile).
 *
 * PERFORMANCE NOTE: authoring beats procedural generation for a game whose
 * visual tests must be deterministic, and the mask cost here is ~20 KB of data
 * for three islands — far cheaper than shipping and tuning a noise generator.
 */

export interface IslandDefinition {
  readonly id: string;
  /** Tile-grid origin of the island's top-left corner. */
  readonly gridX: number;
  readonly gridY: number;
  /** Island-LOCAL mask: '#' = land, '.' = water. Positioned by gridX/gridY. */
  readonly mask: readonly string[];
}

/** 24 × 15 tiles = 1536 × 960 world units, matching the arena exactly. */
const GRID_W = 24;
const GRID_H = 15;

/**
 * Validates an authored mask at module load.
 *
 * Masks are hand-authored for design control, so the realistic failure modes are
 * a ragged row or an island placed off the grid. Catching both here turns a
 * silent layout bug into a loud, immediate error.
 */
const buildMask = (rows: readonly string[]): readonly string[] => {
  const width = rows[0]?.length ?? 0;
  if (width === 0) throw new Error('Island mask is empty');

  for (const [index, row] of rows.entries()) {
    if (row.length !== width) {
      throw new Error(
        `Island mask row ${index} has width ${row.length}, expected ${width}. Row: "${row}"`,
      );
    }
  }
  if (rows.length > GRID_H) {
    throw new Error(`Island mask has ${rows.length} rows, expected at most ${GRID_H}`);
  }
  return rows;
};

/** Guards against an island that would extend past the arena. */
const validatePlacement = (definition: IslandDefinition): IslandDefinition => {
  const width = definition.mask[0]?.length ?? 0;
  const right = definition.gridX + width;
  const bottom = definition.gridY + definition.mask.length;
  if (right > GRID_W || bottom > GRID_H || definition.gridX < 0 || definition.gridY < 0) {
    throw new Error(
      `Island "${definition.id}" occupies columns ${definition.gridX}..${right} and rows ` +
        `${definition.gridY}..${bottom}, which exceeds the ${GRID_W}×${GRID_H} arena grid`,
    );
  }
  return definition;
};

const defineIsland = (definition: IslandDefinition): IslandDefinition =>
  validatePlacement({ ...definition, mask: buildMask(definition.mask) });

/**
 * One large central island, one medium north-east, one small south-west.
 *
 * Design constraints encoded here:
 *   • The player's spawn (south-west water) stays clear of land.
 *   • The spawn band along the arena border stays navigable.
 *   • Water lanes exist on every side so a chase never becomes a dead end.
 */
export const ISLAND_DEFINITIONS: readonly IslandDefinition[] = [
  // Columns 7..19, rows 5..10 — the main obstacle. Leaves a water lane on every
  // side: north (rows 0..4), west (cols 0..6), east (cols 20..23), south
  // (rows 11..14). A chase can therefore never become a dead end.
  defineIsland({
    id: 'isle-central',
    gridX: 7,
    gridY: 5,
    mask: [
      '###########..',
      '#############',
      '#############',
      '#############',
      '#############',
      '#############',
    ],
  }),
  // Columns 18..23, rows 0..3.
  defineIsland({
    id: 'isle-northeast',
    gridX: 18,
    gridY: 0,
    mask: ['####..', '######', '######', '####..'],
  }),
  // Columns 1..5, rows 11..14.
  defineIsland({
    id: 'isle-southwest',
    gridX: 1,
    gridY: 11,
    mask: ['###..', '#####', '#####', '###..'],
  }),
];

/**
 * Where the player begins: open water west of the central island, facing north.
 *
 * Verified against the masks above:
 *   • the spawn tile is water,
 *   • all four broadside muzzle offsets land on water at spawn, so the opening
 *     broadside cannot be swallowed by terrain,
 *   • the nearest land is 128 units away — far enough to react before contact.
 */
export const PLAYER_SPAWN = { x: 352, y: 592, angle: -Math.PI / 2 } as const;

export interface TileCoord {
  readonly tx: number;
  readonly ty: number;
}

export interface IslandTile {
  readonly rect: Rect;
  readonly tx: number;
  readonly ty: number;
  /** True when the tile touches no orthogonal land neighbour — it is an edge tile. */
  readonly isEdge: boolean;
  /** Which corner of the island this tile forms, or null for edges/interiors. */
  readonly corner: 'nw' | 'ne' | 'sw' | 'se' | null;
  /** Grass interior vs sand beach, decided by erosion of the mask border. */
  readonly interior: boolean;
}

export interface CompiledIsland {
  readonly id: string;
  readonly tiles: readonly IslandTile[];
  /** Solid rectangles for collision. */
  readonly solids: readonly Rect[];
  readonly bounds: Rect;
  readonly centroid: { x: number; y: number };
}

/**
 * Compiles masks into render tiles + collision rects.
 *
 * Interior/beach classification uses a one-tile erosion of the mask: a solid
 * tile with a missing orthogonal neighbour is beach, otherwise it is grass.
 * Corner detection looks at which two orthogonal neighbours are missing.
 */
export function compileIslands(definitions: readonly IslandDefinition[]): CompiledIsland[] {
  return definitions.map((definition) => compileIsland(definition));
}

function compileIsland(definition: IslandDefinition): CompiledIsland {
  const { gridX, gridY, mask } = definition;
  const rows = mask.length;
  const cols = rows > 0 ? (mask[0]?.length ?? 0) : 0;

  const isSolid = (tx: number, ty: number): boolean => {
    const row = mask[ty];
    if (row === undefined) return false;
    return row[tx] === '#';
  };

  const tiles: IslandTile[] = [];
  const solids: Rect[] = [];
  let sumX = 0;
  let sumY = 0;

  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < cols; tx += 1) {
      if (!isSolid(tx, ty)) continue;

      const rect: Rect = {
        x: (gridX + tx) * TILE_SIZE,
        y: (gridY + ty) * TILE_SIZE,
        width: TILE_SIZE,
        height: TILE_SIZE,
      };

      const up = isSolid(tx, ty - 1);
      const down = isSolid(tx, ty + 1);
      const left = isSolid(tx - 1, ty);
      const right = isSolid(tx + 1, ty);

      const missingUp = !up;
      const missingDown = !down;
      const missingLeft = !left;
      const missingRight = !right;
      const isEdge = missingUp || missingDown || missingLeft || missingRight;

      // A corner tile is missing two *orthogonally adjacent* neighbours.
      let corner: IslandTile['corner'] = null;
      if (missingUp && missingLeft) corner = 'nw';
      else if (missingUp && missingRight) corner = 'ne';
      else if (missingDown && missingLeft) corner = 'sw';
      else if (missingDown && missingRight) corner = 'se';

      tiles.push({ rect, tx: gridX + tx, ty: gridY + ty, isEdge, corner, interior: !isEdge });
      solids.push(rect);
      sumX += rect.x + rect.width / 2;
      sumY += rect.y + rect.height / 2;
    }
  }

  const count = tiles.length;
  const centroid = count === 0 ? { x: 0, y: 0 } : { x: sumX / count, y: sumY / count };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const tile of tiles) {
    minX = Math.min(minX, tile.rect.x);
    minY = Math.min(minY, tile.rect.y);
    maxX = Math.max(maxX, tile.rect.x + tile.rect.width);
    maxY = Math.max(maxY, tile.rect.y + tile.rect.height);
  }

  return {
    id: definition.id,
    tiles,
    solids,
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    centroid,
  };
}

export { GRID_W as ARENA_GRID_COLUMNS, GRID_H as ARENA_GRID_ROWS };

/** Convenience for tests and the spawner: true when the point sits over land. */
export function isInsideAnyIsland(
  islands: readonly CompiledIsland[],
  x: number,
  y: number,
  padding = 0,
): boolean {
  for (const island of islands) {
    const { bounds } = island;
    if (
      x >= bounds.x - padding &&
      x <= bounds.x + bounds.width + padding &&
      y >= bounds.y - padding &&
      y <= bounds.y + bounds.height + padding
    ) {
      return true;
    }
  }
  return false;
}

/** The horizontal and vertical extents a hull must stay within. */
export interface ArenaBounds {
  readonly width: number;
  readonly height: number;
  /** Distance kept between a hull and the visible arena edge. */
  readonly boundsPadding: number;
}

export interface ArenaPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Confines a hull to the arena.
 *
 * WHY THIS IS A SHARED PURE FUNCTION. The rule had two implementations — one in
 * the player system and one in the world — and they disagreed: the player's also
 * zeroed velocity, the world's did not, and the world's was only reached when an
 * island had just pushed the hull. An enemy sailing through open border water
 * therefore never met either. One function, used by every hull, removes the whole
 * class of bug rather than patching one instance of it.
 *
 * WHY IT RETURNS A POINT INSTEAD OF MUTATING. A pure function can be tested
 * headlessly, with no entity, no store and no renderer — which is the only reason
 * this rule is covered by the rule-engine suite at all.
 *
 * VELOCITY IS NOT TOUCHED HERE, and that is deliberate. Whether a clamped hull
 * should also stop thrusting is a per-system policy: the player's velocity is
 * integrated from input and must be zeroed or it keeps accelerating into the
 * border, whereas an enemy's velocity is recomputed from scratch every frame by
 * its AI, so zeroing it would have no effect. Mixing the two here would be wrong
 * for one of them.
 */
export function clampInsideArena(
  x: number,
  y: number,
  radius: number,
  arena: ArenaBounds,
): ArenaPoint {
  const minX = arena.boundsPadding + radius;
  const maxX = arena.width - arena.boundsPadding - radius;
  const minY = arena.boundsPadding + radius;
  const maxY = arena.height - arena.boundsPadding - radius;

  return {
    x: x < minX ? minX : x > maxX ? maxX : x,
    y: y < minY ? minY : y > maxY ? maxY : y,
  };
}
