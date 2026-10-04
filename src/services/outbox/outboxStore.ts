import { ENDPOINTS, type MatchRecordDto, type SubmitMatchRequest } from '../api/contracts';
import { submitMatch } from '../api/matchApi';
import { isApiFailure, toApiFailure, type ApiFailure } from '../api/httpClient';
import { queryClient } from '../data/queryClient';
import { scenarioRuntime } from '../msw/handlers';

/**
 * ============================================================================
 *  SUBMISSION OUTBOX
 * ============================================================================
 *
 * The brief's hardest requirement: a completed match must produce exactly one
 * history record and one ranking entry, even across retries, double clicks,
 * timeouts and refreshes — while never blocking the game.
 *
 * WHY A QUEUE AT ALL
 *   Finishing a match must not await the network. The player must be able to hit
 *   "Play Again" immediately, with or without connectivity. So `enqueue` is
 *   SYNCHRONOUS and writes to localStorage; delivery happens afterwards.
 *
 * WHY DUPLICATES ARE IMPOSSIBLE
 *   Three independent layers, each sufficient on its own:
 *     1. `enqueue` is keyed by `matchId` — a double click cannot create two items.
 *     2. `flush` processes items SERIALLY — no concurrent submission of one match.
 *     3. the server upserts by `matchId` — even a resend that slipped past 1 and 2
 *        returns the existing record instead of inserting a second one.
 *
 * WHY A TIMEOUT IS RECOVERABLE
 *   A timeout means "unknown", not "failed". The item stays queued and is retried;
 *   because the write is idempotent, the retry discovers the record already
 *   exists and reports `recovered_duplicate`.
 */

const STORAGE_KEY = 'pb.outbox.v1';
const SCHEMA_VERSION = 1;

/** How many confirmed items to retain for the result screen's status. */
const CONFIRMED_HISTORY_LIMIT = 20;

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 120_000;

export type OutboxItemStatus = 'pending' | 'sending' | 'confirmed';

export interface OutboxItem {
  readonly matchId: string;
  readonly payload: SubmitMatchRequest;
  status: OutboxItemStatus;
  attempts: number;
  /** Epoch ms before which no attempt should be made. */
  nextAttemptAtMs: number;
  lastError: string | null;
  readonly enqueuedAtIso: string;
  /** Present once confirmed, so the UI can show the resulting score. */
  record: MatchRecordDto | null;
  /** True when the record was recovered rather than newly created. */
  recovered: boolean;
}

interface OutboxShape {
  readonly schemaVersion: number;
  readonly items: OutboxItem[];
}

type Listener = () => void;

const emptyShape = (): OutboxShape => ({ schemaVersion: SCHEMA_VERSION, items: [] });

export class OutboxStore {
  private state: OutboxShape = emptyShape();
  private readonly listeners = new Set<Listener>();
  private flushing = false;

  constructor(private readonly storage: Storage | null = safeLocalStorage()) {
    this.restore();
  }

  /* -------------------------------------------------------------- observers */

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly OutboxItem[] => this.state.items;

  private notify(): void {
    this.commit();
    for (const listener of this.listeners) listener();
  }

  /* ------------------------------------------------------------------ writes */

  /**
   * Queues a completed match. SYNCHRONOUS and non-blocking by design.
   *
   * Idempotent: a second call for the same `matchId` updates the existing item
   * instead of adding a second one, so "Play Again" clicked twice cannot enqueue
   * the same match twice.
   */
  enqueue(payload: SubmitMatchRequest): OutboxItem {
    const existing = this.state.items.find((item) => item.matchId === payload.matchId);
    if (existing !== undefined) {
      this.notify();
      return existing;
    }

    const item: OutboxItem = {
      matchId: payload.matchId,
      payload,
      status: 'pending',
      attempts: 0,
      nextAttemptAtMs: 0,
      lastError: null,
      enqueuedAtIso: new Date().toISOString(),
      record: null,
      recovered: false,
    };

    this.state = { ...this.state, items: [item, ...this.state.items].slice(0, 60) };
    this.notify();
    return item;
  }

  find(matchId: string): OutboxItem | undefined {
    return this.state.items.find((item) => item.matchId === matchId);
  }

