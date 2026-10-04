import type { InputState } from '../../src/game/core/types';

/** Neutral input: nothing pressed. Used as the baseline in most tests. */
export const IDLE_INPUT: InputState = {
  turn: 0,
  forward: false,
  fireFront: false,
  fireLeft: false,
  fireRight: false,
};

export const press = (partial: Partial<InputState>): InputState => ({ ...IDLE_INPUT, ...partial });
