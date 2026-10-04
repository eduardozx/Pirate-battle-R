import type { PageResponse } from './contracts';
import { MalformedPayloadError } from './httpClient';

/**
 * Response guards.
 *
 * WHY THIS EXISTS: a request that escapes the mock service worker (or hits a
 * misconfigured host) receives the SPA fallback — `index.html` with status **200**.
 * Because 200 means "success", the query cache happily stores that HTML as if it
 * were a ranking payload, and the table renders permanently empty with no error
 * message anywhere. That failure mode is invisible and extremely expensive to
 * diagnose.
 *
 * A guard converts it into an explicit, retryable failure at the boundary. The
 * cost is one cheap shape check per response; the benefit is that a wrong payload
 * can never masquerade as an empty result.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * True when a value looks like a paginated envelope.
 *
 * `typeof body === 'string'` catches the HTML-as-JSON case directly: axios returns
 * the raw string when the body is not valid JSON.
 */
export const isPageResponse = <T,>(value: unknown): value is PageResponse<T> => {
  if (typeof value === 'string') return false;
  if (!isRecord(value)) return false;
  if (!Array.isArray(value['data'])) return false;

  const meta = value['meta'];
  if (!isRecord(meta)) return false;

  return (
    typeof meta['page'] === 'number' &&
    typeof meta['pageSize'] === 'number' &&
    typeof meta['totalItems'] === 'number' &&
    typeof meta['totalPages'] === 'number'
  );
};

export const assertPageResponse = <T,>(value: unknown, endpoint: string): PageResponse<T> => {
  if (!isPageResponse<T>(value)) {
    const kind =
      typeof value === 'string'
        ? `received a ${value.trimStart().startsWith('<') ? 'HTML document' : 'string'} body`
        : `received ${value === null ? 'null' : typeof value}`;
    throw new MalformedPayloadError(`Unexpected response from ${endpoint}: ${kind}`);
  }
  return value;
};

export const assertRecord = <T,>(value: unknown, endpoint: string): T => {
  if (typeof value === 'string' || !isRecord(value)) {
    throw new MalformedPayloadError(`Unexpected response from ${endpoint}: expected an object`);
  }
  return value as T;
};
