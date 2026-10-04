/**
 * ============================================================================
 *  FRAME PROFILER
 * ============================================================================
 *
 * Measures where a frame goes, in the only place that can measure it honestly:
 * around the work itself, inside the frame callback.
 *
 * WHY A RING BUFFER. This runs once per frame, so its own cost is part of what it
 * measures. Samples land in a preallocated `Float32Array` and the write pointer
 * advances — no push, no object allocation, no growth. A profiler that allocated
 * would be measuring its own garbage collection.
 *
 * WHY PERCENTILES, NOT AN AVERAGE. An average frame time hides exactly the frames
 * a player notices. A run can average a healthy 4 ms while p99 sits at 40 ms, and
 * the player experiences that 40 ms as a stutter. The tail is the number that
 * matters, so the summary reports p50/p95/p99 and the worst frame observed.
 *
 * WHY SIMULATION AND RENDER ARE SEPARATE. They have different costs, different
 * scaling behaviour and different fixes. One combined number cannot tell you
 * whether to optimise collision or draw calls.
 *
 * WHY THE CALL SITE KEEeps ITS SHAPE. `measure()` returns the frame driver itself,
 * built once. When profiling is off, that driver contains no timestamps and no
 * branches beyond a single flag check — the cost of having instrumentation in the
 * product is effectively zero, which is what makes it acceptable to leave wired up.
 */

/** Samples retained. Two seconds at 60 fps, with room for hitches. */
const DEFAULT_CAPACITY = 240;

export interface PhaseMetrics {
  readonly count: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly worstMs: number;
}

export interface FrameSummary {
  readonly fps: number;
  readonly frames: number;
  readonly dropped: number;
  readonly simulation: PhaseMetrics;
  readonly render: PhaseMetrics;
  readonly frame: PhaseMetrics;
  /**
   * What those frames were carrying: the entity count of the last frame sampled,
   * and the highest seen inside the window.
   *
   * A frame p99 on its own is a claim without a subject. Three milliseconds with
   * a dozen hulls on screen and three with three hundred are statements about
   * different games, and only one of them is the one the performance document
   * means to make.
   */
  readonly entities: { readonly current: number; readonly peak: number };
}

const emptyMetrics = (): PhaseMetrics => ({
  count: 0,
  meanMs: 0,
  p50Ms: 0,
  p95Ms: 0,
  p99Ms: 0,
  worstMs: 0,
});

/** Nearest-rank percentile over an already-sorted view. */
const percentileOf = (sorted: Float32Array, fraction: number): number => {
  const length = sorted.length;
  if (length === 0) return 0;
  const rank = Math.ceil(fraction * length) - 1;
  return sorted[Math.min(Math.max(rank, 0), length - 1)] as number;
};

/**
 * Fixed-capacity sample window.
 *
 * Percentiles copy into a scratch buffer and sort. That allocation happens once
 * per read — never per frame — so the hot path stays clean while the numbers are
 * still correct for a rolling window.
 */
class SampleWindow {
  private readonly buffer: Float32Array;
  private readonly scratch: Float32Array;
  private count = 0;
  private write = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Float32Array(capacity);
    this.scratch = new Float32Array(capacity);
  }

  push(value: number): void {
    this.buffer[this.write] = value;
    this.write = (this.write + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
  }

  /** Samples currently held, never more than the window capacity. */
  get size(): number {
    return this.count;
  }

  clear(): void {
    this.count = 0;
    this.write = 0;
  }

  metrics(): PhaseMetrics {
    if (this.count === 0) return emptyMetrics();

    const { scratch } = this;
    let total = 0;
    let worst = 0;

    for (let i = 0; i < this.count; i += 1) {
      const value = this.buffer[i] as number;
      scratch[i] = value;
      total += value;
      if (value > worst) worst = value;
    }

    const view = scratch.subarray(0, this.count);
    view.sort();

    return {
      count: this.count,
      meanMs: total / this.count,
      p50Ms: percentileOf(view, 0.5),
      p95Ms: percentileOf(view, 0.95),
      p99Ms: percentileOf(view, 0.99),
      worstMs: worst,
    };
  }
}

