import { useSyncExternalStore } from 'react';
import { useMutation, useQuery, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';

import { DEFAULT_PAGE_SIZE, type PageResponse, type RankingEntryDto, type MatchRecordDto } from '../api/contracts';
import { fetchRanking } from '../api/rankingApi';
import { fetchMatches } from '../api/matchApi';
import { queryClient, queryKeys } from './queryClient';
import { acceptRevision } from './revisions';
import { outbox, type FlushReport, type OutboxItem } from '../outbox/outboxStore';

/**
 * Query hooks for ranking and match history.
 *
 * ONE QUERY KEY PER PAGE — this is the structural defence against the
 * out-of-order scenario. Each page is an independent cache entry, so a slow page 1
 * arriving after a fast page 2 cannot overwrite it: they never shared a key.
 *
 * THE REVISION GATE is the second line of defence, for the case the key cannot
 * help with: two fetches of the SAME page resolving out of order. Every response
 * carries the collection's revision, and a response older than one already
 * applied is dropped in favour of the rows already on screen (see `revisions.ts`).
 *
 * `enabled` is left to the caller so a panel only fetches when it is actually on
 * screen.
 */

/**
 * Returns the fresher of "what the server just sent" and "what is already
 * cached", and records the revision of the response that won.
 *
 * Shared by both queries so neither can grow a hole the other does not have.
 */
const newestWins = <T,>(scope: 'ranking' | 'matches', key: readonly unknown[], fresh: PageResponse<T>): PageResponse<T> => {
  if (acceptRevision(scope, fresh.revision)) return fresh;

  // A late response. The cached rows are, by definition, the fresher ones this
  // gate exists to protect — return them rather than clobbering the table. With
  // no cache at all there is nothing to protect, so the data is shown and the
  // next revalidation corrects it.
  return queryClient.getQueryData<PageResponse<T>>(key) ?? fresh;
};

export interface RankingQueryArgs {
  readonly configFingerprint: string;
  readonly page: number;
  readonly pageSize?: number;
  readonly enabled?: boolean;
}

export const useRankingQuery = ({
  configFingerprint,
  page,
  pageSize = DEFAULT_PAGE_SIZE,
  enabled = true,
}: RankingQueryArgs): UseQueryResult<PageResponse<RankingEntryDto>> => {
  const key = queryKeys.ranking(configFingerprint, page, pageSize);

  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      newestWins('ranking', key, await fetchRanking({ configFingerprint, page, pageSize, signal })),
    enabled: enabled && configFingerprint !== '',
    // The ranking can change when a match is recorded, so a short stale window
    // keeps the table honest without a refetch on every render.
    staleTime: 5_000,
  });
};

export interface MatchHistoryQueryArgs {
  readonly playerId: string;
  readonly page: number;
  readonly pageSize?: number;
  readonly enabled?: boolean;
}

export const useMatchHistoryQuery = ({
  playerId,
  page,
  pageSize = DEFAULT_PAGE_SIZE,
  enabled = true,
}: MatchHistoryQueryArgs): UseQueryResult<PageResponse<MatchRecordDto>> => {
  const key = queryKeys.matchHistory(playerId, page, pageSize);

  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      newestWins('matches', key, await fetchMatches({ playerId, page, pageSize, signal })),
    enabled: enabled && playerId !== '',
    staleTime: 5_000,
  });
};

/* -------------------------------------------------------------------------- */
/* Outbox                                                                      */
/* -------------------------------------------------------------------------- */

/** Subscribes to the submission queue. Re-renders only when an item changes. */
export const useOutbox = (): readonly OutboxItem[] =>
  useSyncExternalStore(outbox.subscribe, outbox.getSnapshot, outbox.getSnapshot);

export const usePendingSubmissionCount = (): number => {
  const items = useOutbox();
  return items.reduce((total, item) => (item.status === 'confirmed' ? total : total + 1), 0);
};

/**
 * Status of one specific match, projected to what the result screen shows.
 *
 * Derived from the queue rather than stored separately, so the two can never
 * disagree about whether a match was recorded.
 */
export interface SubmissionStatusView {
  readonly status: string;
  readonly message: string | null;
  readonly attempts: number;
}

export const useSubmissionStatus = (matchId: string | null): SubmissionStatusView => {
  const items = useOutbox();

  const item = matchId === null ? undefined : items.find((entry) => entry.matchId === matchId);

  const status = item === undefined ? 'idle' : item.status === 'confirmed' ? 'confirmed' : item.attempts > 0 ? 'retrying' : 'queued';

  /* The error is READ from the queue rather than copied into state. The queue is
     the source of truth — a copy would have to be resynchronised with it on every
     change, which is exactly the kind of effect this shape avoids. The player
     still learns why a submission is pending, because the message follows the
     item's own `lastError` and disappears with it. */
  return { status, message: item?.lastError ?? null, attempts: item?.attempts ?? 0 };
};

/**
 * Registration of completed matches, as a TANSTACK MUTATION.
 *
 * THE OUTBOX STILL OWNS THE WRITE. Durability — queueing, backoff and the
 * idempotency key — has to stay where it survives an unmount: a match recorded
 * from the result screen must still be recorded after that screen is gone, and a
 * hook cannot promise that. What the mutation owns is the REACT half of the
 * operation: the pending state the UI can reflect, and the invalidation that
 * makes both record tabs show the new entry the moment the write lands.
 *
 * One call is a DELIVERY PASS over the queue rather than a single POST, because
 * the pass may be joined by an earlier match that was still waiting its turn —
 * registration is "record everything that is due", not "record this one".
 *
 * It forces delivery: this hook is only reached from explicit player actions
 * (the result screen's retry, the scenario panel's "Retry now"), and an action
 * that silently waits out an invisible backoff reads as a broken button.
 */
export const useSubmitMatchesMutation = (): UseMutationResult<FlushReport, Error, void> =>
  useMutation({
    mutationFn: () => outbox.flushNow(),
    // Settled, not succeeded: a pass that confirms one item and fails the next
    // still changed what the tabs should show.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['ranking'] });
      void queryClient.invalidateQueries({ queryKey: ['matches'] });
    },
  });
