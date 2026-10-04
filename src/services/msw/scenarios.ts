import { mulberry32 } from './seededRandom';

/**
 * ============================================================================
 *  NETWORK SCENARIOS — reproducible, selectable network conditions
 * ============================================================================
 *
 * The brief requires scenarios for: success, empty lists, multiple pages, slow
 * responses, variable latency, out-of-order responses, timeouts, connection
 * failures, 4xx/5xx, per-endpoint query failures, "timeout after the write
 * committed", and "service unavailable at match end".
 *
 * DESIGN RULE: every non-determinism is drawn from a SEEDED stream. A scenario
 * must fail the same way on every run and on every machine, otherwise it is not a
 * test — it is a coin flip that happens to pass today.
 *
 * The awkward cases deserve naming, because they are the ones that break real
 * clients:
 *
 *   • `submit_commit_then_hang` — the server WRITES the record and then never
 *     answers. The client sees a timeout but the data exists. Only an idempotent
 *     retry can recover it. This is the scenario that proves the submission queue
 *     is correct rather than merely present.
 *   • `unavailable_at_match_end` — `POST` fails while reads keep working, so the
 *     player finishes a match into a dead endpoint and must still be able to play.
 */

export type EndpointKind = 'ranking' | 'history' | 'submit' | 'any';
export type FailureMode =
  | 'none'
  | 'http-status'
  | 'timeout'
  | 'network-error'
  /** Persist the write, then hang without responding. */
  | 'commit-then-hang';

export interface FailureRule {
  readonly when: EndpointKind;
  readonly mode: FailureMode;
  readonly status?: number;
  /** 0..1, rolled against the scenario's seeded stream. */
  readonly probability: number;
}

export interface NetworkScenario {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly seed: number;
  readonly latency: { readonly minMs: number; readonly maxMs: number };
  /**
   * When true, the response delay is derived from a hash of the resource id, so
   * pages genuinely arrive out of order — not just "slowly".
   */
  readonly outOfOrder: boolean;
  readonly failures: readonly FailureRule[];
  /** Fixture record count, for exercising empty and multi-page states. */
  readonly fixtureCount: number;
  /** Extra latency applied only to writes. */
  readonly submitLatencyMs?: number;
}

const success: NetworkScenario = {
  id: 'success',
  label: 'Success (baseline)',
  description: 'Healthy API with a populated leaderboard. Latency 80 ms.',
  seed: 1,
  latency: { minMs: 80, maxMs: 80 },
  outOfOrder: false,
  failures: [],
  fixtureCount: 37,
};

