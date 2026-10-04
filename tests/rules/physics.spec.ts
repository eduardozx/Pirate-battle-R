import { describe, expect, it } from 'vitest';

import {
  circlesOverlap,
  circleOverlapsAnyRect,
  resolveCircleAgainstRects,
  sweepSegmentCircle,
  sweepSegmentRect,
} from '../../src/game/physics/collision';
import { SpatialHash } from '../../src/game/physics/spatialHash';
import { EntityStore } from '../../src/game/entities/entityStore';
import {
  TAU,
  circleRectPushOut,
  pointRectDistanceSquared,
} from '../../src/game/core/math';
import type { ProjectileEntity } from '../../src/game/entities/entityModels';

/**
 * Geometry tests.
 *
 * These pin down the properties the gameplay rules depend on. Notably the
 * anti-tunnelling guarantee: at production speeds a cannonball covers ~5 units per
 * substep and ~60 units in a single worst-case frame, so a discrete overlap test
 * would let shots pass straight through hulls.
 */

describe('sweepSegmentCircle', () => {
  it('detects a circle the segment passes through', () => {
    // Centre 5 units off the segment's axis, combined radius 8 → a hit.
    const hit = sweepSegmentCircle(0, 0, 100, 0, 50, 5, 8);
    expect(hit.hit).toBe(true);
  });

  it('reports the FIRST contact, not the centre of the target', () => {
    // The impact point must be where the shot actually met the hull, because the
    // renderer draws the impact effect there. First contact along the segment is
    // 50 − √(8² − 5²) ≈ 43.76.
    const hit = sweepSegmentCircle(0, 0, 100, 0, 50, 5, 8);
    expect(hit.hit).toBe(true);
    expect(hit.x).toBeCloseTo(50 - Math.sqrt(64 - 25), 6);
    expect(hit.y).toBeCloseTo(0, 6);
    expect(hit.t).toBeGreaterThan(0);
    expect(hit.t).toBeLessThan(1);
  });

  it('misses a circle beside the segment', () => {
    expect(sweepSegmentCircle(0, 0, 100, 0, 50, 40, 8).hit).toBe(false);
  });

  it('detects a circle just behind the starting point', () => {
    // Already overlapping at t=0: counts as an immediate hit.
    const hit = sweepSegmentCircle(0, 0, 100, 0, -3, 0, 5);
    expect(hit.hit).toBe(true);
    expect(hit.t).toBe(0);
  });

  it('misses a circle just beyond the end point', () => {
    expect(sweepSegmentCircle(0, 0, 100, 0, 120, 0, 5).hit).toBe(false);
  });

  it('cannot tunnel through a hull at maximum frame delta', () => {
    // Worst case: a 100 ms frame clamped, front cannon at 620 u/s → 62 units of
    // travel in one frame. The target is only 20 units across.
    const travel = 62;
    const targetX = 40;
    const hit = sweepSegmentCircle(0, 0, travel, 0, targetX, 0, 22 + 6);

    expect(hit.hit).toBe(true);
    // The reported impact point is at first contact, not at the frame's end.
    expect(hit.x).toBeCloseTo(targetX - 28, 0);
    expect(hit.x).toBeLessThan(targetX);
  });

  it('handles a stationary segment', () => {
    expect(sweepSegmentCircle(10, 10, 10, 10, 12, 10, 5).hit).toBe(true);
    expect(sweepSegmentCircle(10, 10, 10, 10, 40, 10, 5).hit).toBe(false);
  });

  it('handles a zero-length direction without dividing by zero', () => {
    const hit = sweepSegmentCircle(0, 0, 0, 0, 30, 0, 4);
    expect(hit.hit).toBe(false);
  });

  it('accounts for the combined radius exactly at the tangent', () => {
    // Circle centre 10 units away, combined radius 10: exactly touching.
    expect(sweepSegmentCircle(0, 0, 100, 0, 0, 10, 10).hit).toBe(true);
    expect(sweepSegmentCircle(0, 0, 100, 0, 0, 10.5, 10).hit).toBe(false);
  });
});

describe('sweepSegmentRect', () => {
  const rect = { x: 50, y: -20, width: 40, height: 40 };

  it('hits a rect the segment crosses', () => {
    expect(sweepSegmentRect(0, 0, 200, 0, rect, 4).hit).toBe(true);
  });

  it('misses a rect the segment passes beside', () => {
    expect(sweepSegmentRect(0, 60, 200, 60, rect, 4).hit).toBe(false);
  });

  it('reports the first contact point', () => {
    const hit = sweepSegmentRect(0, 0, 200, 0, rect, 0);
    expect(hit.hit).toBe(true);
    expect(hit.x).toBeCloseTo(50, 5);
  });

  it('inflates the rect by the projectile radius', () => {
    // Passes 2 units above the rect's top edge: a miss at radius 0, a hit at 4.
    expect(sweepSegmentRect(0, -22, 200, -22, rect, 0).hit).toBe(false);
    expect(sweepSegmentRect(0, -22, 200, -22, rect, 4).hit).toBe(true);
  });

  it('is not confused by a segment that spans many tiles', () => {
    // A segment long enough to cross several cells must still report the hit.
    const big = { x: 100, y: -100, width: 2000, height: 200 };
    expect(sweepSegmentRect(0, 0, 5000, 0, big, 4).hit).toBe(true);
  });
});

