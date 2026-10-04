import { useState, type ReactNode } from 'react';

import { Pagination } from './Pagination';
import { QueryState } from './QueryState';
import { formatDuration } from './RankingPanel';
import { DEFAULT_PAGE_SIZE } from '../../services/api/contracts';
import { useMatchHistoryQuery } from '../../services/data/queries';
import { usePlayer } from '../../store/playerStore';

/**
 * Match history tab: the player's own completed matches.
 *
 * An ABANDONED match is never recorded, so it cannot appear here — the only way a
 * match reaches this table is a completed one that was successfully enqueued.
 */
export interface MatchHistoryPanelProps {
  readonly enabled?: boolean;
}

export function MatchHistoryPanel({ enabled = true }: MatchHistoryPanelProps): ReactNode {
  const { playerId, playerName } = usePlayer();
  const [page, setPage] = useState(1);
  const query = useMatchHistoryQuery({ playerId, page, pageSize: DEFAULT_PAGE_SIZE, enabled });

  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;

  return (
    <section className="records" aria-label="Match history">
      <p className="records__filter" data-testid="history-filter">
        Captain {playerName}
      </p>

      <QueryState
        isLoading={query.isPending}
        isError={query.isError}
        isEmpty={rows.length === 0}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyMessage="No completed matches recorded yet."
      >
        <div className="table-scroll">
          <table className="records__table" data-testid="history-table">
            <caption className="sr-only">Your completed matches</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Score</th>
                <th scope="col">Duration</th>
                <th scope="col">End reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((record) => (
                <tr key={record.matchId} data-testid="history-row">
                  <td>{new Date(record.finishedAtIso).toLocaleString()}</td>
                  <td className="records__score">{record.score}</td>
                  <td>{formatDuration(record.effectiveDurationMs)}</td>
                  <td>{record.endReason === 'time_expired' ? 'Time expired' : 'Ship destroyed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {meta !== undefined && (
          <Pagination
            page={meta.page}
            totalPages={meta.totalPages}
            totalItems={meta.totalItems}
            onPageChange={setPage}
            isFetching={query.isFetching}
            label="Match history pagination"
          />
        )}
      </QueryState>
    </section>
  );
}
