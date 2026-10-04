import { useState, type ReactNode } from 'react';

import { Pagination } from './Pagination';
import { QueryState } from './QueryState';
import { DEFAULT_PAGE_SIZE } from '../../services/api/contracts';
import { useRankingQuery } from '../../services/data/queries';

/**
 * Ranking tab.
 *
 * Only compares matches played with the SAME configuration: the fingerprint is a
 * required filter, so a 60-second match and a 180-second match never share a
 * table. The current filter is stated in the UI so the rule is visible to the
 * player rather than implicit.
 */

export interface RankingPanelProps {
  readonly configFingerprint: string;
  readonly sessionSeconds: number;
  readonly spawnIntervalSeconds: number;
}

export function RankingPanel({
  configFingerprint,
  sessionSeconds,
  spawnIntervalSeconds,
}: RankingPanelProps): ReactNode {
  const [page, setPage] = useState(1);
  const query = useRankingQuery({ configFingerprint, page, pageSize: DEFAULT_PAGE_SIZE });

  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;

  return (
    <section className="records" aria-label="Ranking">
      <p className="records__filter" data-testid="ranking-filter">
        Configuration: {sessionSeconds}s session · {spawnIntervalSeconds}s spawn
      </p>

      <QueryState
        isLoading={query.isPending}
        isError={query.isError}
        isEmpty={rows.length === 0}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyMessage="No recorded matches for this configuration yet."
      >
        <div className="table-scroll">
          <table className="records__table" data-testid="ranking-table">
            <caption className="sr-only">
              Ranking of recorded matches for the current configuration
            </caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Player</th>
                <th scope="col">Score</th>
                <th scope="col">Time</th>
                <th scope="col">Ended</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.matchId} data-testid="ranking-row">
                  <td className="records__rank">{entry.rank}</td>
                  <td>{entry.playerName}</td>
                  <td className="records__score">{entry.score}</td>
                  <td>{formatDuration(entry.effectiveDurationMs)}</td>
                  <td>{entry.endReason === 'time_expired' ? 'Time' : 'Sunk'}</td>
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
            label="Ranking pagination"
          />
        )}
      </QueryState>
    </section>
  );
}

export const formatDuration = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
};
