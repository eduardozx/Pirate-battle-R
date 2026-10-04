import { useCallback, useSyncExternalStore } from 'react';

import type { HudState } from '../game/core/gameSession';

/**
 * ============================================================================
 *  HUD STORE — React ⇄ simulation bridge
 * ============================================================================
 *
 * THE KEY IDEA OF THIS ENTIRE UI LAYOUT:
 *
 *   The Pixi ticker does NOT call setState. Ever.
 *
 * Instead the session pushes *coarse* state into a tiny external store, and
 * components subscribe through `useSyncExternalStore`. React therefore
 * re-renders only when a value a human could notice changes — roughly a few
 * dozen times across a 90-second match, instead of 60 times per second.
 *
 * `useSyncExternalStore` is used (rather than useState + useEffect) because it
 * guarantees tear-free reads under concurrent rendering and honours the store's
 * identity contract exactly.
 */

const EMPTY_STATE: HudState = {
  phase: 'booting',
  pauseReason: null,
  score: 0,
  remainingSeconds: 0,
  health: 0,
  maxHealth: 0,
  chasers: 0,
  shooters: 0,
  endReason: null,
  activePowerUp: null,
  activePowerUpRemainingMs: 0,
  shieldRemaining: 0,
};

export class HudStore {
  private state: HudState;
  private readonly listeners = new Set<() => void>();

  constructor(initialState?: Partial<HudState>) {
    this.state = { ...EMPTY_STATE, ...initialState };
  }

  /**
   * Called by the session. Notifies only on an actual change.
   *
   * DERIVED VALUES ARE DEFENSIVELY COERCED: the simulation publishes `remainingSeconds`
   * as `Math.ceil(...)`, which yields a float between two integers, and one NaN
   * leaking into the tree makes every string operation on it throw. Clamping here
   * keeps a bad frame from taking down the whole HUD.
   */
  publish = (next: HudState): void => {
    const safe: HudState = {
      ...next,
      remainingSeconds: finiteOr(next.remainingSeconds, 0),
      score: finiteOr(next.score, 0),
      health: finiteOr(next.health, 0),
      maxHealth: finiteOr(next.maxHealth, 1),
    };

    if (isEqual(this.state, safe)) return;
    this.state = safe;
    for (const listener of this.listeners) listener();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): HudState => this.state;
}

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

const isEqual = (a: HudState, b: HudState): boolean =>
  a.phase === b.phase &&
  a.pauseReason === b.pauseReason &&
  a.score === b.score &&
  a.remainingSeconds === b.remainingSeconds &&
  a.health === b.health &&
  a.maxHealth === b.maxHealth &&
  a.chasers === b.chasers &&
  a.shooters === b.shooters &&
  a.endReason === b.endReason &&
  a.activePowerUp === b.activePowerUp &&
  a.activePowerUpRemainingMs === b.activePowerUpRemainingMs &&
  a.shieldRemaining === b.shieldRemaining;

/** Subscribes a component to coarse HUD state. */
export const useHud = (store: HudStore): HudState =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

/**
 * Subscribes to a slice of HUD state.
 *
 * Provided for components that must not re-render on every coarse change —
 * for example the accessibility live region, which should not re-announce when
 * only the enemy count changes. Selectors must be referentially stable.
 */
export const useHudSelector = <T,>(
  store: HudStore,
  selector: (state: HudState) => T,
): T => {
  const getSelection = useCallback(() => selector(store.getSnapshot()), [store, selector]);
  return useSyncExternalStore(store.subscribe, getSelection, getSelection);
};
