import { useCallback, useSyncExternalStore } from 'react';

import {
  DEFAULT_GAME_CONFIG,
  type ArenaConfig,
  type GameConfig,
} from '../game/config/gameConfig';

/**
 * ============================================================================
 *  OPTIONS STORE — locally persisted player settings
 * ============================================================================
 *
 * Every match snapshots these values at start, so changing an option mid-match
 * can never alter the running game (spec requirement). The store is a plain
 * external store for the same reason as the HUD store: no provider, no
 * context, no cascading re-renders.
 */

const STORAGE_KEY = 'pb.options.v1';

export interface GameOptions {
  /** Total active match duration, 60–180 seconds. */
  readonly sessionSeconds: number;
  /** Seconds between enemy spawns. */
  readonly spawnIntervalSeconds: number;
}

export const OPTIONS_LIMITS = {
  sessionSeconds: {
    min: 60,
    max: 180,
    step: 15,
    default: DEFAULT_GAME_CONFIG.match.durationSeconds,
  },
  spawnIntervalSeconds: {
    min: 0.5,
    max: 10,
    step: 0.5,
    default: 3,
  },
} as const;

export type OptionField = keyof GameOptions;
export type OptionErrors = Partial<Record<OptionField, string>>;

export const DEFAULT_OPTIONS: GameOptions = {
  sessionSeconds: OPTIONS_LIMITS.sessionSeconds.default,
  spawnIntervalSeconds: OPTIONS_LIMITS.spawnIntervalSeconds.default,
};

/** Validates a single field. Returns an error message, or null when valid. */
export function validateOption(field: OptionField, rawValue: number | string): string | null {
  const value = typeof rawValue === 'number' ? rawValue : Number.parseFloat(rawValue);

  if (rawValue === '' || Number.isNaN(value)) {
    return 'Enter a number.';
  }
  if (value <= 0) {
    return 'Must be greater than zero.';
  }

  const limits = OPTIONS_LIMITS[field];
  if (value < limits.min || value > limits.max) {
    return `Must be between ${limits.min} and ${limits.max}.`;
  }
  return null;
}

/** Builds a match-ready config from the player's options. */
/**
 * Builds the match configuration from player options.
 *
 * The test seam is applied AFTER clamping, and deliberately so. Player options are
 * always clamped to the documented limits; a seam value exists precisely to sit
 * outside them, so clamping first would silently discard it and every spec would
 * wait out a full-length match.
 */
export function buildGameConfig(options: GameOptions, base: GameConfig = DEFAULT_GAME_CONFIG): GameConfig {
  const overrides = testMatchOverrides();

  const durationSeconds = overrides.durationSeconds ?? clampToLimits('sessionSeconds', options.sessionSeconds);
  const minIntervalSeconds = overrides.minSpawnIntervalSeconds ?? clampToLimits('spawnIntervalSeconds', options.spawnIntervalSeconds);

  return {
    ...base,
    match: {
      ...base.match,
      durationSeconds,
    },
    spawn: {
      ...base.spawn,
      minIntervalSeconds,
      maxIntervalSeconds: minIntervalSeconds * 1.6,
    },
    powerUps: {
      ...base.powerUps,
      pickupRadius: overrides.powerUpPickupRadius ?? base.powerUps.pickupRadius,
      minPlayerDistance: overrides.powerUpMinDistance ?? base.powerUps.minPlayerDistance,
    },
  };
}

/**
 * End-to-end test seam: `?sessionSeconds=6&spawnIntervalSeconds=1`.
 *
 * WHY IT EXISTS. The shortest session a player may choose is 60 seconds.
 * Verifying submission and idempotency needs several COMPLETED matches, so a spec
 * built on real time would spend minutes idling and would drift under machine
 * load — and a timing-sensitive suite is a suite that eventually gets ignored.
 *
 * WHY IT IS SAFE. The branch is compiled out of production builds: `import.meta.env.DEV`
 * is statically `false` there, so the parameters never reach a shipped bundle and a
 * player cannot shorten a match.
 *
 * WHY IT BYPASSES THE LIMITS. See `buildGameConfig`. Clamping to the player-facing
 * minimum would discard the override, which is the one thing it exists to do.
 */
