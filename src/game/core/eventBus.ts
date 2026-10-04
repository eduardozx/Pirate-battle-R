import type { GameEventMap, GameEventName } from './types';

type Listener<K extends GameEventName> = (payload: GameEventMap[K]) => void;

/**
 * Minimal typed pub/sub used as the one-way channel between the simulation and
 * everything outside it (renderers, audio, HUD store).
 *
 * The simulation emits; it never reaches into its listeners. That is what keeps
 * the rule engine free of rendering and React concerns.
 */
export class EventBus {
  private readonly listeners = new Map<GameEventName, Set<(payload: never) => void>>();

  on<K extends GameEventName>(event: K, listener: Listener<K>): () => void {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    const erased = listener as (payload: never) => void;
    bucket.add(erased);
    return () => {
      bucket?.delete(erased);
    };
  }

  emit<K extends GameEventName>(event: K, payload: GameEventMap[K]): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    for (const listener of bucket) {
      (listener as Listener<K>)(payload);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
