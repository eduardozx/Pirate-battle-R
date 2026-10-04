import { useEffect, useRef, type ReactNode } from 'react';

import type { MatchResult } from './MatchScreen';
import { useFocusTrap } from '../useFocusTrap';
import { SUBMISSION_COPY, type SubmissionStatus } from '../../services/api/contracts';
import { useSubmissionStatus, useSubmitMatchesMutation } from '../../services/data/queries';
import { outbox } from '../../services/outbox/outboxStore';

/**
 * Post-match result.
 *
 * The submission status is read LIVE from the outbox, not from a local flag, so
 * the screen cannot disagree with the queue about whether a match was recorded.
 *
 * "Play Again" is always available, including while a submission is pending: the
 * brief requires that a pending record never blocks the player.
 *
 * It is a MODAL in the accessibility sense: it owns focus while it is on screen
 * and hands it back when it closes, so a keyboard player is never dropped behind
 * a dialog they cannot see.
 */

export interface ResultScreenProps {
  readonly result: MatchResult;
  readonly onPlayAgain: () => void;
  readonly onMainMenu: () => void;
}

const formatDuration = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
};

const END_REASON_COPY: Record<MatchResult['endReason'], string> = {
  time_expired: 'Time expired',
  player_destroyed: 'Ship destroyed',
};

/** Maps the outbox item's state onto the status vocabulary shown to the player. */
const toSubmissionStatus = (matchId: string): SubmissionStatus => {
  const item = outbox.find(matchId);
  if (item === undefined) return 'idle';
  if (item.status === 'confirmed') return item.recovered ? 'recovered_duplicate' : 'confirmed';
  if (item.attempts > 0) return 'retrying';
  return 'queued';
};

export function ResultScreen({ result, onPlayAgain, onMainMenu }: ResultScreenProps): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Subscribed so the row updates when the outbox confirms or retries.
  const { message } = useSubmissionStatus(result.matchId);
  const status = toSubmissionStatus(result.matchId);

  // Registration runs as a TanStack mutation, so the screen can drive it and the
  // record tabs are invalidated the moment it settles.
  const { mutate: register } = useSubmitMatchesMutation();

  // Focus the dialog itself so a screen reader announces the outcome, and keep
  // Tab inside it while it is on screen.
  useFocusTrap(panelRef);

  // Kick a delivery attempt: if the match ended while offline, this recovers it
  // as soon as the network returns.
  useEffect(() => {
    register();
  }, [register]);

  return (
    <div className="screen screen--center" data-testid="result-screen">
      <div
        ref={panelRef}
        className="panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="result-title"
        tabIndex={-1}
      >
        <h1 className="panel__title" id="result-title">
          {END_REASON_COPY[result.endReason]}
        </h1>

        <dl className="result__stats">
          <div className="result__row">
            <dt>Score</dt>
            <dd data-testid="result-score">{result.score}</dd>
          </div>
          <div className="result__row">
            <dt>Time played</dt>
            <dd data-testid="result-duration">{formatDuration(result.durationMs)}</dd>
          </div>
          <div className="result__row">
            <dt>End reason</dt>
            <dd data-testid="result-reason">{END_REASON_COPY[result.endReason]}</dd>
          </div>
          <div className="result__row">
            <dt>Match record</dt>
            <dd data-testid="result-submission" data-status={status}>
              {SUBMISSION_COPY[status]}
            </dd>
          </div>
        </dl>

        {message !== null && status !== 'confirmed' && (
          <p className="result__note" role="status" data-testid="result-submission-note">
            Last attempt: {message}
          </p>
        )}

        <div className="panel__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={onPlayAgain}
            data-testid="play-again-button"
          >
            Play Again
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={onMainMenu}
            data-testid="main-menu-button"
          >
            Main Menu
          </button>
        </div>

        {status === 'retrying' && (
          <button
            type="button"
            className="button button--ghost result__retry"
            onClick={() => register()}
            data-testid="result-retry"
          >
            Retry submission now
          </button>
        )}
      </div>
    </div>
  );
}
