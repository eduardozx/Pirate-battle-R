/**
 * ============================================================================
 *  API CONTRACTS — the single source of truth for ranking & match history
 * ============================================================================
 *
 * These types are shared by three consumers that must never disagree:
 *   • the Axios client (requests and responses),
 *   • the TanStack Query hooks (cache keys and read models),
 *   • the MSW handlers (the fake server the browser actually talks to).
 *
 * Changing a field here breaks compilation in all three at once, which is the
 * point: a mismatched mock is a compile error rather than a silent UI bug.
 */

import type { GameConfigSnapshot } from '../../game/config/gameConfig';
import type { EndReason } from '../../game/core/types';

/** Why a match ended. Abandoned matches are never recorded, so no third value. */
export type { EndReason };

export interface MatchConfigSummary {
  readonly sessionSeconds: number;
  readonly spawnIntervalSeconds: number;
  /** Stable hash of the gameplay config; ranking only compares like with like. */
  readonly fingerprint: string;
}

export interface MatchRecordDto {
  readonly matchId: string;
  readonly playerId: string;
  readonly playerName: string;
  readonly score: number;
  readonly effectiveDurationMs: number;
  readonly endReason: EndReason;
  readonly configFingerprint: string;
  readonly configSnapshot: GameConfigSnapshot;
  readonly finishedAtIso: string;
  readonly seed: number;
}

export interface RankingEntryDto {
  readonly rank: number;
  readonly matchId: string;
  readonly playerId: string;
  readonly playerName: string;
  readonly score: number;
  readonly effectiveDurationMs: number;
  readonly endReason: EndReason;
  readonly configFingerprint: string;
  readonly finishedAtIso: string;
}

/**
 * Monotonic per-resource revision.
 *
 * This is what makes an out-of-order response detectable: a client that already
 * applied revision N must discard a late response carrying N-1, instead of
 * silently replacing fresher data with staler data.
 */
export interface PageMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

export interface PageResponse<T> {
  readonly data: readonly T[];
  readonly meta: PageMeta;
  readonly revision: number;
  readonly generatedAtIso: string;
}

export interface SubmitMatchRequest {
  readonly schemaVersion: number;
  readonly matchId: string;
  readonly playerId: string;
  readonly playerName: string;
  readonly score: number;
  readonly effectiveDurationMs: number;
  readonly endReason: EndReason;
  readonly configFingerprint: string;
  readonly configSnapshot: GameConfigSnapshot;
  readonly finishedAtIso: string;
  readonly seed: number;
}

/**
 * `duplicate` is a SUCCESS, not an error.
 *
 * The brief requires that a resend "recovers the existing record" instead of
 * duplicating it. Returning 200 with `duplicate` lets the client treat a retry as
 * a confirmed write, which is what keeps a pending submission recoverable after
 * a timeout that actually reached the server.
 */
export interface SubmitMatchResponse {
  readonly data: MatchRecordDto;
  readonly status: 'created' | 'duplicate';
  readonly revision: number;
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'INTERNAL';

export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, string>>;
  };
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Base URL for the mocked API.
 *
 * `BASE_URL` is normalised to have NO trailing slash: Vite sets it to `/`, or
 * `/sub-path/` for a sub-directory deployment.
 */
const withTrailingSlash = (path: string): string => (path.endsWith('/') ? path : `${path}/`);

export const API_BASE_URL = `${withTrailingSlash(import.meta.env.BASE_URL)}api`;

/**
 * Endpoint paths are RELATIVE to `API_BASE_URL`.
 *
 * They must not repeat the `/api` prefix: axios prepends `baseURL` to every path,
 * so an absolute `/api/ranking` combined with `baseURL: '/api'` resolves to
 * `/api/api/ranking` — which the mock server does not handle, and which fails
 * silently as an empty table rather than an error.
 */
export const ENDPOINTS = {
  ranking: '/ranking',
  matches: '/matches',
  match: (matchId: string): string => `/matches/${encodeURIComponent(matchId)}`,
} as const;

/* -------------------------------------------------------------------------- */
/* Submission status surfaced on the result screen                             */
/* -------------------------------------------------------------------------- */

export type SubmissionStatus =
  /** Not submitted (abandoned match, or a match still in progress). */
  | 'idle'
  /** Accepted by the outbox, waiting for a successful round-trip. */
  | 'queued'
  /** A request is in flight right now. */
  | 'submitting'
  /** Server confirmed a new record. */
  | 'confirmed'
  /** Server already had this matchId; the existing record was recovered. */
  | 'recovered_duplicate'
  /** Failed, but queued for retry. */
  | 'retrying'
  /** Failed permanently (malformed payload). */
  | 'failed'
  /** The match was abandoned and is deliberately never recorded. */
  | 'abandoned';

export const SUBMISSION_COPY: Record<SubmissionStatus, string> = {
  idle: 'Not recorded',
  queued: 'Pending — will be submitted automatically',
  submitting: 'Submitting…',
  confirmed: 'Recorded',
  recovered_duplicate: 'Recorded (already saved)',
  retrying: 'Pending — retrying after a network failure',
  failed: 'Could not be recorded',
  abandoned: 'Not recorded (match abandoned)',
};

/* -------------------------------------------------------------------------- */
/* Client-side identity                                                        */
/* -------------------------------------------------------------------------- */

/** The local player. Standalone app: one anonymous profile per browser. */
export interface PlayerProfile {
  readonly playerId: string;
  readonly playerName: string;
}

export const DEFAULT_PAGE_SIZE = 10;
