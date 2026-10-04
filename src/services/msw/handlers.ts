import {
  HttpResponse,
  delay,
  http,
  type DefaultBodyType,
  type HttpResponseResolver,
  type PathParams,
} from 'msw';

import {
  API_BASE_URL,
  ENDPOINTS,
  type ApiErrorCode,
  type MatchRecordDto,
  type PageResponse,
  type RankingEntryDto,
  type SubmitMatchRequest,
  type SubmitMatchResponse,
} from '../api/contracts';
import { buildRanking, mockDb } from './db';
import { buildFixtureMatches } from './fixtures';
import { ScenarioRuntime, type EndpointKind, type FailureRule } from './scenarios';
import { defaultConfigFingerprint } from '../api/defaultFingerprint';

/**
 * ============================================================================
 *  MSW HANDLERS
 * ============================================================================
 *
 * Every handler closes over ONE `ScenarioRuntime` and ONE `mockDb`. That is what
 * keeps the two tabs consistent: a record written by `POST /matches` is
 * immediately visible to `GET /matches` AND `GET /ranking`.
 *
 * Responses are gated by the active scenario, so switching conditions never
 * requires touching this file.
 */

/** Live runtime, mutated by the scenario panel. */
export const scenarioRuntime = new ScenarioRuntime();

const iso = (): string => new Date().toISOString();

/** MSW's opaque `Response` type carries a body type parameter. */
type MockResponse = HttpResponse<DefaultBodyType>;

/** The resolver shape `http.get` / `http.post` expect. */
type Resolver = HttpResponseResolver<PathParams, DefaultBodyType, DefaultBodyType>;

/* -------------------------------------------------------------------------- */
/* Failure plumbing                                                            */
/* -------------------------------------------------------------------------- */

/** Signals "answer with this status" out of the shared failure helper. */
class ScenarioStatusError extends Error {
  constructor(readonly rule: FailureRule) {
    super('scenario-status');
    this.name = 'ScenarioStatusError';
  }
}

/** Thrown for a scenario that simulates the request never reaching a server. */
class ScenarioNetworkError extends Error {
  constructor() {
    super('scenario-network-error');
    this.name = 'ScenarioNetworkError';
  }
}

const errorResponse = (code: ApiErrorCode, message: string, status: number): MockResponse =>
  HttpResponse.json({ error: { code, message } }, { status });

const statusResponse = (rule: FailureRule, endpoint: string): MockResponse => {
  const status = rule.status ?? 503;
  const code: ApiErrorCode =
    status === 400
      ? 'VALIDATION_ERROR'
      : status === 429
        ? 'RATE_LIMITED'
        : status >= 500
          ? 'UNAVAILABLE'
          : 'INTERNAL';
  return errorResponse(code, `Scenario "${scenarioRuntime.active.id}" forced a ${status} on ${endpoint}.`, status);
};

/**
 * Applies latency and any forced failure for a read.
 *
 * @returns a response when the request has been fully handled (including
 *          deliberately failing it), or `null` when the caller should proceed.
 */
const guardRead = async (endpoint: EndpointKind, resourceKey: string): Promise<MockResponse | null> => {
  const rule = scenarioRuntime.failureFor(endpoint);

  if (rule === null) {
    await delay(scenarioRuntime.readLatencyMs(resourceKey));
    return null;
  }

  switch (rule.mode) {
    case 'timeout':
      await delay('infinite');
      return new HttpResponse(null, { status: 504 });

    case 'network-error':
      throw new ScenarioNetworkError();

    case 'http-status':
      await delay(scenarioRuntime.readLatencyMs(resourceKey));
      throw new ScenarioStatusError(rule);

    case 'commit-then-hang':
    case 'none':
      return null;
  }
};

/** Converts scenario errors into real responses. */
const run = (endpoint: string, body: () => Promise<MockResponse>): Promise<MockResponse> =>
  body().catch((error: unknown) => {
    if (error instanceof ScenarioStatusError) return statusResponse(error.rule, endpoint);
    if (error instanceof ScenarioNetworkError) {
      // A genuine transport failure: MSW's `error()` produces a network-level
      // error rather than an HTTP status, which the client maps to `offline`.
      return HttpResponse.error();
    }
    throw error;
  });