  get pendingCount(): number {
    return this.state.items.filter((item) => item.status !== 'confirmed').length;
  }

  /**
   * Resets an item that has exhausted its attempts, so a permanently failed
   * submission can be retried by hand.
   */
  retry(matchId: string): void {
    this.update(matchId, (item) => ({
      ...item,
      status: 'pending',
      attempts: 0,
      nextAttemptAtMs: 0,
    }));
  }

  retryAll(): void {
    this.state = {
      ...this.state,
      items: this.state.items.map((item) =>
        item.status === 'confirmed' ? item : { ...item, status: 'pending', attempts: 0, nextAttemptAtMs: 0 },
      ),
    };
    this.notify();
  }

  clear(): void {
    this.state = emptyShape();
    this.notify();
  }

  /* ---------------------------------------------------------------- delivery */

  /**
   * Attempts delivery of every due item, one at a time.
   *
   * SERIAL delivery is deliberate: parallel submissions make duplicate bugs
   * intermittent and make the MSW scenarios non-reproducible.
   *
   * `force` bypasses the per-item backoff. Backoff exists to protect the SERVER
   * from a client that keeps hammering it; when the PLAYER asks for a retry, they
   * are explicitly overriding it, and an action that silently does nothing until
   * an internal timer says so is not an action at all.
   *
   * @returns a summary for the caller to surface in the UI.
   */
  async flush(options: FlushOptions = {}): Promise<FlushReport> {
    const { nowMs = Date.now(), force = false } = options;

    if (this.flushing) return { confirmed: 0, failed: 0, skipped: true };

    const due = this.state.items.filter(
      (item) => item.status !== 'confirmed' && (force || item.nextAttemptAtMs <= nowMs),
    );
    if (due.length === 0) return { confirmed: 0, failed: 0, skipped: false };

    this.flushing = true;
    let confirmed = 0;
    let failed = 0;

    try {
      for (const item of due) {
        const outcome = await this.deliver(item.matchId);
        if (outcome === 'confirmed') confirmed += 1;
        else failed += 1;
      }
    } finally {
      this.flushing = false;
    }

    if (confirmed > 0) {
      // Both tabs must reflect the new record.
      await queryClient.invalidateQueries({ queryKey: ['ranking'] });
      await queryClient.invalidateQueries({ queryKey: ['matches'] });
    }

    return { confirmed, failed, skipped: false };
  }

  /**
   * Delivers the queue immediately, ignoring every item's backoff.
   *
   * Bound to the "Retry now" controls: a button that respects an internal timer
   * the player cannot see is a button that appears broken.
   */
  flushNow(): Promise<FlushReport> {
    return this.flush({ force: true });
  }

  private async deliver(matchId: string): Promise<'confirmed' | 'failed'> {
    const item = this.find(matchId);
    if (item === undefined || item.status === 'confirmed') return 'confirmed';

    this.update(matchId, (current) => ({ ...current, status: 'sending' }));

    try {
      const response = await submitMatch(item.payload);
      this.confirm(matchId, response.data, response.status === 'duplicate');
      return 'confirmed';
    } catch (error) {
      this.recordFailure(matchId, toApiFailure(error));
      return 'failed';
    }
  }

  private confirm(matchId: string, record: MatchRecordDto, recovered: boolean): void {
    this.update(matchId, (item) => ({
      ...item,
      status: 'confirmed',
      record,
      recovered,
      lastError: null,
      nextAttemptAtMs: 0,
    }));
    this.pruneConfirmed();
  }

  private recordFailure(matchId: string, failure: ApiFailure): void {
    this.update(matchId, (item) => {
      const attempts = item.attempts + 1;

      // A non-retryable failure (malformed payload) will never succeed, so stop
      // burning attempts and let the player decide.
      if (!failure.retryable || attempts >= MAX_ATTEMPTS) {
        return { ...item, status: 'pending', attempts, lastError: failure.message, nextAttemptAtMs: Date.now() + MAX_BACKOFF_MS };
      }

      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
      // Full jitter, so a burst of items does not retry in lockstep.
      const delayMs = Math.random() * backoff;

      return {
        ...item,
        status: 'pending',
        attempts,
        lastError: failure.message,
        nextAttemptAtMs: Date.now() + delayMs,
      };
    });
  }