describe('circlesOverlap', () => {
  it('is true when the circles touch', () => {
    expect(circlesOverlap(0, 0, 10, 20, 0, 10)).toBe(true);
  });

  it('is false just beyond touching', () => {
    expect(circlesOverlap(0, 0, 10, 20.5, 0, 10)).toBe(false);
  });
});

describe('circleRectPushOut', () => {
  it('pushes a circle out along the shortest axis', () => {
    const rect = { x: 0, y: 0, width: 100, height: 100 };
    // Circle centre inside the rect, nearer the left edge.
    const push = circleRectPushOut(rect, 10, 50, 5);
    expect(push.x).toBeLessThan(0);
    expect(push.y).toBe(0);
  });

  it('returns zero when there is no overlap', () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    const push = circleRectPushOut(rect, 100, 100, 5);
    expect(push.x).toBe(0);
    expect(push.y).toBe(0);
  });

  it('pushes a circle out through a corner, away from the rect', () => {
    const rect = { x: 0, y: 0, width: 100, height: 100 };
    // The circle sits outside the top-left corner, 5 units out along the
    // diagonal. A radius-7 circle penetrates 2 units, and the resolution must
    // move the centre FURTHER from the rect — i.e. toward negative x and y.
    const push = circleRectPushOut(rect, -3, -4, 7);
    expect(push.x).toBeLessThan(0);
    expect(push.y).toBeLessThan(0);
    expect(Math.hypot(push.x, push.y)).toBeCloseTo(2, 6);
    expect(push.x / push.y).toBeCloseTo(3 / 4, 6);

    // Resolved, the circle no longer overlaps.
    expect(pointRectDistanceSquared(rect, -3 + push.x, -4 + push.y)).toBeGreaterThanOrEqual(49);
  });

  it('does not push a circle that is exactly tangent', () => {
    const rect = { x: 0, y: 0, width: 100, height: 100 };
    // Distance to the corner is exactly 5 and the radius is exactly 5.
    const push = circleRectPushOut(rect, -3, -4, 5);
    expect(Math.hypot(push.x, push.y)).toBeLessThan(1e-9);
  });
});

describe('resolveCircleAgainstRects', () => {
  it('frees a circle trapped inside a single rect', () => {
    const rects = [{ x: 0, y: 0, width: 100, height: 100 }];
    const out = { x: 0, y: 0 };
    resolveCircleAgainstRects(50, 50, 10, rects, out);

    const resolvedX = 50 + out.x;
    const resolvedY = 50 + out.y;
    expect(circleOverlapsAnyRect(resolvedX, resolvedY, 10, rects)).toBe(false);
    // Ejected through the nearest face, so only one axis moves.
    expect(Math.abs(resolvedX - 50) > 0 && resolvedY === 50).toBe(true);
  });

  it('iterates so a circle wedged in a corner is freed in one call', () => {
    // Overlapping rects forming an inner corner. A single pass can only satisfy
    // one of them; the second pass is what makes resolution converge.
    const rects = [
      { x: 0, y: 0, width: 60, height: 100 },
      { x: 60, y: 0, width: 40, height: 60 },
    ];
    const out = { x: 0, y: 0 };
    resolveCircleAgainstRects(65, 65, 8, rects, out);

    expect(circleOverlapsAnyRect(65 + out.x, 65 + out.y, 8, rects)).toBe(false);
  });

  it('leaves a free circle untouched', () => {
    const rects = [{ x: 0, y: 0, width: 10, height: 10 }];
    const out = { x: 0, y: 0 };
    resolveCircleAgainstRects(500, 500, 10, rects, out);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });
});

