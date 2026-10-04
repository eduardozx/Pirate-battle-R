/** Largest slice of a frame the simulation will ever consume (ms). */
export const DEFAULT_MAX_FRAME_MS = 100;
/** Fixed upper bound on integration size — keeps collision maths stable. */
export const DEFAULT_MAX_SUBSTEP_MS = 1000 / 120;
/**
 * Safety valve against a stalled tab spiralling into thousands of substeps.
 *
 * This MUST be large enough to consume the whole clamped frame, otherwise the
 * leftover is silently discarded and the match clock runs slow on weak hardware.
 * 16 × 8.33 ms = 133 ms comfortably exceeds the 100 ms clamp, with headroom.
 */
export const DEFAULT_MAX_SUBSTEPS = 16;

export interface GameLoopOptions {
  readonly maxFrameMs: number;
  readonly maxSubstepMs: number;
  readonly maxSubstepsPerFrame: number;
  readonly onSubstep: (dtSeconds: number) => void;
}

/**
 * Converts variable frame deltas into fixed-size integration steps.
 *
 * WHY NOT A PLAIN `dt`? Movement and damage must be identical at 30, 60 or
 * 144 fps — that is the whole point of time-based simulation.
 *
 * WHY NOT A STRICT ACCUMULATOR? It adds up to a full step of input latency and
 * fights the render cadence. Sub-stepping gives both: bounded integration error
 * and zero added latency.
 *
 * NOTE ON OWNERSHIP: the loop does not own a ticker. Something else (the Pixi
 * ticker in the app, a test harness in CI) pumps `advance()`. That keeps the
 * rule engine unaware of rendering and makes headless testing trivial.
 */
export class GameLoop {
  private running = false;
  private readonly options: GameLoopOptions;
  /**
   * Leftover time carried into the next frame, in ms.
   *
   * This is what makes the simulation genuinely frame-rate independent rather
   * than merely close. Without it, a 6.94 ms frame at 144 fps integrates as one
   * short step while a 33.3 ms frame at 30 fps integrates as four long ones, and
   * the differing partitions make an exponential term such as acceleration drift
   * apart. Carrying the remainder pins every substep boundary to an absolute
   * grid, so the same input sequence produces the same trajectory at any refresh
   * rate — and, critically for E2E, the same trajectory on any machine.
   */
  private carryMs = 0;
  /** Total substeps executed since the last reset. Instrumentation for tests. */
  private substepCount = 0;

  constructor(options: Partial<GameLoopOptions> & Pick<GameLoopOptions, 'onSubstep'>) {
    this.options = {
      maxFrameMs: DEFAULT_MAX_FRAME_MS,
      maxSubstepMs: DEFAULT_MAX_SUBSTEP_MS,
      maxSubstepsPerFrame: DEFAULT_MAX_SUBSTEPS,
      ...options,
    };
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Discards carried time. Call when the match is restarted or resumed. */
  resetCarry(): void {
    this.carryMs = 0;
  }

  /**
   * Substeps executed since the last reset.
   *
   * Exposed so the deterministic test harness can stop at an exact simulated
   * instant. Stopping on wall-clock time instead lands on different substep counts
   * at different refresh rates, which silently compares unequal durations.
   */
  get executedSubsteps(): number {
    return this.substepCount;
  }

  resetSubstepCount(): void {
    this.substepCount = 0;
  }

  /**
   * Advances the simulation by one frame's worth of time.
   * Public so tests can drive time deterministically without any renderer.
   */
  advance = (rawDeltaMs: number): void => {
    if (!this.running) return;

    // Clamp: after a tab has been hidden the browser hands us a huge delta.
    const frameMs = Math.min(Math.max(rawDeltaMs, 0), this.options.maxFrameMs);
    this.carryMs += frameMs;

    let steps = 0;
    while (this.carryMs >= this.options.maxSubstepMs && steps < this.options.maxSubstepsPerFrame) {
      this.carryMs -= this.options.maxSubstepMs;
      this.substepCount += 1;
      this.options.onSubstep(this.options.maxSubstepMs / 1000);
      steps += 1;
    }

    // Hit the substep ceiling: drop the backlog rather than spiral. Reaching this
    // means the frame budget is already ~13 ms behind; catching up would only
    // make the next frame worse.
    if (this.carryMs > this.options.maxSubstepMs) {
      this.carryMs = 0;
    }
  };
}
