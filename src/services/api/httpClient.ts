import axios, { AxiosError, type AxiosInstance } from 'axios';

import { API_BASE_URL, type ApiErrorBody } from './contracts';

/**
 * ============================================================================
 *  AXIOS CLIENT
 * ============================================================================
 *
 * One instance, with three responsibilities and no business logic:
 *   1. attach a correlation id so a failing request can be traced,
 *   2. normalise every failure into a single `ApiFailure` shape,
 *   3. retry IDEMPOTENT reads only.
 *
 * THE MOST IMPORTANT RULE HERE: POST is never retried by the transport.
 *
 * A transport-level retry is only safe for a request that cannot have a side
 * effect. Retrying `POST /matches` after a timeout is exactly how duplicate
 * ranking entries get created, because a timeout means "we do not know whether
 * the server committed". Retries for submissions belong to the outbox, which
 * carries an `Idempotency-Key` so a duplicate is recoverable rather than
 * duplicated.
 */

export type ApiFailureKind =
  | 'timeout'
  | 'offline'
  | 'client'
  | 'server'
  | 'canceled'
  | 'unknown';

/** A normalised, exhaustive failure. UI code switches on `kind`, never on axios. */
export interface ApiFailure {
  readonly kind: ApiFailureKind;
  readonly status: number | null;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export class MalformedPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedPayloadError';
  }
}

export const isApiFailure = (error: unknown): error is ApiFailure =>
  typeof error === 'object' &&
  error !== null &&
  'kind' in error &&
  'retryable' in error;

export const requestId = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `req-${Math.random().toString(36).slice(2)}`).slice(0, 8);

/** Turns any thrown value into an `ApiFailure`. Never throws itself. */
export const toApiFailure = (error: unknown): ApiFailure => {
  if (isApiFailure(error)) return error;

  // A guard rejection is already a readable failure; keep its text intact.
  if (error instanceof MalformedPayloadError) {
    return { kind: 'unknown', status: null, code: 'MALFORMED_RESPONSE', message: error.message, retryable: true };
  }

  if (axios.isCancel(error)) {
    return { kind: 'canceled', status: null, code: 'CANCELED', message: 'Request canceled', retryable: false };
  }

  if (error instanceof AxiosError) {
    const status = error.response?.status ?? null;

    // Prefer the server's structured error when present: it is more actionable
    // than a generic status message.
    const body = error.response?.data as Partial<ApiErrorBody> | undefined;
    const code = body?.error?.code ?? codeForStatus(status);
    const message = body?.error?.message ?? error.message;

    if (error.code === 'ECONNABORTED' || code === 'TIMEOUT') {
      return { kind: 'timeout', status, code: 'TIMEOUT', message, retryable: true };
    }
    if (error.code === 'ERR_NETWORK' || status === null) {
      return { kind: 'offline', status: null, code: 'OFFLINE', message: 'Network unreachable', retryable: true };
    }
    if (status !== null && status >= 500) {
      return { kind: 'server', status, code, message, retryable: true };
    }
    return { kind: 'client', status, code, message, retryable: false };
  }

  return {
    kind: 'unknown',
    status: null,
    code: 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
};

const codeForStatus = (status: number | null): string => {
  if (status === null) return 'NETWORK';
  if (status === 400) return 'VALIDATION_ERROR';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UNAVAILABLE';
  return 'CLIENT_ERROR';
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries an idempotent operation with exponential backoff and full jitter.
 *
 * Jitter matters under MSW's failure scenarios: without it, every parallel query
 * retries in lockstep and recreates the thundering herd the backoff was meant to
 * prevent.
 */
export async function retryIdempotent<T>(
  operation: () => Promise<T>,
  options: {
    readonly attempts: number;
    readonly baseDelayMs?: number;
    readonly signal?: AbortSignal;
    readonly onAttempt?: (attempt: number) => void;
  },
): Promise<T> {
  const baseDelay = options.baseDelayMs ?? 400;
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      const failure = toApiFailure(error);
      lastError = error;
      options.onAttempt?.(attempt);
      if (!failure.retryable || attempt === options.attempts) throw failure;
      // Full jitter: random(0, base * 2^attempt).
      const ceiling = baseDelay * 2 ** attempt;
      await sleep(Math.random() * ceiling);
    }
  }

  throw toApiFailure(lastError);
}

export const createHttpClient = (): AxiosInstance => {
  const instance = axios.create({
    baseURL: API_BASE_URL,
    // Generous but bounded: the MSW timeout scenarios resolve well inside this,
    // so a genuine hang fails fast enough to keep the UI responsive.
    timeout: 8000,
    headers: {
      'X-Client': 'pirate-battle-web/1.0',
      'Content-Type': 'application/json',
    },
  });

  instance.interceptors.request.use((config) => {
    config.headers.set('X-Request-Id', requestId());
    return config;
  });

  instance.interceptors.response.use(
    (response) => response,
    (error: unknown) => Promise.reject(toApiFailure(error)),
  );

  return instance;
};

/** One shared instance for the whole app. */
export const httpClient = createHttpClient();
