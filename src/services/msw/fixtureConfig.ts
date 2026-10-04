import type { GameConfigSnapshot } from '../../game/config/gameConfig';
import { DEFAULT_GAME_CONFIG } from '../../game/config/gameConfig';

/**
 * A deep-cloned, structurally complete config for fixtures.
 *
 * Fixtures must satisfy the SAME `GameConfigSnapshot` type as real submissions.
 * Sharing the frozen default object would mean a later tuning change silently
 * rewrites historical fixture payloads, so the shape is cloned here instead.
 */
export const buildTestConfigLike = (): GameConfigSnapshot =>
  structuredClone(DEFAULT_GAME_CONFIG) as GameConfigSnapshot;