/** Monotonic-ish clock, resolved once so it can be swapped in tests. */
export type Clock = () => number;

const systemClock: Clock = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export class FrameProfiler {
  private readonly simulationWindow: SampleWindow;
  private readonly renderWindow: SampleWindow;
  private readonly frameWindow: SampleWindow;

  private enabled = false;
  private elapsedMs = 0;
  private lastFrameEndMs = 0;

  /** Frames taking more than two budgets — dropped, by the usual definition. */
  private dropped = 0;

  /** Entity count of the last sampled frame, and of the busiest one seen. */
  private entitiesCurrent = 0;
  private entitiesPeak = 0;

  /**
   * @param budgetMs  frame budget, used only to classify dropped frames.
   * @param capacity  samples retained per phase.
   * @param clock     injectable so tests can drive time deterministically instead
   *                  of monkey-patching a global that the frame path also reads.
   */
  constructor(
    private readonly budgetMs = 1000 / 60,
    capacity = DEFAULT_CAPACITY,
    private readonly clock: Clock = systemClock,
  ) {
    this.simulationWindow = new SampleWindow(capacity);
    this.renderWindow = new SampleWindow(capacity);
    this.frameWindow = new SampleWindow(capacity);
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.reset();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  reset(): void {
    this.simulationWindow.clear();
    this.renderWindow.clear();
    this.frameWindow.clear();
    this.dropped = 0;
    this.elapsedMs = 0;
    this.lastFrameEndMs = 0;
    this.entitiesCurrent = 0;
    this.entitiesPeak = 0;
  }

  /**
   * Wraps a frame's work into a driver, returned once.
   *
   * Simulation and render are passed as separate callbacks because they must be
   * charged to separate budgets. Attributing render with "everything after the
   * substep" would silently bill simulation's cost to the GPU.
   *
   * @param entities  how many live entities the world holds. Sampled once per
   *                  frame so the timings can be quoted against the load that
   *                  produced them; never sampled while profiling is off, which
   *                  keeps the disabled path free of extra work.
   */
  measure(
    simulate: (deltaMs: number) => void,
    render: (deltaMs: number) => void,
    entities: () => number = () => 0,
  ): (deltaMs: number) => void {
    return (deltaMs: number): void => {
      if (!this.enabled) {
        simulate(deltaMs);
        render(deltaMs);
        return;
      }

      const frameStart = this.clock();

      simulate(deltaMs);
      const afterSimulation = this.clock();

      render(deltaMs);
      const frameEnd = this.clock();

      const live = entities();
      this.entitiesCurrent = live;
      if (live > this.entitiesPeak) this.entitiesPeak = live;

      this.simulationWindow.push(afterSimulation - frameStart);
      this.renderWindow.push(frameEnd - afterSimulation);
      this.frameWindow.push(frameEnd - frameStart);

      if (this.lastFrameEndMs !== 0) {
        const wallDelta = frameEnd - this.lastFrameEndMs;
        this.elapsedMs += wallDelta;
        if (wallDelta > this.budgetMs * 2) this.dropped += 1;
      }
      this.lastFrameEndMs = frameEnd;
    };
  }

  summary(): FrameSummary {
    const frames = this.frameWindow.size;
    const elapsedMs = this.elapsedMs > 0 ? this.elapsedMs : frames * this.budgetMs;

    return {
      fps: elapsedMs > 0 ? (frames / elapsedMs) * 1000 : 0,
      frames,
      dropped: this.dropped,
      simulation: this.simulationWindow.metrics(),
      render: this.renderWindow.metrics(),
      frame: this.frameWindow.metrics(),
      entities: { current: this.entitiesCurrent, peak: this.entitiesPeak },
    };
  }
}