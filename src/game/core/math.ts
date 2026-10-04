import type { Rect, Vec2 } from './types';

/** 2π — named to avoid magic numbers scattered through the systems. */
export const TAU = Math.PI * 2;

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Shortest signed angular difference, in radians, wrapped to (-π, π]. */
export function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta <= -Math.PI) delta += TAU;
  return delta;
}

/**
 * Frame-rate independent exponential smoothing.
 * `rate` is the fraction of the remaining distance covered per second (0..1).
 */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  target + (current - target) * Math.exp(-rate * dt);

export const distance = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(bx - ax, by - ay);

export const distanceSquared = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
};

/** Rotates a local-space offset (ship space: +X = bow) into world space. */
export function rotate(localX: number, localY: number, angle: number): Vec2 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: localX * cos - localY * sin, y: localX * sin + localY * cos };
}

export const rectContains = (rect: Rect, x: number, y: number): boolean =>
  x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;

/**
 * Squared distance from a point to the closest point of a rect. 0 when inside.
 * Used for circle-vs-AABB resolution — no allocation, no trigonometry.
 */
export function pointRectDistanceSquared(rect: Rect, px: number, py: number): number {
  const closestX = clamp(px, rect.x, rect.x + rect.width);
  const closestY = clamp(py, rect.y, rect.y + rect.height);
  return distanceSquared(px, py, closestX, closestY);
}

/** Shortest push-out vector that moves a circle out of a rect. Zero-length when free. */
export function circleRectPushOut(rect: Rect, cx: number, cy: number, radius: number): Vec2 {
  const closestX = clamp(cx, rect.x, rect.x + rect.width);
  const closestY = clamp(cy, rect.y, rect.y + rect.height);
  const dx = cx - closestX;
  const dy = cy - closestY;
  const distSq = dx * dx + dy * dy;

  // Deep inside the rect: push out along the shallowest axis.
  if (distSq === 0) {
    const left = cx - rect.x;
    const right = rect.x + rect.width - cx;
    const top = cy - rect.y;
    const bottom = rect.y + rect.height - cy;
    const min = Math.min(left, right, top, bottom);
    if (min === left) return { x: -(left + radius), y: 0 };
    if (min === right) return { x: right + radius, y: 0 };
    if (min === top) return { x: 0, y: -(top + radius) };
    return { x: 0, y: bottom + radius };
  }

  const dist = Math.sqrt(distSq);
  const penetration = radius - dist;
  if (penetration <= 0) return { x: 0, y: 0 };
  const scale = penetration / dist;
  return { x: dx * scale, y: dy * scale };
}

export const degreesToRadians = (deg: number): number => (deg * Math.PI) / 180;
