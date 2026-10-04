import type { ReactNode } from 'react';

/**
 * Pagination control.
 *
 * Each page is an independent query key, so jumping straight to page 5 is a
 * single fetch rather than a walk through every intermediate page. That is also
 * what makes the control work under the out-of-order scenario.
 */
export interface PaginationProps {
  readonly page: number;
  readonly totalPages: number;
  readonly totalItems: number;
  readonly onPageChange: (page: number) => void;
  readonly disabled?: boolean;
  readonly isFetching?: boolean;
  readonly label?: string;
}

export function Pagination({
  page,
  totalPages,
  totalItems,
  onPageChange,
  disabled = false,
  isFetching = false,
  label = 'Pagination',
}: PaginationProps): ReactNode {
  const safeTotal = Math.max(1, totalPages);
  const canPrevious = page > 1 && !disabled;
  const canNext = page < safeTotal && !disabled;

  return (
    <nav className="pagination" aria-label={label} data-testid="pagination">
      <button
        type="button"
        className="pagination__button"
        onClick={() => onPageChange(page - 1)}
        disabled={!canPrevious}
        aria-label="Previous page"
        data-testid="page-previous"
      >
        ‹
      </button>

      <span className="pagination__status" aria-live="polite" data-testid="page-status">
        Page {page} of {safeTotal}
        <span className="pagination__count"> · {totalItems} total</span>
        {isFetching ? <span className="pagination__spinner" aria-label="Loading" /> : null}
      </span>

      <button
        type="button"
        className="pagination__button"
        onClick={() => onPageChange(page + 1)}
        disabled={!canNext}
        aria-label="Next page"
        data-testid="page-next"
      >
        ›
      </button>
    </nav>
  );
}
