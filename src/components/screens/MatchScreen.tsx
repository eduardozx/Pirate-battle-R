import { useCallback, useEffect, useRef, useState } from 'react';

import { GameCanvas } from '../GameCanvas';
import { Hud } from '../hud/Hud';
import { PauseOverlay } from '../hud/PauseOverlay';
import { LoadingScreen } from './LoadingScreen';
import { useTextureRegistry } from '../useTextureRegistry';

import { GameSession } from '../../game/core/gameSession';
import type { EndReason, PauseReason } from '../../game/core/types';
import type { GameConfig } from '../../game/config/gameConfig';
import { HudStore } from '../../store/hudStore';
import { createSeed } from '../../game/core/rng';
import { buildMatchSubmission, submitCompletedMatch } from '../../services/outbox/submitMatchOutcome';
import type { GameOptions } from '../../store/optionsStore';

/**
 * The combat screen.
 *
 * It owns THREE lifetimes and keeps them strictly separate — this is where the
 * architecture either pays off or leaks:
 *
 *   • ASSETS   — loaded once, outlive every session (see useTextureRegistry).
 *   • SESSION  — exactly one per match; destroyed on unmount AND on restart.
 *   • HUD STORE— a plain object; survives everything, holds only coarse state.
 *
 * Automatic pause on focus loss / tab hide lives here because it is a browser
 * concern, not a rule-engine concern.
 */

export interface MatchScreenProps {
  readonly config: GameConfig;
  readonly options: GameOptions;
  readonly onCompleted: (result: MatchResult) => void;
  readonly onAbandoned: () => void;
  readonly showTouchControls: boolean;
}

export interface MatchResult {
  readonly matchId: string;
  readonly score: number;
  readonly durationMs: number;
  readonly endReason: EndReason;
  readonly finishedAtIso: string;
  readonly seed: number;
}