/* -------------------------------------------------------------------------- */
/* Query helpers                                                               */
/* -------------------------------------------------------------------------- */

const paginate = <T>(items: readonly T[], page: number, pageSize: number): T[] => {
  const size = Math.max(1, pageSize);
  const safePage = Math.max(1, page);
  const start = (safePage - 1) * size;
  return items.slice(start, start + size);
};

const metaFor = (totalItems: number, page: number, pageSize: number) => {
  const size = Math.max(1, pageSize);
  return {
    page: Math.max(1, page),
    pageSize: size,
    totalItems,
    totalPages: Math.max(1, Math.ceil(totalItems / size)),
  };
};

const intParam = (url: URL, key: string, fallback: number): number => {
  const raw = Number(url.searchParams.get(key));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};

/* -------------------------------------------------------------------------- */
/* Seed data                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Ensures the database holds fixtures matching the active scenario.
 *
 * Fixtures are seeded under the fingerprint the CLIENT computes for the default
 * options. That matters: the ranking filters strictly by configuration, so seeding
 * under an arbitrary synthetic key produces a permanently empty table. Computing
 * the same fingerprint the app uses means the leaderboard is populated on first
 * load — and if the player changes their options, the table correctly empties,
 * because no match has been recorded under those settings yet.
 *
 * Real submissions survive re-seeding: switching scenarios must never discard the
 * player's own records.
 */
export const ensureSeeded = (): void => {
  const { fixtureCount } = scenarioRuntime.active;
  const realMatches = mockDb.matches.filter((record) => !record.matchId.startsWith('fixture-'));
  const fixtureMatches = mockDb.matches.filter((record) => record.matchId.startsWith('fixture-'));

  if (fixtureMatches.length === fixtureCount && mockDb.matches.length === fixtureCount + realMatches.length) {
    return;
  }

  mockDb.reset([
    ...buildFixtureMatches({ count: fixtureCount, configFingerprint: defaultConfigFingerprint() }),
    ...realMatches,
  ]);
};

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

const rankingHandler: Resolver = ({ request }) =>
  run('ranking', async () => {
    const url = new URL(request.url);
    const fingerprint = url.searchParams.get('configFingerprint') ?? '';
    const page = intParam(url, 'page', 1);
    const pageSize = intParam(url, 'pageSize', 10);

    const forced = await guardRead('ranking', `${fingerprint}:${page}`);
    if (forced !== null) return forced;

    const all = buildRanking(mockDb.matches, fingerprint);
    const payload: PageResponse<RankingEntryDto> = {
      data: paginate(all, page, pageSize),
      meta: metaFor(all.length, page, pageSize),
      revision: mockDb.rankingRevision,
      generatedAtIso: iso(),
    };
    return HttpResponse.json(payload);
  });

const matchListHandler: Resolver = ({ request }) =>
  run('history', async () => {
    const url = new URL(request.url);
    const playerId = url.searchParams.get('playerId') ?? '';
    const page = intParam(url, 'page', 1);
    const pageSize = intParam(url, 'pageSize', 10);

    const forced = await guardRead('history', `${playerId}:${page}`);
    if (forced !== null) return forced;

    const all = mockDb.matches
      .filter((record) => record.playerId === playerId)
      .slice()
      .sort((a, b) => {
        // Newest first, with a deterministic tie-break so equal timestamps cannot
        // swap places between requests.
        if (a.finishedAtIso !== b.finishedAtIso) return a.finishedAtIso < b.finishedAtIso ? 1 : -1;
        return a.matchId < b.matchId ? -1 : 1;
      });

    const payload: PageResponse<MatchRecordDto> = {
      data: paginate(all, page, pageSize),
      meta: metaFor(all.length, page, pageSize),
      revision: mockDb.matchesRevision,
      generatedAtIso: iso(),
    };
    return HttpResponse.json(payload);
  });

const matchDetailHandler: Resolver = ({ params }) =>
  run('history', async () => {
    const matchId = String(params['matchId'] ?? '');
    const forced = await guardRead('history', matchId);
    if (forced !== null) return forced;

    const record = mockDb.findMatch(matchId);
    if (record === undefined) {
      return errorResponse('NOT_FOUND', `No match with id "${matchId}".`, 404);
    }
    return HttpResponse.json(record);
  });

