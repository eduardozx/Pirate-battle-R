/**
 * Seeded PRNG for the mock layer.
 *
 * Duplicated from the game's `Rng` on purpose: the mock server must not share a
 * stream with the simulation, or a gameplay roll would shift the network's
 * latency draws and destroy reproducibility in both directions.
 */
export const mulberry32 = (seed: number): (() => number) => {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
