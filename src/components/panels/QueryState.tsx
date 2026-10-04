import type { ReactNode } from 'react';

import { toApiFailure } from '../../services/api/httpClient';

/**
 * The four states every remote panel must render, plus one refinement.
 *
 * REFINEMENT — stale data with a failed refresh is NOT the same as a hard error.
 * A background revalidation that fails while cached rows are already on screen
 * should NOT blank the table: the player keeps reading valid data and is told the
 * refresh failed. Replacing good data with an error panel is a regression in
 * behaviour disguised as error handling.
 *
 * So:
 *   • error with NO data      → full error panel with Retry
 *   • error WITH cached data  → the data, plus a dismissible warning strip
 *
 * The brief requires loading, empty and error to all be reachable; this keeps all
 * three reachable without sacrificing usable data.
 */

export interface QueryStateProps {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly isEmpty: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly emptyMessage: string;
  readonly children: ReactNode;
}

export function QueryState({
  isLoading,
  isError,
  isEmpty,
  error,
  onRetry,
  emptyMessage,
  children,
}: QueryStateProps): ReactNode {
  if (isLoading) {
    return (
      <div className="query-state query-state--loading" data-testid="panel-loading">
        <span className="spinner" aria-hidden="true" />
        <p role="status">Loading…</p>
      </div>
    );
  }

  const hasContent = !isEmpty;

  // A failure with cached rows to fall back on: show the rows, warn about the refresh.
  if (isError && hasContent) {
    return (
      <>
        <div className="stale-banner" role="status" data-testid="panel-stale">
          <span>Could not refresh: {toApiFailure(error).message}</span>
          <button
            type="button"
            className="button button--ghost"
            onClick={onRetry}
            data-testid="panel-retry"
          >
            Retry
          </button>
        </div>
        {children}
      </>
    );
  }

  if (isError) {
    return (
      <div className="query-state query-state--error" data-testid="panel-error">
        {/* role="alert" so the failure is announced, not merely coloured. */}
        <p role="alert">{toApiFailure(error).message}</p>
        <button
          type="button"
          className="button button--secondary"
          onClick={onRetry}
          data-testid="panel-retry"
        >
          Retry
        </button>
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="query-state query-state--empty" data-testid="panel-empty">
        <p>{emptyMessage}</p>
      </div>
    );
  }

  return <>{children}</>;
}
