import { ENDPOINTS, type PageResponse, type RankingEntryDto } from './contracts';
import { httpClient, retryIdempotent } from './httpClient';
import { assertPageResponse } from './responseGuards';

/**
 * Ranking reads.
 *
 * The ranking only ever compares matches played with the SAME configuration, so
 * `configFingerprint` is a required filter rather than an optional one. Mixing
 * balance settings into one table produces an order that means nothing.
 */

export interface RankingParams {
  readonly configFingerprint: string;
  readonly page: number;
  readonly pageSize: number;
  readonly signal?: AbortSignal;
}

export const fetchRanking = async ({
  configFingerprint,
  page,
  pageSize,
  signal,
}: RankingParams): Promise<PageResponse<RankingEntryDto>> => {
  const response = await retryIdempotent(
    () =>
      httpClient.get<PageResponse<RankingEntryDto>>(ENDPOINTS.ranking, {
        params: { configFingerprint, page, pageSize },
        signal,
      }),
    { attempts: 2, signal },
  );

  return assertPageResponse<RankingEntryDto>(response.data, ENDPOINTS.ranking);
};
