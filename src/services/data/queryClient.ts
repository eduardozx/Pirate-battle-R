import { QueryClient, keepPreviousData } from '@tanstack/react-query';

import { toApiFailure } from '../api/httpClient';

/**
 * ============================================================================
 *  TANSTACK QUERY CLIENT
 * ============================================================================
 *
 * Tuned for a ranking/history UI that must degrade gracefully rather than block
 * the game:
 *
 *   • `retry: 2` with capped exponential backoff — enough to ride out a transient
 *     503, short enough that a genuine outage does not leave the user waiting.
 *   • `staleTime: 5s` — a player flipping between the two tabs sees no refetch
 *     storm, while data still refreshes quickly.
 *   • `refetchOnWindowFocus` — coming back to the tab revalidates, which is what
 *     satisfies "refresh both tabs when the player returns to them".
 *
 * `retry` is deliberately NOT applied to mutations: submission retries belong to
 * the outbox, which owns idempotency.
 */

const shouldRetry = (failureCount: number, error: unknown): boolean => {
  if (failureCount >= 2) return false;
  // Only transient failures deserve a retry; a 400 will never become a 200.
  return toApiFailure(error).retryable;
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetry,
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
      staleTime: 5_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      // Always revalidate on mount, so returning to a tab shows fresh data.
      refetchOnMount: 'always',
      /**
       * Keep the previous page visible while the next one loads, so paginating
       * causes no white flash and no layout jump.
       *
       * `keepPreviousData` is the supported v5 API for this. The equivalent
       * hand-rolled `placeholderData: (previous) => previous` leaves a SUCCEEDED
       * query with `data === undefined`, which renders as an empty table rather
       * than an error — a silent failure that is very hard to diagnose from the
       * outside.
       */
      placeholderData: keepPreviousData,
      retryOnMount: true,
    },
    mutations: {
      // Writes go through the outbox; the query layer must not retry them.
      retry: false,
    },
  },
});

/**
 * Shared query-key factory.
 *
 * One key per PAGE, which is what structurally prevents out-of-order responses
 * from overwriting each other: two pages never share a cache entry, so a slow
 * page 1 arriving after a fast page 2 has nothing to clobber.
 */
export const queryKeys = {
  ranking: (fingerprint: string, page: number, pageSize: number) =>
    ['ranking', fingerprint, page, pageSize] as const,
  matchHistory: (playerId: string, page: number, pageSize: number) =>
    ['matches', playerId, page, pageSize] as const,
  outbox: () => ['outbox'] as const,
  pendingSubmissions: () => ['outbox', 'pending'] as const,
} as const;