const toRecord = (payload: SubmitMatchRequest): MatchRecordDto => ({
  matchId: payload.matchId,
  playerId: payload.playerId,
  playerName: payload.playerName,
  score: payload.score,
  effectiveDurationMs: payload.effectiveDurationMs,
  endReason: payload.endReason,
  configFingerprint: payload.configFingerprint,
  configSnapshot: payload.configSnapshot,
  finishedAtIso: payload.finishedAtIso,
  seed: payload.seed,
});

/**
 * THE IDEMPOTENCY-CRITICAL HANDLER.
 *
 * Order of operations is the whole point here:
 *   1. validate,
 *   2. UPSERT (the write),
 *   3. only then, if the scenario says so, hang without answering.
 *
 * Step 3 after step 2 creates `submit-commit-then-hang`: the client observes a
 * timeout while the record actually exists. Only a RESEND can discover that, and
 * step 2 being an upsert keyed by `matchId` is what makes the resend safe — it
 * returns the existing record with `status: 'duplicate'` instead of inserting a
 * second one.
 */
const submitHandler = async ({ request }: { request: Request }): Promise<MockResponse> => {
  const failure = scenarioRuntime.failureFor('submit');

  const payload = await request.json().catch(() => null);
  if (payload === null) {
    return errorResponse('VALIDATION_ERROR', 'Request body must be valid JSON.', 400);
  }

  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (typeof payload.matchId !== 'string' || payload.matchId.length === 0) {
    return errorResponse('VALIDATION_ERROR', 'matchId is required.', 400);
  }
  // A mismatch means the client is unsure which match it is submitting, which is
  // exactly the ambiguity idempotency exists to prevent.
  if (idempotencyKey !== null && idempotencyKey !== payload.matchId) {
    return errorResponse(
      'VALIDATION_ERROR',
      `Idempotency-Key "${idempotencyKey}" does not match body matchId "${payload.matchId}".`,
      400,
    );
  }
  if (typeof payload.playerId !== 'string' || payload.playerId.length === 0) {
    return errorResponse('VALIDATION_ERROR', 'playerId is required.', 400);
  }
  if (!Number.isFinite(payload.score) || payload.score < 0) {
    return errorResponse('VALIDATION_ERROR', 'score must be a non-negative number.', 400);
  }

  if (failure?.mode === 'commit-then-hang') {
    await delay(scenarioRuntime.readLatencyMs(payload.matchId));
    mockDb.upsertMatch(toRecord(payload));
    // The record exists; the client will never learn that from this response.
    await delay('infinite');
    return new HttpResponse(null, { status: 504 });
  }

  if (failure?.mode === 'network-error') {
    await delay(scenarioRuntime.readLatencyMs(payload.matchId));
    return HttpResponse.error();
  }

  if (failure?.mode === 'timeout') {
    await delay('infinite');
    return new HttpResponse(null, { status: 504 });
  }

  await delay(scenarioRuntime.active.submitLatencyMs ?? scenarioRuntime.readLatencyMs(payload.matchId));

  if (failure?.mode === 'http-status') {
    return statusResponse(failure, 'submit');
  }

  const { record, created } = mockDb.upsertMatch(toRecord(payload));
  const response: SubmitMatchResponse = {
    data: record,
    // `duplicate` is a SUCCESS: a retried submission is a confirmed write.
    status: created ? 'created' : 'duplicate',
    revision: mockDb.matchesRevision,
  };
  return HttpResponse.json(response, { status: created ? 201 : 200 });
};

const absolute = (path: string): string => new URL(`${API_BASE_URL}${path}`, location.origin).toString();

/**
 * Route registration.
 *
 * The paths here are the ABSOLUTE form of `ENDPOINTS`, because the service worker
 * matches on full URL while axios sends requests resolved against `baseURL`. Both
 * spellings derive from the same constant, so the two cannot drift apart.
 */
export const handlers = [
  http.get(absolute(ENDPOINTS.ranking), rankingHandler),
  http.get(absolute(ENDPOINTS.matches), matchListHandler),
  http.get(absolute(ENDPOINTS.match(':matchId')), matchDetailHandler),
  http.post(absolute(ENDPOINTS.matches), submitHandler as Resolver),
];
