import { useCallback, useMemo } from 'react';

import { useHud, type HudStore } from '../../store/hudStore';
import type { ActionKey } from '../../game/input/inputController';

/**
 * HUD: health, score and remaining time.
 *
 * Reads coarse state from the external store — it re-renders when the score
 * changes or when the clock ticks over a second, NOT 60 times per second.
 *
 * Two accessibility affordances:
 *   • A `role="status"` region exposes the values as text.
 *   • A separate polite live region announces at most once every few seconds,
 *     because announcing every frame is actively hostile to a screen-reader user.
 */

interface HudProps {
  readonly hudStore: HudStore;
  readonly input: { setVirtual: (action: ActionKey, active: boolean) => void } | null;
  readonly onPause: () => void;
  readonly showTouchControls: boolean;
}

const formatTime = (seconds: number): string => {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
};

export function Hud({
  hudStore,
  input,
  onPause,
  showTouchControls,
}: HudProps): JSX.Element {
  const hud = useHud(hudStore);
  const healthRatio = hud.maxHealth === 0 ? 0 : hud.health / hud.maxHealth;

  // Announced on a coarse cadence: 5 s buckets, plus terminal states.
  const timeBucket = Math.floor(hud.remainingSeconds / 5);
  const announcement = useMemo(
    () => `Score ${hud.score}. Time ${hud.remainingSeconds} seconds. Health ${hud.health}.`,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bucketed on purpose
    [timeBucket, hud.score, hud.health],
  );

  const hold = useCallback(
    (action: ActionKey) => ({
      onPointerDown: (event: React.PointerEvent) => {
        event.preventDefault();
        input?.setVirtual(action, true);
      },
      onPointerUp: (event: React.PointerEvent) => {
        event.preventDefault();
        input?.setVirtual(action, false);
      },
      onPointerLeave: () => input?.setVirtual(action, false),
      onPointerCancel: () => input?.setVirtual(action, false),
    }),
    [input],
  );

  const forward = hold('forward');
  const turnLeft = hold('turnLeft');
  const turnRight = hold('turnRight');
  const fireFront = hold('fireFront');
  const fireLeft = hold('fireLeft');
  const fireRight = hold('fireRight');

  return (
    <div className="hud" data-testid="hud">
      <div className="hud__top">
        <div className="hud__stat" data-testid="hud-timer">
          <span className="hud__label">Time</span>
          <span className="hud__value hud__value--time">{formatTime(hud.remainingSeconds)}</span>
        </div>

        <div className="hud__stat" data-testid="hud-score">
          <span className="hud__label">Score</span>
          <span className="hud__value hud__value--score">{hud.score}</span>
        </div>

        <button
          type="button"
          className="hud__pause-button"
          onClick={onPause}
          aria-label="Pause match"
          data-testid="pause-button"
        >
          ❚❚
        </button>
      </div>

      <div className="hud__health" data-testid="hud-health">
        <div className="hud__health-track">
          <div
            className="hud__health-fill"
            style={{
              width: `${Math.max(0, Math.min(100, healthRatio * 100))}%`,
            }}
          />
        </div>
        <span className="hud__health-text">
          {hud.health} / {hud.maxHealth}
        </span>
      </div>

      {/* Active power-up. Rendered only while one is running, so the HUD stays
          quiet for the rest of the match. */}
      {hud.activePowerUp !== null && (
        <div className="hud__powerup" data-testid="hud-powerup" role="status">
          <span className="hud__powerup-label">{hud.activePowerUp}</span>
          <span className="hud__powerup-timer">
            {Math.ceil(hud.activePowerUpRemainingMs / 1000)}s
          </span>
          {hud.shieldRemaining > 0 && (
            <span className="hud__shield" data-testid="hud-shield">
              shield {Math.round(hud.shieldRemaining)}
            </span>
          )}
        </div>
      )}

      {/* Throttled announcements for assistive technology. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {showTouchControls && (
        <div className="touch-controls" data-testid="touch-controls">
          <div className="touch-controls__group touch-controls__group--left">
            <button type="button" className="touch-button" aria-label="Fire left broadside" {...fireLeft}>
              ◀︎
            </button>
            <button type="button" className="touch-button" aria-label="Turn left" {...turnLeft}>
              ⟲
            </button>
          </div>

          <div className="touch-controls__group touch-controls__group--center">
            <button
              type="button"
              className="touch-button touch-button--primary"
              aria-label="Fire forward cannon"
              {...fireFront}
            >
              ✦
            </button>
          </div>

          <div className="touch-controls__group touch-controls__group--right">
            <button type="button" className="touch-button" aria-label="Turn right" {...turnRight}>
              ⟳
            </button>
            <button
              type="button"
              className="touch-button"
              aria-label="Fire right broadside"
              {...fireRight}
            >
              ▶︎
            </button>
          </div>

          <button
            type="button"
            className="touch-button touch-button--sail"
            aria-label="Sail forward"
            {...forward}
          >
            ▲
          </button>
        </div>
      )}
    </div>
  );
}
