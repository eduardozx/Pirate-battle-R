import { DEFAULT_GAME_CONFIG, type GameConfig } from '../../src/game/config/gameConfig';

/**
 * Test configuration factory.
 *
 * Tests need matches that finish quickly and spawn predictably, so each one
 * declares only what it cares about. Anything not specified keeps the production
 * balance value, which means a test can never accidentally pass against a
 * different tuning than the game ships with.
 */

export interface TestConfigOverrides {
  /** 60–180 in production; tests may shorten it to keep runs fast. */
  readonly sessionSeconds?: number;
  /** Large values effectively disable spawning. */
  readonly spawnIntervalSeconds?: number;
}

export const buildTestConfig = (
  overrides: TestConfigOverrides = {},
  base: GameConfig = DEFAULT_GAME_CONFIG,
): GameConfig => {
  const spawnInterval = overrides.spawnIntervalSeconds ?? base.spawn.minIntervalSeconds;

  return {
    ...base,
    match: {
      ...base.match,
      durationSeconds: overrides.sessionSeconds ?? base.match.durationSeconds,
    },
    spawn: {
      ...base.spawn,
      // A fixed interval makes spawn timing assertions exact rather than
      // probabilistic, which is what makes the spawn tests meaningful.
      minIntervalSeconds: spawnInterval,
      maxIntervalSeconds: spawnInterval,
    },
  };
};
