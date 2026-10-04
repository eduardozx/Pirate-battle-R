import { DEFAULT_GAME_CONFIG, type GameConfig } from '../config/gameConfig';
import { GameWorld } from './gameWorld';
import { GameLoop } from './gameLoop';
import { Disposables } from './disposables';
import { InputController } from '../input/inputController';
import type { EndReason, MatchPhase, PauseReason } from './types';

/**
 * ============================================================================
 *  GAME SESSION — owns one match
 * ============================================================================
 *
 * The session is the ONLY object that knows about all three worlds at once:
 * the rule engine, the renderer and the input source. React talks to it through
 * a tiny imperative surface and receives coarse state changes back.
 *
 * Lifecycle guarantees:
 *   • `create()` never touches the DOM beyond the canvas it is handed.
 *   • `destroy()` is idempotent and releases every listener, timer and GPU
 *     resource the session created.
 *   • Nothing here survives the session: a restart builds a brand-new one.
 */

export interface HudState {
  readonly phase: MatchPhase;
  readonly pauseReason: PauseReason;
  readonly score: number;
  readonly remainingSeconds: number;
  readonly health: number;
  readonly maxHealth: number;
  readonly chasers: number;
  readonly shooters: number;
  readonly endReason: EndReason | null;
  /** Label of the active timed power-up, or null when none is running. */
  readonly activePowerUp: string | null;
  readonly activePowerUpRemainingMs: number;
  /** Remaining shield points, exposed so the HUD can show it depleting. */
  readonly shieldRemaining: number;
}

/** Coarse state only. Deliberately excludes anything that changes per frame. */
const EMPTY_HUD: HudState = {
  phase: 'booting',
  pauseReason: null,
  score: 0,
  remainingSeconds: DEFAULT_GAME_CONFIG.match.durationSeconds,
  health: DEFAULT_GAME_CONFIG.player.maxHealth,
  maxHealth: DEFAULT_GAME_CONFIG.player.maxHealth,
  chasers: 0,
  shooters: 0,
  endReason: null,
  activePowerUp: null,
  activePowerUpRemainingMs: 0,
  shieldRemaining: 0,
};

export type HudListener = (state: HudState) => void;

export interface GameSessionOptions {
  readonly config?: GameConfig;
  readonly seed?: number;
  /** Called whenever coarse HUD state changes. Never called per frame. */
  readonly onHudChange?: (state: HudState) => void;
  readonly onMatchEnd?: (reason: EndReason, score: number, durationMs: number) => void;
}

export class GameSession {
  readonly world: GameWorld;
  /** The session owns input: it is created, captured and released with the match. */
  readonly input: InputController;

  private readonly disposables = new Disposables();
  private readonly loop: GameLoop;
  private readonly listeners = new Set<HudListener>();

  private hud: HudState = EMPTY_HUD;
  private disposed = false;
  private readonly onMatchEnd?: (reason: EndReason, score: number, durationMs: number) => void;

  private constructor(config: GameConfig, options: GameSessionOptions) {
    this.world = new GameWorld(config, options.seed);
    this.onMatchEnd = options.onMatchEnd;
    this.input = new InputController();

    this.loop = new GameLoop({
      onSubstep: (dt) => this.substep(dt),
    });

    this.world.events.on('match:ended', ({ reason, score, durationMs }) => {
      this.publishHud(true);
      this.onMatchEnd?.(reason, score, durationMs);
    });

    this.world.events.on('enemy:killed', () => this.publishHud());
    this.world.events.on('player:damaged', () => this.publishHud());
    this.world.events.on('powerup:changed', () => this.publishHud());
    this.world.events.on('pause:changed', () => this.publishHud(true));
  }

  static create(options: GameSessionOptions = {}): GameSession {
    return new GameSession(options.config ?? DEFAULT_GAME_CONFIG, options);
  }

  /* ------------------------------------------------------------------ control */

  /**
   * Begins a fresh match.
   *
   * The session does NOT own a frame driver. Whoever renders (the Pixi ticker,
   * or a test harness) pumps `stepFrame` — which keeps the rule engine free of
   * any rendering dependency and lets tests advance time with no canvas at all.
   */
  start(): void {
    this.assertAlive();
    if (!this.inputAttached) {
      this.input.attach();
      this.inputAttached = true;
      this.disposables.add(() => {
        this.inputAttached = false;
      });
    }
    this.world.start();
    this.publishHud(true);
    this.loop.start();
  }

  private inputAttached = false;

  /** Restarts in place: new match, same session, no React involvement. */
  restart(): void {
    this.assertAlive();
    this.world.start();
    this.publishHud(true);
    if (!this.loop.isRunning) this.loop.start();
  }

  pause(reason: PauseReason): void {
    this.world.pause(reason);
    // Drop any partial substep so resuming starts from a clean boundary.
    this.settleClock();
  }

