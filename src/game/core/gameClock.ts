/**
 * Match clock.
 *
 * The timer advances ONLY from simulated substeps, never from wall-clock time.
 * That is what guarantees a paused match, a backgrounded tab or a throttled
 * ticker cannot consume the player's remaining seconds.
 */
export class MatchClock {
  private elapsedMs = 0;

  constructor(private readonly durationMs: number) {}

  /** Advances by one simulation substep. */
  advance(dtSeconds: number): void {
    this.elapsedMs = Math.min(this.durationMs, this.elapsedMs + dtSeconds * 1000);
  }

  get elapsedMsTotal(): number {
    return this.elapsedMs;
  }

  get remainingMs(): number {
    return Math.max(0, this.durationMs - this.elapsedMs);
  }

  get remainingSeconds(): number {
    return Math.ceil(this.remainingMs / 1000);
  }

  get elapsedRatio(): number {
    return this.durationMs <= 0 ? 1 : this.elapsedMs / this.durationMs;
  }

  get isExpired(): boolean {
    return this.elapsedMs >= this.durationMs;
  }

  reset(): void {
    this.elapsedMs = 0;
  }
}
