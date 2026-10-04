import type { Rect } from '../core/types';
import { circleRectPushOut, distanceSquared, pointRectDistanceSquared } from '../core/math';

/** Mutable vector used as a reusable out-parameter. */
export interface MutableVec2 {
  x: number;
  y: number;
}

/**
 * ============================================================================
 *  COLLISION GEOMETRY — pure functions, zero engine imports
 * ============================================================================
 *
 * Every routine here is allocation-free (results are returned via out-params or
 * reused vectors) so it is safe to call thousands of times per frame.
 */

/**
 * Result of a swept test.
 *
 * Deliberately MUTABLE: these objects are reused as out-parameters so the hot
 * path performs zero allocations. Callers read the fields immediately after the
 * call and must not retain a reference.
 */
export interface SweepHit {
  hit: boolean;
  /** Parametric position along the segment, 0..1, of first contact. */
  t: number;
  x: number;
  y: number;
}

const NO_HIT: SweepHit = { hit: false, t: 0, x: 0, y: 0 };

/**
 * Swept circle-vs-circle: does a projectile travelling (x0,y0) → (x1,y1) touch
 * a circle at (cx,cy) with radius r + projectileRadius?
 *
 * WHY SWEEP AND NOT DISCRETE OVERLAP: at 620 units/s and a 1/120 s substep a
 * shot moves ~5 units, but a frame spike clamped to 100 ms moves 62 units —
 * straight through a 20-unit hull. Sweeping makes tunnelling impossible
 * regardless of frame pacing, which is exactly what the spec demands of
 * frame-rate-independent simulation.
 */
export function sweepSegmentCircle(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  combinedRadius: number,
  out: SweepHit = NO_HIT,
): SweepHit {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const fx = x0 - cx;
  const fy = y0 - cy;

  const a = dx * dx + dy * dy;
  const c = fx * fx + fy * fy - combinedRadius * combinedRadius;

  // Already overlapping at the start: hit immediately.
  if (c <= 0) {
    out.hit = true;
    out.t = 0;
    out.x = x0;
    out.y = y0;
    return out;
  }

  // Projectile did not move: overlap test above already decided the outcome.
  if (a <= 0) {
    out.hit = false;
    return out;
  }

  const b = 2 * (fx * dx + fy * dy);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    out.hit = false;
    return out;
  }

  const root = Math.sqrt(discriminant);
  // Smallest non-negative root = first contact.
  const t = (-b - root) / (2 * a);
  if (t < 0 || t > 1) {
    out.hit = false;
    return out;
  }

  out.hit = true;
  out.t = t;
  out.x = x0 + dx * t;
  out.y = y0 + dy * t;
  return out;
}

const mutableSweep: SweepHit = { hit: false, t: 0, x: 0, y: 0 };

/** Swept circle-vs-rect using the slab method against the rect's inflated bounds. */
export function sweepSegmentRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rect: Rect,
  radius: number,
): SweepHit {
  const minX = rect.x - radius;
  const maxX = rect.x + rect.width + radius;
  const minY = rect.y - radius;
  const maxY = rect.y + rect.height + radius;

  // Trivial accept/reject on the segment's own bounding box first.
  const segMinX = Math.min(x0, x1);
  const segMaxX = Math.max(x0, x1);
  const segMinY = Math.min(y0, y1);
  const segMaxY = Math.max(y0, y1);
  if (segMaxX < minX || segMinX > maxX || segMaxY < minY || segMinY > maxY) {
    return NO_HIT;
  }

  const dx = x1 - x0;
  const dy = y1 - y0;
  let tMin = 0;
  let tMax = 1;

  if (Math.abs(dx) < 1e-9) {
    if (x0 < minX || x0 > maxX) return NO_HIT;
  } else {
    let t1 = (minX - x0) / dx;
    let t2 = (maxX - x0) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return NO_HIT;
  }

  if (Math.abs(dy) < 1e-9) {
    if (y0 < minY || y0 > maxY) return NO_HIT;
  } else {
    let t1 = (minY - y0) / dy;
    let t2 = (maxY - y0) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return NO_HIT;
  }

  mutableSweep.hit = true;
  mutableSweep.t = tMin;
  mutableSweep.x = x0 + dx * tMin;
  mutableSweep.y = y0 + dy * tMin;
  return mutableSweep;
}

/** Discrete circle-vs-circle overlap. Used for ship-vs-ship and contact damage. */
export function circlesOverlap(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): boolean {
  const combined = ar + br;
  return distanceSquared(ax, ay, bx, by) <= combined * combined;
}

/** True when a circle overlaps any of the rects (island collision). */
export function circleOverlapsAnyRect(
  cx: number,
  cy: number,
  radius: number,
  rects: readonly Rect[],
): boolean {
  const radiusSq = radius * radius;
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i];
    if (rect === undefined) continue;
    if (pointRectDistanceSquared(rect, cx, cy) < radiusSq) return true;
  }
  return false;
}

/** Accumulates the push-out needed to free a circle from all overlapping rects. */
export function resolveCircleAgainstRects(
  cx: number,
  cy: number,
  radius: number,
  rects: readonly Rect[],
  out: MutableVec2 = { x: 0, y: 0 },
): MutableVec2 {
  let totalX = 0;
  let totalY = 0;

  for (let pass = 0; pass < 2; pass += 1) {
    let moved = false;
    for (let i = 0; i < rects.length; i += 1) {
      const rect = rects[i];
      if (rect === undefined) continue;
      const push = circleRectPushOut(rect, cx + totalX, cy + totalY, radius);
      if (push.x !== 0 || push.y !== 0) {
        totalX += push.x;
        totalY += push.y;
        moved = true;
      }
    }
    if (!moved) break;
  }

  out.x = totalX;
  out.y = totalY;
  return out;
}
