/**
 * Seeded, allocation-free PRNG (mulberry32).
 *
 * Every non-deterministic decision in the game (spawn placement, AI noise,
 * sprite variant choice, effect jitter) draws from here, so a given seed always
 * produces the same match — a hard requirement for reproducible E2E tests.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // 0 is a fixed point of mulberry32; nudge it away.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  angle(): number {
    return this.next() * Math.PI * 2;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty collection');
    return items[this.int(items.length)] as T;
  }

  /** Picks an index from a weight table. Weights need not be normalised. */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let roll = this.next() * total;
    for (let i = 0; i < weights.length; i += 1) {
      roll -= weights[i] as number;
      if (roll <= 0) return i;
    }
    return weights.length - 1;
  }

  /** Derives an independent stream — keeps one subsystem's draws from shifting another's. */
  fork(salt: number): Rng {
    return new Rng(Math.imul(this.state ^ (salt >>> 0), 0x85ebca6b));
  }
}

export const createSeed = (): number => (Math.random() * 0xffffffff) >>> 0;