  resume(): void {
    this.world.resume();
    // The time spent paused must never be integrated. The ticker will hand us a
    // huge delta on the next frame; discarding the carry means the first frame
    // after resuming is small instead of a catch-up burst.
    this.settleClock();
  }

  togglePause(): void {
    if (this.world.matchPhase === 'running') this.pause('manual');
    else if (this.world.matchPhase === 'paused') this.resume();
  }

  /**
   * Advances one rendered frame: simulate (in substeps), then report state.
   *
   * This is the entry point the render driver calls. Splitting simulation from
   * rendering here guarantees they can never interleave wrongly.
   */
  stepFrame(deltaMs: number): void {
    if (!this.loop.isRunning) return;
    this.loop.advance(deltaMs);
    // Cheap and idempotent: catches phase changes made outside a substep.
    this.publishHud();
  }

  /**
   * True while the loop is permitted to consume time.
   *
   * Exposed so the caller can ask the simulation for a clean frame boundary:
   * resuming after a pause must not integrate the wall-clock time spent paused,
   * and restarting must not inherit a leftover substep remainder.
   */
  get acceptsTime(): boolean {
    return this.loop.isRunning && this.world.matchPhase === 'running';
  }

  /** Discards any carried substep remainder. Used on start, restart and resume. */
  settleClock(): void {
    this.loop.resetCarry();
  }

  /**
   * Runs the whole simulation forward in one go.
   *
   * Used by the deterministic E2E harness and by performance sampling: the real
   * rules, real collisions and real input state all run, but with no wall-clock
   * dependency and no renderer in the way.
   */
  advanceManually(totalMs: number): void {
    this.assertAlive();
    const wasRunning = this.loop.isRunning;
    if (!wasRunning) this.loop.start();
    this.loop.advance(totalMs);
    if (!wasRunning) this.loop.stop();
  }

  /** Enables keyboard capture. Off while a menu owns the focus. */
  setInputCapture(enabled: boolean): void {
    this.input.setCaptureEnabled(enabled);
  }

  /* ----------------------------------------------------------------- private */

  private substep(dt: number): void {
    // Input is sampled per substep, so a press is consumed exactly once and can
    // never fire twice — including presses made during a pause.
    this.world.step(dt, this.input.sample());
    this.publishHud();
  }

  /* --------------------------------------------------------------------- hud */

  subscribeHud(listener: HudListener): () => void {
    this.listeners.add(listener);
    listener(this.hud);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get hudState(): HudState {
    return this.hud;
  }

  /**
   * Pushes coarse state to listeners ONLY when something a human could notice
   * changed. This is the mechanism that keeps React from re-rendering at 60 Hz:
   * a 90-second match publishes a few dozen updates instead of ~5 400.
   */
  private publishHud(force = false): void {
    const stats = this.world.readStats();
    const next: HudState = {
      phase: this.world.matchPhase,
      pauseReason: this.world.currentPauseReason,
      score: stats.score,
      remainingSeconds: Math.ceil(stats.remainingMs / 1000),
      health: Math.round(stats.playerHealth),
      maxHealth: stats.playerMaxHealth,
      chasers: this.world.enemyCounts.chasers,
      shooters: this.world.enemyCounts.shooters,
      endReason: this.world.matchEndReason,
      activePowerUp: this.world.activePowerUpLabel(this.world.simulationTimeMs),
      activePowerUpRemainingMs: this.world.powerUpSystem.effectRemainingMs(
        this.world.simulationTimeMs,
      ),
      shieldRemaining: this.world.powerUpSystem.shieldPoints(this.world.simulationTimeMs),
    };

    if (!force && isSameHud(this.hud, next)) return;
    this.world.markStatsClean();
    this.hud = next;

    for (const listener of this.listeners) listener(next);
  }

  /* -------------------------------------------------------------- lifecycle */

  get isDisposed(): boolean {
    return this.disposed;
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.loop.stop();
    this.world.events.clear();
    this.listeners.clear();
    this.disposables.dispose();
    this.input.dispose();
    this.world.store.clear();
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('GameSession has been destroyed');
  }
}

const isSameHud = (a: HudState, b: HudState): boolean =>
  a.phase === b.phase &&
  a.pauseReason === b.pauseReason &&
  a.score === b.score &&
  a.remainingSeconds === b.remainingSeconds &&
  a.health === b.health &&
  a.maxHealth === b.maxHealth &&
  a.chasers === b.chasers &&
  a.shooters === b.shooters &&
  a.endReason === b.endReason &&
  a.activePowerUp === b.activePowerUp &&
  a.activePowerUpRemainingMs === b.activePowerUpRemainingMs &&
  a.shieldRemaining === b.shieldRemaining;
