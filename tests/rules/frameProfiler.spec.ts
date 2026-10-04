import { describe, expect, it } from 'vitest';

import { FrameProfiler } from '../../src/game/core/frameProfiler';

/**
 * Profiler tests.
 *
 * The percentile maths is the part worth pinning down: an off-by-one in
 * `nearest-rank` is invisible in a screenshot and produces a number that is
 * quietly wrong in a performance document, which is worse than no number at all.
 *
 * Time is INJECTED rather than measured. Asserting on real elapsed time would be
 * an assertion about the machine, not about the code.
 */

interface Harness {
  readonly profiler: FrameProfiler;
  /** Records one frame with the given phase costs. */
  frame: (simulationMs: number, renderMs: number) => void;
  /**
   * Injects idle time between frames.
   *
   * A dropped frame is not a slow frame: it shows up as a gap in wall-clock time
   * between two frames. The profiler reads the injected clock, so that gap is
   * expressed here — advancing some other clock would leave the profiler measuring
   * zero and the test asserting nothing.
   */
  idle: (ms: number) => void;
}

const harness = (budgetMs = 1000 / 60, capacity = 240): Harness => {
  let clock = 0;
  let pendingSimulation = 0;
  let pendingRender = 0;

  const profiler = new FrameProfiler(budgetMs, capacity, () => clock);
  profiler.setEnabled(true);

  const drive = profiler.measure(
    () => { clock += pendingSimulation; },
    () => { clock += pendingRender; },
  );

  return {
    profiler,
    idle: (ms) => { clock += ms; },
    frame: (simulationMs, renderMs) => {
      pendingSimulation = simulationMs;
      pendingRender = renderMs;
      drive(16);
    },
  };
};

describe('FrameProfiler', () => {
  it('runs the work in order and samples nothing while disabled', () => {
    const profiler = new FrameProfiler();
    const order: string[] = [];

    const drive = profiler.measure(
      () => order.push('simulate'),
      () => order.push('render'),
    );

    for (let i = 0; i < 10; i += 1) drive(16);

    expect(order).toHaveLength(20);
    expect(order[0]).toBe('simulate');
    expect(order[1]).toBe('render');

    const summary = profiler.summary();
    expect(summary.frames).toBe(0);
    expect(summary.simulation.count).toBe(0);
    expect(summary.render.count).toBe(0);
    // No sampler was passed and nothing was sampled: the disabled path carries
    // no world size either.
    expect(summary.entities).toEqual({ current: 0, peak: 0 });
  });

  it('charges simulation and render to separate budgets', () => {
    const { profiler, frame } = harness();

    for (let i = 0; i < 5; i += 1) frame(4, 2);

    const summary = profiler.summary();

    expect(summary.simulation.meanMs).toBeCloseTo(4, 6);
    expect(summary.render.meanMs).toBeCloseTo(2, 6);
    expect(summary.frame.meanMs).toBeCloseTo(6, 6);
    expect(summary.frame.count).toBe(5);
  });

  it('computes nearest-rank percentiles rather than interpolating', () => {
    const { profiler, frame } = harness();

    // Sample values 1..100 ms. Nearest rank gives p50 = 50, p95 = 95, p99 = 99.
    // Interpolation would report 50.5 / 95.05 / 99.01 — subtly wrong numbers in a
    // performance document, which is exactly the failure this guards against.
    for (let ms = 1; ms <= 100; ms += 1) frame(ms, 0);

    const { simulation } = profiler.summary();

    expect(simulation.count).toBe(100);
    expect(simulation.p50Ms).toBe(50);
    expect(simulation.p95Ms).toBe(95);
    expect(simulation.p99Ms).toBe(99);
    expect(simulation.worstMs).toBe(100);
    expect(simulation.meanMs).toBeCloseTo(50.5, 6);
  });

  it('surfaces a spike that an average would hide', () => {
    const { profiler, frame } = harness();

    for (let i = 0; i < 90; i += 1) frame(2, 0);

    const cheap = profiler.summary();
    expect(cheap.frame.meanMs).toBeCloseTo(2, 6);
    expect(cheap.frame.worstMs).toBeCloseTo(2, 6);

    profiler.reset();
    frame(50, 0);

    const spike = profiler.summary();
    expect(spike.frame.meanMs).toBeCloseTo(50, 6);
    expect(spike.frame.worstMs).toBeCloseTo(50, 6);
  });

  it('wraps a fixed-size window instead of growing', () => {
    const { profiler, frame } = harness(1000 / 60, 8);

    for (let i = 0; i < 100; i += 1) frame(1, 0);

    expect(profiler.summary().frames).toBe(8);
  });

  it('classifies a frame as dropped only past two budgets', () => {
    const budget = 1000 / 60;
    const { profiler, frame, idle } = harness(budget);

    const gaps = [8, 9, 40, 8, 120, 8];

    for (const gap of gaps) {
      frame(1, 0);
      idle(gap);
    }

    const { dropped, frames } = profiler.summary();

    expect(frames).toBe(gaps.length);
    /* Budget ≈ 16.67 ms, so the threshold is ≈ 33.3 ms: only the 40 ms and 120 ms
       gaps qualify. Getting this boundary wrong would report healthy machines as
       dropping half their frames. */
    expect(dropped).toBe(2);
  });

  it('reports frames per second from wall-clock elapsed time', () => {
    const budget = 1000 / 60;
    const { profiler, frame, idle } = harness(budget);

    /* 60 frames spaced 16.67 ms apart is one second of 60 fps. */
    for (let i = 0; i < 60; i += 1) {
      frame(1, 0);
      idle(budget);
    }

    const { fps } = profiler.summary();
    expect(fps).toBeGreaterThan(50);
    expect(fps).toBeLessThan(70);
  });

  it('clears every window on reset', () => {
    const { profiler, frame } = harness();

    frame(5, 1);
    expect(profiler.summary().frames).toBe(1);

    profiler.reset();

    const summary = profiler.summary();
    expect(summary.frames).toBe(0);
    expect(summary.dropped).toBe(0);
    expect(summary.frame.worstMs).toBe(0);
    expect(summary.simulation.count).toBe(0);
  });

  it('starts a fresh window when re-enabled', () => {
    const { profiler, frame } = harness();

    frame(4, 2);
    expect(profiler.summary().frames).toBe(1);

    profiler.setEnabled(false);
    profiler.setEnabled(true);

    expect(profiler.summary().frames).toBe(0);
  });

  it('reports the entity count the frames were carrying', () => {
    let clock = 0;
    let entities = 0;

    const profiler = new FrameProfiler(1000 / 60, 240, () => clock);
    profiler.setEnabled(true);

    const drive = profiler.measure(
      () => {
        clock += 4;
      },
      () => {
        clock += 2;
      },
      () => entities,
    );

    entities = 12;
    drive(16);
    entities = 90;
    drive(16);
    entities = 30;
    drive(16);

    /* Peak is the number to quote beside a frame p99 — the busiest world the
       window saw — while `current` is what the last frame actually drew. A
       window that only kept the mean would hide the spike the report exists for. */
    expect(profiler.summary().entities).toEqual({ current: 30, peak: 90 });

    /* Reset forgets the window it measured, entities included. */
    profiler.reset();
    expect(profiler.summary().entities).toEqual({ current: 0, peak: 0 });
  });
});