interface TestMatchOverrides {
  readonly durationSeconds?: number;
  readonly minSpawnIntervalSeconds?: number;
  readonly powerUpPickupRadius?: number;
  readonly powerUpMinDistance?: number;
}

const testMatchOverrides = (): TestMatchOverrides => {
  if (!import.meta.env.DEV) return {};
  if (typeof location === 'undefined') return {};

  const params = new URLSearchParams(location.search);
  const overrides: { -readonly [K in keyof TestMatchOverrides]?: number } = {};

  const session = Number(params.get('sessionSeconds'));
  if (Number.isFinite(session) && session > 0) overrides.durationSeconds = session;

  const spawn = Number(params.get('spawnIntervalSeconds'));
  if (Number.isFinite(spawn) && spawn > 0) overrides.minSpawnIntervalSeconds = spawn;

  const pickupRadius = Number(params.get('powerUpPickupRadius'));
  if (Number.isFinite(pickupRadius) && pickupRadius > 0) overrides.powerUpPickupRadius = pickupRadius;

  /* Zero is meaningful here: it is what puts a crate next to a stationary ship. */
  const minDistance = Number(params.get('powerUpMinDistance'));
  if (Number.isFinite(minDistance) && minDistance >= 0) overrides.powerUpMinDistance = minDistance;

  return overrides;
};

function clampToLimits(field: OptionField, value: number): number {
  const limits = OPTIONS_LIMITS[field];
  return Math.min(limits.max, Math.max(limits.min, value));
}

function readStoredOptions(): GameOptions {
  if (typeof localStorage === 'undefined') return DEFAULT_OPTIONS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_OPTIONS;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_OPTIONS;

    const record = parsed as Record<string, unknown>;
    return {
      sessionSeconds: sanitise('sessionSeconds', record['sessionSeconds']),
      spawnIntervalSeconds: sanitise('spawnIntervalSeconds', record['spawnIntervalSeconds']),
    };
  } catch {
    // Corrupt or unavailable storage must never block the game.
    return DEFAULT_OPTIONS;
  }
}

/** Storage is untrusted input: clamp on read, exactly as we validate on write. */
function sanitise(field: OptionField, value: unknown): number {
  const limits = OPTIONS_LIMITS[field];
  if (typeof value !== 'number' || Number.isNaN(value)) return limits.default;
  return Math.min(limits.max, Math.max(limits.min, value));
}

export class OptionsStore {
  private options: GameOptions = readStoredOptions();

  private readonly listeners = new Set<() => void>();

  getSnapshot = (): GameOptions => this.options;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Validated write. Returns the validation error, or null on success. */
  set(field: OptionField, rawValue: number | string): string | null {
    const error = validateOption(field, rawValue);
    if (error !== null) return error;

    const value = typeof rawValue === 'number' ? rawValue : Number.parseFloat(rawValue);
    if (this.options[field] === value) return null;

    this.options = { ...this.options, [field]: value };
    this.persist();
    for (const listener of this.listeners) listener();
    return null;
  }

  reset(): void {
    this.options = DEFAULT_OPTIONS;
    this.persist();
    for (const listener of this.listeners) listener();
  }

  /** Config for a NEW match. Existing matches keep the snapshot they started with. */
  toGameConfig(base?: GameConfig, arena?: Partial<ArenaConfig>): GameConfig {
    const config = buildGameConfig(this.options, base);
    return arena === undefined ? config : { ...config, arena: { ...config.arena, ...arena } };
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.options));
    } catch {
      // Private browsing / quota: options simply do not survive a refresh.
    }
  }
}

export const useOptions = (store: OptionsStore): GameOptions =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

/** Stable action creators so components don't re-create callbacks each render. */
export const useOptionsActions = (store: OptionsStore) => ({
  setField: useCallback(
    (field: OptionField, value: number | string) => store.set(field, value),
    [store],
  ),
  reset: useCallback(() => store.reset(), [store]),
});
