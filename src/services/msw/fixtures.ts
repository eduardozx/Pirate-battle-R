import { DEFAULT_GAME_CONFIG } from '../../game/config/gameConfig';
import type { MatchRecordDto } from '../api/contracts';
import { buildTestConfigLike } from './fixtureConfig';

/**
 * Deterministic fixtures.
 *
 * "Other players are represented by fixtures" (brief §5), so this module is the
 * synthetic leaderboard. It is generated from a SEEDED PRNG, never
 * `Math.random()`: the same seed must produce the same table on every machine and
 * every reload, otherwise a visual-regression baseline would be meaningless.
 */

const FIXTURE_PLAYERS = [
  'Redbeard', 'Iron Keel', 'Saltfang', 'Black Wake', 'Stormpetrel',
  'Gallows Reach', 'Kraken', 'Bosun', 'Silver Tide', 'Cutlass',
  'Dead Reckoning', 'Long John',
] as const;

/** Fixed names + fixed scores beat randomness for a stable baseline. */
const FIXTURE_SCORES = [
  41, 38, 35, 33, 31, 29, 27, 25, 24, 22, 19, 17,
] as const;

const mulberry32 = (seed: number): (() => number) => {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Stable pseudo-id, so fixtures never collide with real UUIDs. */
const fixtureId = (index: number): string => `fixture-${index.toString().padStart(3, '0')}`;

export interface FixtureOptions {
  readonly count: number;
  readonly configFingerprint: string;
  readonly seed?: number;
  /** Base timestamp; all fixture dates are derived from it deterministically. */
  readonly baseIso?: string;
}

/**
 * Builds a leaderboard of synthetic matches.
 *
 * Scores descend, and durations are drawn to be plausible for that score, so the
 * table looks like real play rather than random noise.
 */
export const buildFixtureMatches = ({
  count,
  configFingerprint,
  seed = 0xc0ffee,
  baseIso = '2026-09-01T10:00:00.000Z',
}: FixtureOptions): readonly MatchRecordDto[] => {
  const random = mulberry32(seed);
  const baseTime = Date.parse(baseIso);
  const config = buildTestConfigLike();

  const out: MatchRecordDto[] = [];
  for (let i = 0; i < count; i += 1) {
    const score = FIXTURE_SCORES[i % FIXTURE_SCORES.length] ?? 10;
    const playerIndex = i % FIXTURE_PLAYERS.length;
    const playerName = FIXTURE_PLAYERS[playerIndex] ?? 'Sailor';

    // Plausible duration: higher scores took longer, with seeded jitter.
    const durationMs = Math.round((28_000 + score * 1_450 + random() * 9_000) / 1) ;

    out.push({
      matchId: fixtureId(i),
      playerId: `player-${playerIndex}`,
      playerName,
      score,
      effectiveDurationMs: durationMs,
      // Most fixtures die; a couple survive the clock.
      endReason: i % 5 === 0 ? 'time_expired' : 'player_destroyed',
      configFingerprint,
      configSnapshot: config,
      finishedAtIso: new Date(baseTime - i * 3_600_000).toISOString(),
      seed: (seed + i) >>> 0,
    });
  }

  return out;
};

/** Config used by fixtures, so their payload shape matches a real submission. */
export const FIXTURE_CONFIG = DEFAULT_GAME_CONFIG;
