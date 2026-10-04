import { ENDPOINTS, type MatchRecordDto, type PageResponse, type SubmitMatchRequest, type SubmitMatchResponse } from './contracts';
import { httpClient } from './httpClient';
import { assertPageResponse, assertRecord } from './responseGuards';

/**
 * Match history reads and writes.
 *
 * THE IDEMPOTENCY RULE lives here, not in the transport.
 *
 * `POST /matches` carries the `matchId` twice: in the body and in the
 * `Idempotency-Key` header. The server keys its store by that id, so a retry
 * after a timeout either creates the record once or returns the existing one with
 * `status: 'duplicate'`. That turns "I don't know if my first attempt landed"
 * from an unrecoverable ambiguity into a safe, idempotent retry — which is what
 * lets a submission survive a refresh, a flaky network, or a double click.
 */

export interface MatchListParams {
  readonly playerId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly signal?: AbortSignal;
}

/**
 * Reads are retried by the caller (TanStack Query owns read retries), so this is
 * deliberately a plain call with no transport-level retry.
 */
export const fetchMatches = async ({
  playerId,
  page,
  pageSize,
  signal,
}: MatchListParams): Promise<PageResponse<MatchRecordDto>> => {
  const response = await httpClient.get<PageResponse<MatchRecordDto>>(ENDPOINTS.matches, {
    params: { playerId, page, pageSize },
    signal,
  });
  return assertPageResponse<MatchRecordDto>(response.data, ENDPOINTS.matches);
};

export const fetchMatch = async (matchId: string, signal?: AbortSignal): Promise<MatchRecordDto> => {
  const response = await httpClient.get<MatchRecordDto>(ENDPOINTS.match(matchId), { signal });
  return assertRecord<MatchRecordDto>(response.data, ENDPOINTS.match(matchId));
};

/**
 * Submits a completed match.
 *
 * NEVER retried here. A timeout does not prove the write failed, and a blind
 * retry is how duplicates are created. The outbox owns retries, and because the
 * request is idempotent, retrying there is safe.
 */
export const submitMatch = async (payload: SubmitMatchRequest): Promise<SubmitMatchResponse> => {
  const response = await httpClient.post<SubmitMatchResponse>(ENDPOINTS.matches, payload, {
    headers: {
      // The server's idempotency key. Same value as `payload.matchId`.
      'Idempotency-Key': payload.matchId,
    },
  });
  return response.data;
};