export function MatchScreen({
  config,
  options,
  onCompleted,
  onAbandoned,
  showTouchControls,
}: MatchScreenProps): JSX.Element {
  const { registry, progress, error, retry } = useTextureRegistry();

  /**
   * `matchId` is generated ONCE per match, before the match starts.
   *
   * Generating it at submission time would mean a refresh between the end of a
   * match and its submission yields a second id — and therefore a second ranking
   * entry. Holding it from the start is what makes every attempt to record this
   * match idempotent, which the brief requires.
   *
   * A lazy `useState` initialiser rather than a ref written during render: the
   * initialiser runs once per mount and React keeps its value even if it throws
   * the render away, which is the guarantee the ref was reaching for — without
   * mutating anything while rendering.
   */
  const [matchId] = useState(
    () =>
      globalThis.crypto?.randomUUID?.() ??
      `match-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const [seed] = useState(() => createSeed());

  /* The HUD store is the mutable singleton the session writes to every frame.
     Created once per mount for the same reason as the ids above. */
  const [hudStore] = useState(
    () =>
      new HudStore({
        remainingSeconds: config.match.durationSeconds,
        health: config.player.maxHealth,
        maxHealth: config.player.maxHealth,
      }),
  );

  const sessionRef = useRef<GameSession | null>(null);
  const [session, setSession] = useState<GameSession | null>(null);
  const [paused, setPaused] = useState(false);
  const [pauseReason, setPauseReason] = useState<PauseReason>(null);

  /** Replaces the current session with a clean one. Never mutates in place. */
  const recreateSession = useCallback(() => {
    const previous = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    previous?.destroy();

    const created = GameSession.create({
      config,
      onMatchEnd: (reason, score, durationMs) => {
        const finishedAtIso = new Date().toISOString();

        /**
         * A completed match is recorded exactly once. `submitCompletedMatch`
         * enqueues synchronously and returns without awaiting the network, so the
         * player can hit "Play Again" immediately even with no connectivity.
         */
        submitCompletedMatch(
          buildMatchSubmission({
            matchId,
            score,
            effectiveDurationMs: durationMs,
            endReason: reason,
            finishedAtIso,
            seed,
            config,
            options,
          }),
        );

        onCompleted({ matchId, score, durationMs, endReason: reason, finishedAtIso, seed });
      },
    });
    sessionRef.current = created;
    setSession(created);
    setPaused(false);
    setPauseReason(null);
    return created;
  }, [config, options, onCompleted, matchId, seed]);

  /**
   * Abandoning never submits. A match the player walked away from is not a
   * completed match and must not appear in the ranking or history.
   */
  const handleAbandon = useCallback(() => {
    onAbandoned();
  }, [onAbandoned]);

  // One session per config. Cleanup destroys it — no leaked WebGL context.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the engine is created here and destroyed by this cleanup; React has to hold it
    recreateSession();
    return () => {
      const current = sessionRef.current;
      sessionRef.current = null;
      current?.destroy();
    };
  }, [recreateSession]);

  // Mirror the engine's pause state into React (the engine may pause itself).
  useEffect(() => {
    const current = sessionRef.current;
    if (current === null) return;

    return current.subscribeHud((next) => {
      const isPaused = next.phase === 'paused';
      setPaused((was) => (was === isPaused ? was : isPaused));
      setPauseReason((was) => (was === next.pauseReason ? was : next.pauseReason));
    });
  }, [session]);

  /* --------------------------------------------------- automatic pause */

  useEffect(() => {
    const autoPause = (reason: PauseReason): void => {
      const current = sessionRef.current;
      if (current === null) return;
      if (current.world.matchPhase !== 'running') return;
      current.pause(reason);
      // Release every held control so nothing leaks into the resumed match.
      current.input.releaseAll();
    };

    const onBlur = (): void => autoPause('focus-lost');
    const onVisibility = (): void => {
      if (document.hidden) autoPause('hidden-tab');
    };

    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  /* ------------------------------------------------------------- actions */

  /**
   * Toggle pause.
   *
   * The engine is the single source of truth: it decides the new phase and the
   * subscription below mirrors it into React. Flipping React state here as well
   * would be a second, competing source — and the two can disagree, because the
   * engine also pauses itself on focus loss.
   */
  const handlePauseToggle = useCallback(() => {
    sessionRef.current?.togglePause();
  }, []);

  const handleResume = useCallback(() => {
    sessionRef.current?.resume();
  }, []);

  /**
   * Keyboard pause: `P` or `Escape` while the match owns the screen.
   *
   * The pause BUTTON is not enough — a keyboard-only player must be able to stop
   * the match without a pointing device, and the menu advertises this binding, so
   * it has to exist. The engine decides the transition (`togglePause`), which
   * keeps the HUD button, the keyboard and the automatic focus-loss pause all
   * going through one path.
   *
   * `Escape` is shared with the overlay's own dismiss handler. The two cannot
   * fight: one asks for a toggle, the other only ever calls `resume`, and both
   * are idempotent for the phase they end up in.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) return;
      if (event.key === 'Escape' || event.code === 'KeyP') {
        sessionRef.current?.togglePause();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleRestart = useCallback(() => {
    recreateSession();
  }, [recreateSession]);

  /* --------------------------------------------------------------- render */

  if (error !== null || registry === null) {
    return <LoadingScreen progress={progress} error={error} onRetry={retry} />;
  }

  return (
    <div className="screen screen--match" data-testid="match-screen">
      {session !== null && (
        <GameCanvas
          session={session}
          hudStore={hudStore}
          config={config}
          paused={paused}
          registry={registry}
        />
      )}

      <Hud
        hudStore={hudStore}
        input={session?.input ?? null}
        onPause={handlePauseToggle}
        showTouchControls={showTouchControls}
      />

      <PauseOverlay reason={paused ? (pauseReason ?? 'manual') : null} onResume={handleResume} />

      <div className="match-footer">
        <button
          type="button"
          className="button button--ghost"
          onClick={handleRestart}
          data-testid="restart-button"
        >
          Restart
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={handleAbandon}
          data-testid="abandon-button"
        >
          Abandon match
        </button>
      </div>
    </div>
  );
}