export const SCENARIOS: readonly NetworkScenario[] = [
  success,

  {
    id: 'empty',
    label: 'Empty lists',
    description: 'A successful API with no records: exercises the empty state.',
    seed: 2,
    latency: { minMs: 60, maxMs: 120 },
    outOfOrder: false,
    failures: [],
    fixtureCount: 0,
  },

  {
    id: 'multi-page',
    label: 'Multiple pages',
    description: '37 records at 10 per page: exercises pagination and page jumps.',
    seed: 3,
    latency: { minMs: 90, maxMs: 140 },
    outOfOrder: false,
    failures: [],
    fixtureCount: 37,
  },

  {
    id: 'slow',
    label: 'Slow responses',
    description: 'A fixed 2.5 s delay on every request.',
    seed: 4,
    latency: { minMs: 2500, maxMs: 2500 },
    outOfOrder: false,
    failures: [],
    fixtureCount: 37,
  },

  {
    id: 'variable-latency',
    label: 'Variable latency',
    description: 'Seeded 100–4000 ms jitter: surfaces missing loading states.',
    seed: 5,
    latency: { minMs: 100, maxMs: 4000 },
    outOfOrder: false,
    failures: [],
    fixtureCount: 37,
  },

  {
    id: 'out-of-order',
    label: 'Out-of-order responses',
    description:
      'Delay is derived from a hash of each record id, so page 2 can arrive before page 1.',
    seed: 6,
    latency: { minMs: 50, maxMs: 300 },
    outOfOrder: true,
    failures: [],
    fixtureCount: 37,
  },

  {
    id: 'http-500',
    label: 'HTTP 500 (ranking)',
    description: 'The ranking endpoint returns 500; history keeps working.',
    seed: 7,
    latency: { minMs: 60, maxMs: 120 },
    outOfOrder: false,
    failures: [{ when: 'ranking', mode: 'http-status', status: 500, probability: 1 }],
    fixtureCount: 37,
  },

  {
    id: 'http-400',
    label: 'HTTP 400 (history)',
    description: 'The history endpoint returns a structured 400 validation error.',
    seed: 8,
    latency: { minMs: 60, maxMs: 120 },
    outOfOrder: false,
    failures: [{ when: 'history', mode: 'http-status', status: 400, probability: 1 }],
    fixtureCount: 37,
  },

  {
    id: 'history-error',
    label: 'Service unavailable (history)',
    description: 'History returns 503 UNAVAILABLE, the classic retryable outage.',
    seed: 9,
    latency: { minMs: 60, maxMs: 120 },
    outOfOrder: false,
    failures: [{ when: 'history', mode: 'http-status', status: 503, probability: 1 }],
    fixtureCount: 37,
  },

  {
    id: 'network-error',
    label: 'Connection failure',
    description: 'The request never reaches a server (offline).',
    seed: 10,
    latency: { minMs: 40, maxMs: 80 },
    outOfOrder: false,
    failures: [{ when: 'any', mode: 'network-error', probability: 1 }],
    fixtureCount: 37,
  },

  {
    id: 'timeout',
    label: 'Timeout',
    description: 'Requests hang forever; the client must time out on its own.',
    seed: 11,
    latency: { minMs: 0, maxMs: 0 },
    outOfOrder: false,
    failures: [{ when: 'any', mode: 'timeout', probability: 1 }],
    fixtureCount: 37,
  },

  {
    id: 'submit-commit-then-hang',
    label: 'Submit commits, then times out',
    description:
      'The record IS written but the response never arrives. Recovery is only possible via an idempotent retry — this is the scenario that proves the queue is correct.',
    seed: 12,
    latency: { minMs: 60, maxMs: 120 },
    outOfOrder: false,
    failures: [{ when: 'submit', mode: 'commit-then-hang', probability: 1 }],
    fixtureCount: 37,
  },

  {
    id: 'unavailable-at-match-end',
    label: 'Unavailable at match end',
    description:
      'Submission fails with 503 while reads keep working, so the player finishes a match into a dead endpoint. Playing on must remain possible.',
    seed: 13,
    latency: { minMs: 60, maxMs: 120 },
    outOfOrder: false,
    failures: [{ when: 'submit', mode: 'http-status', status: 503, probability: 1 }],
    fixtureCount: 37,
  },

  {
    id: 'flaky-chaos',
    label: 'Flaky chaos',
    description: 'Mixed seeded latency with a 30% failure rate on every endpoint.',
    seed: 14,
    latency: { minMs: 80, maxMs: 1200 },
    outOfOrder: true,
    failures: [
      { when: 'any', mode: 'http-status', status: 503, probability: 0.3 },
      { when: 'any', mode: 'network-error', probability: 0.1 },
    ],
    fixtureCount: 37,
  },
];

export const DEFAULT_SCENARIO_ID = success.id;

export const findScenario = (id: string): NetworkScenario =>
  SCENARIOS.find((scenario) => scenario.id === id) ?? success;

/**
 * Runtime state of the active scenario.
 *
 * Holds its own seeded stream, so successive latency draws differ while the whole
 * sequence stays reproducible.
 */
export class ScenarioRuntime {
  private scenario: NetworkScenario;
  private random: () => number;

  constructor(scenarioId: string = DEFAULT_SCENARIO_ID) {
    this.scenario = findScenario(scenarioId);
    this.random = mulberry32(this.scenario.seed);
  }

  get active(): NetworkScenario {
    return this.scenario;
  }

  /** Switching scenarios re-seeds, so a scenario replays identically. */
  setScenario(id: string): NetworkScenario {
    this.scenario = findScenario(id);
    this.random = mulberry32(this.scenario.seed);
    return this.scenario;
  }

  /** Seeded latency draw for a read. */
  readLatencyMs(resourceKey = ''): number {
    const { minMs, maxMs } = this.scenario.latency;
    if (this.scenario.outOfOrder && resourceKey !== '') {
      // Hash-based: stable per resource, so page 2 is reliably slower than page 1.
      const jitter = hashString(resourceKey) % Math.max(1, maxMs - minMs + 1);
      return minMs + jitter;
    }
    if (maxMs <= minMs) return minMs;
    return minMs + this.random() * (maxMs - minMs);
  }

  /**
   * The failure to apply to a request, or null.
   *
   * Rules are evaluated in declaration order and the first match wins, so a
   * scenario can express "history 503, everything else fine" precisely.
   */
  failureFor(endpoint: EndpointKind): FailureRule | null {
    const { failures } = this.scenario;
    for (const rule of failures) {
      if (rule.when !== endpoint && rule.when !== 'any') continue;
      if (rule.mode === 'none') continue;
      // p === 1 always fires, avoiding a stream draw and making it deterministic.
      if (rule.probability >= 1) return rule;
      if (this.random() < rule.probability) return rule;
    }
    return null;
  }
}

const hashString = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
};
