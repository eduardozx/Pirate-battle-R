import { Disposables } from '../core/disposables';
import type { InputState } from '../core/types';

/**
 * Input intents.
 *
 * DOM events are translated into a tiny intent struct here and nowhere else.
 * Systems read intents, so they are trivially testable and completely decoupled
 * from keyboard/touch specifics.
 *
 * IMPORTANT (accessibility + spec §7): gameplay keys are captured ONLY while the
 * gameplay context is active. On menus, arrow keys and space keep their normal
 * meaning for navigation and button activation.
 */

export type ActionKey = 'forward' | 'turnLeft' | 'turnRight' | 'fireFront' | 'fireLeft' | 'fireRight';

const KEY_BINDINGS: Record<string, ActionKey> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyA: 'turnLeft',
  ArrowLeft: 'turnLeft',
  KeyD: 'turnRight',
  ArrowRight: 'turnRight',
  Space: 'fireFront',
  KeyJ: 'fireFront',
  KeyQ: 'fireLeft',
  KeyZ: 'fireLeft',
  KeyE: 'fireRight',
  KeyC: 'fireRight',
};

export const KEY_HINTS: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: 'W / ↑', action: 'Sail forward' },
  { keys: 'A D / ← →', action: 'Turn' },
  { keys: 'Space', action: 'Fire forward cannon' },
  { keys: 'Q', action: 'Fire left broadside (3 shots)' },
  { keys: 'E', action: 'Fire right broadside (3 shots)' },
  { keys: 'P / Esc', action: 'Pause' },
];

const createInputState = (): InputState => ({
  turn: 0,
  forward: false,
  fireFront: false,
  fireLeft: false,
  fireRight: false,
});

export class InputController {
  private readonly disposables = new Disposables();
  private readonly held = new Set<ActionKey>();
  private state: InputState = createInputState();
  private captureEnabled = false;

  constructor(private readonly target: EventTarget = window) {}

  /** Enables keyboard capture and starts listening. Safe to call twice. */
  attach(): void {
    if (this.disposables.isDisposed) throw new Error('InputController already disposed');

    const onKeyDown = (event: Event): void => {
      const keyboardEvent = event as KeyboardEvent;
      if (!this.captureEnabled) return;
      if (keyboardEvent.repeat) return;

      const action = KEY_BINDINGS[keyboardEvent.code];
      if (action === undefined) return;

      // Space/arrows would otherwise scroll the page behind the canvas.
      keyboardEvent.preventDefault();
      this.press(action);
    };

    const onKeyUp = (event: Event): void => {
      const keyboardEvent = event as KeyboardEvent;
      const action = KEY_BINDINGS[keyboardEvent.code];
      if (action === undefined) return;
      this.release(action);
    };

    // A lost focus must not leave a key stuck down.
    const onBlur = (): void => this.releaseAll();

    this.target.addEventListener('keydown', onKeyDown);
    this.target.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    this.disposables.add(() => {
      this.target.removeEventListener('keydown', onKeyDown);
      this.target.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    });
  }

  setCaptureEnabled(enabled: boolean): void {
    if (this.captureEnabled === enabled) return;
    this.captureEnabled = enabled;
    if (!enabled) this.releaseAll();
  }

  press(action: ActionKey): void {
    if (this.held.has(action)) return;
    this.held.add(action);
    this.recompute();
  }

  release(action: ActionKey): void {
    if (!this.held.delete(action)) return;
    this.recompute();
  }

  /** Used by on-screen touch buttons: true = held, false = released. */
  setVirtual(action: ActionKey, active: boolean): void {
    if (active) this.press(action);
    else this.release(action);
  }

  /**
   * Reads the current intents and clears the edge-triggered fire flags.
   *
   * Clearing here is what prevents "accumulated fire": a press made during a
   * pause is consumed by the very next step and cannot fire twice.
   */
  sample(): InputState {
    const sampled = this.state;
    this.state = {
      ...sampled,
      fireFront: false,
      fireLeft: false,
      fireRight: false,
    };
    return sampled;
  }

  /** Current intents without consuming edges. */
  peek(): InputState {
    return this.state;
  }

  releaseAll(): void {
    if (this.held.size === 0) return;
    this.held.clear();
    this.recompute();
  }

  dispose(): void {
    this.disposables.dispose();
    this.releaseAll();
  }

  private recompute(): void {
    const turn: -1 | 0 | 1 =
      this.held.has('turnLeft') && !this.held.has('turnRight')
        ? -1
        : this.held.has('turnRight') && !this.held.has('turnLeft')
          ? 1
          : 0;

    this.state = {
      turn,
      forward: this.held.has('forward'),
      fireFront: this.held.has('fireFront'),
      fireLeft: this.held.has('fireLeft'),
      fireRight: this.held.has('fireRight'),
    };
  }
}
