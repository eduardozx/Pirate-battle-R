import type { PowerUpDefinition } from './powerUpCatalog';

/**
 * ============================================================================
 *  POWER-UP LIFECYCLE — State Pattern
 * ============================================================================
 *
 * Each lifecycle phase is a separate object with its own behaviour. Adding a
 * phase (say, `Decaying` for a visual wind-down) means adding one class and one
 * transition — no `switch` statement to grow, and no conditional pile-up in the
 * update loop.
 *
 * Transitions are declared by the state that owns them, so the legal graph is
 * visible at a glance and an illegal transition is impossible to express: a
 * consumed power-up has no `tick`, so it cannot be ticked.
 *
 * Allocation discipline: transitions return the SAME singleton instances, and
 * `tick` receives a mutable context rather than allocating a result object. A
 * three-minute match therefore performs zero allocations in this subsystem.
 */

export type PowerUpPhase = 'drifting' | 'collecting' | 'active' | 'expiring' | 'spent';

export interface PowerUpContext {
  /** Simulation time (ms) at which the current phase began. */
  phaseStartedAtMs: number;
  /** Simulation time (ms) at which the whole power-up expires. */
  expiresAtMs: number;
  /** Remaining ms for timed power-ups; 0 for consumables. */
  remainingMs: number;
  /**
   * Whether this instance is a consumable.
   *
   * The state machine needs it to pick the right transition on collection: a
   * consumable has no active phase and must go straight to `spent`, while a timed
   * one becomes `active`. Without it, a consumable would have to start in `spent`
   * — and `spent` is not collectable, so the pickup would be unreachable.
   */
  isConsumable: boolean;
  /**
   * How long the EFFECT lasts once collected, in ms.
   *
   * Kept separate from `expiresAtMs` on purpose. A crate drifting on the water and
   * the bonus it grants are different quantities: if they share one timer, a crate
   * that spawns 1 100 units away is gone after 8 seconds — before a ship covering
   * ~165 units per second could plausibly reach it. The pickup would exist only as
   * decoration.
   */
  effectDurationMs: number;
}

export interface PowerUpState {
  readonly phase: PowerUpPhase;
  readonly isCollectable: boolean;
  readonly isVisible: boolean;
  /** Advances the context. Returns the next state. */
  tick(context: PowerUpContext, nowMs: number): PowerUpState;
  /** Handles contact with the player. Returns the next state. */
  collect(context: PowerUpContext, nowMs: number): PowerUpState;
}

/** Power-up is on the water, waiting to be sailed over. */
class DriftingState implements PowerUpState {
  readonly phase = 'drifting' as const;
  readonly isCollectable = true;
  readonly isVisible = true;

  tick(context: PowerUpContext, nowMs: number): PowerUpState {
    return context.expiresAtMs <= nowMs ? SPENT : DRIFTING;
  }

  collect(context: PowerUpContext, nowMs: number): PowerUpState {
    context.phaseStartedAtMs = nowMs;

    // From here the effect's own duration governs, not the crate's.
    context.expiresAtMs = nowMs + context.effectDurationMs;
    context.remainingMs = context.effectDurationMs;

    // A consumable has no active phase: the effect applies at the moment of
    // collection, so it goes straight to the terminal state.
    if (context.isConsumable) return SPENT;
    return context.effectDurationMs <= 0 ? SPENT : ACTIVE;
  }
}

/** Being pulled toward the ship. Cosmetic beat before the effect applies. */
class CollectingState implements PowerUpState {
  readonly phase = 'collecting' as const;
  readonly isCollectable = false;
  readonly isVisible = true;

  private readonly durationMs = 180;

  tick(context: PowerUpContext, nowMs: number): PowerUpState {
    if (nowMs - context.phaseStartedAtMs >= this.durationMs) return ACTIVE;
    return context.expiresAtMs <= nowMs ? SPENT : COLLECTING;
  }

  collect(): PowerUpState {
    return COLLECTING;
  }
}

/** Effect is live. */
class ActiveState implements PowerUpState {
  readonly phase = 'active' as const;
  readonly isCollectable = false;
  readonly isVisible = false;

  tick(context: PowerUpContext, nowMs: number): PowerUpState {
    if (context.remainingMs <= 0) return SPENT;
    if (context.remainingMs <= EXPIRING_WINDOW_MS) return EXPIRING;
    if (context.expiresAtMs <= nowMs) return SPENT;
    return ACTIVE;
  }

  collect(): PowerUpState {
    return ACTIVE;
  }
}

/** Final stretch: flashing before it wears off. */
class ExpiringState implements PowerUpState {
  readonly phase = 'expiring' as const;
  readonly isCollectable = false;
  readonly isVisible = false;

  tick(context: PowerUpContext, nowMs: number): PowerUpState {
    return context.expiresAtMs <= nowMs ? SPENT : EXPIRING;
  }

  collect(): PowerUpState {
    return EXPIRING;
  }
}

/** Terminal state. Never leaves, and cannot be ticked back into play. */
class SpentState implements PowerUpState {
  readonly phase = 'spent' as const;
  readonly isCollectable = false;
  readonly isVisible = false;

  tick(): PowerUpState {
    return SPENT;
  }

  collect(): PowerUpState {
    return SPENT;
  }
}

const EXPIRING_WINDOW_MS = 2_500;

/**
 * Singletons. States hold no per-instance data, so one instance each is correct
 * and removes an allocation from every transition.
 */
/*
 * Typed as the INTERFACE, not as the concrete class.
 *
 * Several states ignore the context they are handed — `SpentState.tick()` needs
 * nothing — so their class signatures take no parameters. Exposing the class type
 * would make the public API demand zero arguments in some states and two in
 * others, and a caller would have to know which is which. The interface gives every
 * state one uniform signature.
 */
export const DRIFTING: PowerUpState = new DriftingState();
export const COLLECTING: PowerUpState = new CollectingState();
export const ACTIVE: PowerUpState = new ActiveState();
export const EXPIRING: PowerUpState = new ExpiringState();
export const SPENT: PowerUpState = new SpentState();

export const INITIAL_STATE: PowerUpState = DRIFTING;

/**
 * Chooses the first state for a freshly spawned power-up.
 *
 * Every power-up starts by drifting, INCLUDING consumables. Starting a consumable
 * in `spent` looks like a shortcut but makes it uncollectable, because `spent` is
 * terminal and reports `isCollectable: false` — the crate would sink and vanish
 * without ever being picked up. The consumable/timed distinction is resolved on
 * the collect transition instead, where the context knows which it is.
 */
export const initialStateFor = (_definition: PowerUpDefinition): PowerUpState => DRIFTING;