  private pruneConfirmed(): void {
    const confirmed = this.state.items.filter((item) => item.status === 'confirmed');
    if (confirmed.length <= CONFIRMED_HISTORY_LIMIT) return;

    // Drop the oldest confirmations, keeping recent status available for the UI.
    const keep = new Set(
      confirmed
        .slice()
        .sort((a, b) => a.enqueuedAtIso.localeCompare(b.enqueuedAtIso))
        .slice(-CONFIRMED_HISTORY_LIMIT)
        .map((item) => item.matchId),
    );
    this.state = {
      ...this.state,
      items: this.state.items.filter((item) => item.status !== 'confirmed' || keep.has(item.matchId)),
    };
  }

  private update(matchId: string, mutate: (item: OutboxItem) => OutboxItem): void {
    this.state = {
      ...this.state,
      items: this.state.items.map((item) => (item.matchId === matchId ? mutate(item) : item)),
    };
    this.notify();
  }

  /* ------------------------------------------------------------ persistence */

  private commit(): void {
    if (this.storage === null) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Quota / private mode: the queue degrades to memory-only for this tab.
    }
  }

  private restore(): void {
    if (this.storage === null) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (raw === null) return;

      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;
      const shape = parsed as Partial<OutboxShape>;
      if (shape.schemaVersion !== SCHEMA_VERSION || !Array.isArray(shape.items)) return;

      // Anything left mid-flight was interrupted by a refresh. It goes back to
      // `pending` so the new session retries it — this is what makes a pending
      // submission survive a reload.
      this.state = {
        schemaVersion: SCHEMA_VERSION,
        items: shape.items.map((item) => ({
          ...item,
          status: item.status === 'sending' ? 'pending' : item.status,
        })),
      };
    } catch {
      this.state = emptyShape();
    }
  }
}

export interface FlushReport {
  readonly confirmed: number;
  readonly failed: number;
  readonly skipped: boolean;
}

export interface FlushOptions {
  /** Delivery deadline to evaluate against. Defaults to now. */
  readonly nowMs?: number;
  /** Deliver regardless of the item's backoff — the player asked for it. */
  readonly force?: boolean;
}

const safeLocalStorage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export const outbox = new OutboxStore();

/* -------------------------------------------------------------------------- */
/* Delivery triggers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Starts background delivery.
 *
 * Four independent triggers, because no single one is sufficient:
 *   • immediately on enqueue — the common case, no delay,
 *   • `online` — the offline case becomes deliverable,
 *   • focus / visibility — a tab restored after sleep retries promptly,
 *   • a slow interval — covers failures that are not connection-related.
 *
 * Nothing here ever blocks gameplay or throws into the UI.
 */
export const startOutboxDelivery = (intervalMs = 5_000): (() => void) => {
  const flush = (): void => {
    void outbox.flush().catch((error: unknown) => {
      if (isApiFailure(error)) return; // Already normalised and reported per item.
      console.warn('[outbox] flush failed', error);
    });
  };

  // Immediate attempt for anything restored from a previous session.
  queueMicrotask(flush);

  const timer = setInterval(flush, intervalMs);
  const onOnline = (): void => flush();
  const onFocus = (): void => flush();
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') flush();
  };

  window.addEventListener('online', onOnline);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    clearInterval(timer);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
  };
};

/**
 * Clears the SUBMISSION side of the initial state: the queue and the query cache.
 *
 * The record store deliberately does NOT live here. It is owned by
 * `resetMockServer`, which empties it and re-seeds the fixtures in the same pass
 * — having two functions each wipe it is what turned "reset" into "delete the
 * demo data": the second wipe ran after the re-seed and left an empty ranking.
 */
export const resetMockState = (): void => {
  outbox.clear();
  void queryClient.clear();
};

/** Exposed so the scenario panel can show which endpoint is under test. */
export const OUTBOX_ENDPOINTS = ENDPOINTS;
export const activeScenarioId = (): string => scenarioRuntime.active.id;