describe('SpatialHash', () => {
  const makeProjectile = (id: number, x: number, y: number): ProjectileEntity => ({
    id,
    kind: 'projectile',
    owner: 'player',
    weaponId: 'player_front',
    assetKey: 'projectile.player',
    x,
    y,
    prevX: x,
    prevY: y,
    angle: 0,
    speed: 100,
    damage: 1,
    radius: 6,
    lifetimeMs: 1000,
    ageMs: 0,
    alive: true,
    hitIds: new Set(),
  });

  it('finds an entity in the queried cell', () => {
    const hash = new SpatialHash(1536, 960, 160, 256);
    const target = makeProjectile(1, 500, 500);
    hash.insert(target);

    const found: number[] = [];
    hash.query(505, 502, 10, (entity) => found.push(entity.id));
    expect(found).toContain(1);
  });

  it('does not return entities in distant cells', () => {
    const hash = new SpatialHash(1536, 960, 160, 256);
    hash.insert(makeProjectile(1, 100, 100));

    const found: number[] = [];
    hash.query(1200, 800, 10, (entity) => found.push(entity.id));
    expect(found).not.toContain(1);
  });

  it('finds an entity along a long swept segment', () => {
    const hash = new SpatialHash(1536, 960, 160, 256);
    const target = makeProjectile(7, 900, 500);
    hash.insert(target);

    // A segment crossing several cells must still report the target.
    const found: number[] = [];
    hash.querySegment(100, 500, 1400, 500, 6, (entity) => found.push(entity.id));
    expect(found).toContain(7);
  });

  it('clears completely between frames', () => {
    const hash = new SpatialHash(1536, 960, 160, 256);
    hash.insert(makeProjectile(1, 500, 500));
    expect(hash.entryCount).toBe(1);

    hash.clear();
    expect(hash.entryCount).toBe(0);

    const found: number[] = [];
    hash.query(500, 500, 10, (entity) => found.push(entity.id));
    expect(found).toHaveLength(0);
  });

  it('clamps out-of-bounds queries to the edge cells', () => {
    // A projectile mid-expulsion, or any hull being pushed out of an island, can
    // briefly sit outside the arena. A query there must clamp to a valid cell
    // instead of indexing past the end of the backing arrays.
    const hash = new SpatialHash(1536, 960, 160, 256);
    hash.insert(makeProjectile(1, 1520, 950));

    // Far past the bottom-right corner: clamps to the last cell, which holds #1.
    const far: number[] = [];
    hash.query(9999, 9999, 50, (entity) => far.push(entity.id));
    expect(far).toContain(1);

    // Far past the top-left corner: clamps to the FIRST cell, which is empty.
    // The important property is that it returns cleanly rather than throwing.
    const negative: number[] = [];
    expect(() =>
      hash.query(-9999, -9999, 50, (entity) => negative.push(entity.id)),
    ).not.toThrow();
    expect(negative).toHaveLength(0);
  });

  it('does not throw when a query radius spans the whole arena', () => {
    const hash = new SpatialHash(1536, 960, 160, 256);
    hash.insert(makeProjectile(1, 700, 480));
    hash.insert(makeProjectile(2, 100, 100));

    const found: number[] = [];
    expect(() => hash.query(768, 480, 5000, (entity) => found.push(entity.id))).not.toThrow();
    expect(found).toHaveLength(2);
  });
});

describe('EntityStore', () => {
  const stub = (id: number) =>
    ({
      id,
      kind: 'projectile',
      owner: 'player',
      weaponId: 'player_front',
      assetKey: 'projectile.player',
      x: 0,
      y: 0,
      prevX: 0,
      prevY: 0,
      angle: 0,
      speed: 1,
      damage: 1,
      radius: 1,
      lifetimeMs: 1,
      ageMs: 0,
      alive: true,
      hitIds: new Set<number>(),
    }) as unknown as ProjectileEntity;

  it('keeps ids unique for as long as capacity allows', () => {
    // Projectile hit-tracking and E2E assertions both rely on an id identifying
    // exactly one entity for the whole match. Ids therefore never recycle until
    // the id space itself wraps, which is a deliberate, documented limitation.
    const store = new EntityStore(512);
    const ids = new Set<number>();
    for (let i = 0; i < 400; i += 1) ids.add(store.reserveId());
    expect(ids.size).toBe(400);
  });

  it('reports a live count per kind', () => {
    const store = new EntityStore(32);
    const a = stub(store.reserveId());
    const b = stub(store.reserveId());
    store.add(a);
    store.add(b);

    expect(store.countOf('projectile')).toBe(2);
    expect(store.aliveCount).toBe(2);

    store.remove(a);
    expect(store.countOf('projectile')).toBe(1);
    expect(store.get(a.id)).toBeNull();
    expect(store.get(b.id)).toBe(b);
  });

  it('does not return a recycled slot for a stale id', () => {
    const store = new EntityStore(8);
    const first = stub(store.reserveId());
    store.add(first);
    store.remove(first);

    // Force id reuse of the same slot. `id` is readonly on the entity, so the
    // reuse is expressed through a single narrow cast at the assignment rather than
    // by weakening the model for every test that builds an entity.
    const second = stub(99);
    (second as { id: number }).id = first.id;
    store.add(second);

    expect(store.get(first.id)).toBe(second);
    expect(store.get(12345)).toBeNull();
  });

  it('clears every entity and count on reset', () => {
    const store = new EntityStore(16);
    store.add(stub(store.reserveId()));
    store.add(stub(store.reserveId()));
    expect(store.aliveCount).toBe(2);

    store.clear();

    expect(store.aliveCount).toBe(0);
    expect(store.countOf('projectile')).toBe(0);

    // Iteration after a clear must be a clean no-op.
    const visited: number[] = [];
    store.forEach((entity) => visited.push(entity.id));
    expect(visited).toHaveLength(0);
  });

  it('survives id wrap-around at capacity', () => {
    const store = new EntityStore(4);
    const a = stub(store.reserveId());
    store.add(a);
    // Enough allocations to wrap the id space.
    for (let i = 0; i < 10; i += 1) store.reserveId();
    const b = stub(store.reserveId());
    store.add(b);
    expect(store.aliveCount).toBe(2);
  });
});

describe('angles', () => {
  it('TAU is a full turn', () => {
    expect(TAU).toBeCloseTo(Math.PI * 2, 10);
  });
});
