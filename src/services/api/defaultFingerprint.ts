import { buildGameConfig, DEFAULT_OPTIONS } from '../../store/optionsStore';
import { matchConfigSummary } from './configFingerprint';

/**
 * The fingerprint of a default, freshly-loaded match.
 *
 * Exists because the mock server and the client must agree on it EXACTLY, and
 * duplicating the derivation is how they drift:
 *
 *   • the client derives its filter from `optionsStore.toGameConfig()`, which runs
 *     the stored options through `buildGameConfig`;
 *   • the mock server must therefore seed fixtures with the same transformation,
 *     not with the raw `DEFAULT_GAME_CONFIG`.
 *
 * Getting this wrong produces a permanently empty ranking with no visible error:
 * the query succeeds, it just filters out every row. Sharing one function is the
 * only reliable fix.
 */
export const defaultConfigFingerprint = (): string =>
  matchConfigSummary(
    buildGameConfig(DEFAULT_OPTIONS),
    DEFAULT_OPTIONS.sessionSeconds,
    DEFAULT_OPTIONS.spawnIntervalSeconds,
  ).fingerprint;
