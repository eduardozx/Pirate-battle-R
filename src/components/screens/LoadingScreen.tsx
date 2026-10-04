import type { LoadProgress } from '../../game/assets/textureRegistry';

/**
 * Loading screen with a real progress bar, plus the error state with retry.
 *
 * The spec requires asset failures to be handled *before* combat can start and
 * to offer a way back, so both states are first-class rather than a console log.
 */

export interface LoadingScreenProps {
  readonly progress: LoadProgress;
  readonly error: string | null;
  readonly onRetry: () => void;
}

export function LoadingScreen({ progress, error, onRetry }: LoadingScreenProps): JSX.Element {
  const percent = Math.round(Math.min(1, Math.max(0, progress.ratio)) * 100);

  return (
    <div className="screen screen--center" data-testid="loading-screen">
      <div className="panel">
        {error === null ? (
          <>
            <h1 className="panel__title">Pirate Battle</h1>
            <p className="panel__text">Loading ships, islands and effects…</p>
            <div
              className="progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label="Asset loading progress"
            >
              <div className="progress__fill" style={{ width: `${percent}%` }} />
            </div>
            <p className="panel__text panel__text--muted">
              {progress.loaded} / {progress.total} textures ({percent}%)
            </p>
          </>
        ) : (
          <>
            <h1 className="panel__title">Could not load game assets</h1>
            {/* role="alert" so the failure is announced, not merely displayed. */}
            <p className="panel__error" role="alert" data-testid="asset-error">
              {error}
            </p>
            <div className="panel__actions">
              <button
                type="button"
                className="button button--primary"
                onClick={onRetry}
                data-testid="asset-retry"
              >
                Retry
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
