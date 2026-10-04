import { expect, type Page } from '@playwright/test';

import type {
  TestCounters,
  TestIslandView,
  TestPlayerView,
  TestSnapshot,
} from '../../../src/game/testHook';
import { gotoMenu } from './app';

/**
 * Typed access to `window.__pbTest`, the simulation's DEV-only observation hook.
 *
 * WHY A HOOK AT ALL. The claims worth making here — "the hull stopped at the
 * island", "the cooldown swallowed the second press", "a self-destruct scored
 * nothing" — are claims about state React does not render. Reading them out of
 * the HUD means asserting against its rounding; asserting them off pixels is
 * slower and no more precise. The specs read the simulation directly instead.
 *
 * WHAT IT REFUSES TO DO. Nothing here mutates the world: there is no spawn, no
 * damage, no teleport. A spec gets time (`advance`) and counters, so a green
 * test still proves the game plays by its own rules.
 *
 * Every helper fails at the cause with a legible message when the hook is
 * absent, rather than returning undefined for an assertion to trip over later.
 * (The messages live inside the callbacks because `page.evaluate` ships source
 * to the browser, not this module's scope.)
 */

export const readSnapshot = (page: Page): Promise<TestSnapshot> =>
  page.evaluate(() => {
    const hook = window.__pbTest;
    if (hook === undefined) {
      throw new Error('window.__pbTest is absent — start the match with startMatch() first');
    }
    return hook.snapshot();
  });

export const readCounters = (page: Page): Promise<TestCounters> =>
  page.evaluate(() => {
    const hook = window.__pbTest;
    if (hook === undefined) {
      throw new Error('window.__pbTest is absent — start the match with startMatch() first');
    }
    return hook.counters();
  });

export const resetCounters = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const hook = window.__pbTest;
    if (hook === undefined) {
      throw new Error('window.__pbTest is absent — start the match with startMatch() first');
    }
    hook.resetCounters();
  });

/**
 * Runs the simulation forward by `simMs`, in loop-sized slices.
 *
 * This is what keeps the suite honest about time: "it reached the wall" is a
 * statement about the game's clock, not about how fast the CI box happens to
 * be. The real rAF loop still runs alongside, so assertions that depend on an
 * exact distance are written with tolerance for a few extra milliseconds.
 */
export const advance = (page: Page, simMs: number): Promise<void> =>
  page.evaluate((ms) => {
    const hook = window.__pbTest;
    if (hook === undefined) {
      throw new Error('window.__pbTest is absent — start the match with startMatch() first');
    }
    hook.advance(ms);
  }, simMs);

export const hookInstalled = (page: Page): Promise<boolean> =>
  page.evaluate(() => window.__pbTest !== undefined);

const waitForHook = async (page: Page): Promise<void> => {
  await expect.poll(() => hookInstalled(page), { timeout: 20_000, intervals: [100] }).toBe(true);
};

/** The player entity, or a failure that says which snapshot was missing it. */
export const thePlayer = (snapshot: TestSnapshot): TestPlayerView => {
  if (snapshot.player === null) {
    throw new Error(`no player entity in snapshot (phase: ${snapshot.phase})`);
  }
  return snapshot.player;
};

/** An island by id, or a failure naming what the arena did contain. */
export const theIsland = (snapshot: TestSnapshot, id: string): TestIslandView => {
  const island = snapshot.islands.find((candidate) => candidate.id === id);
  if (island === undefined) {
    throw new Error(`island "${id}" not in arena (has: ${snapshot.islands.map((i) => i.id).join(', ')})`);
  }
  return island;
};

/** True when the hull's centre sits inside one of the island's solid tiles. */
export const insideSolid = (
  snapshot: TestSnapshot,
  hull: TestPlayerView,
): string | null => {
  for (const island of snapshot.islands) {
    for (const solid of island.solids) {
      const inside =
        hull.x > solid.x &&
        hull.x < solid.x + solid.width &&
        hull.y > solid.y &&
        hull.y < solid.y + solid.height;
      if (inside) return `${island.id} solid (${solid.x}, ${solid.y})`;
    }
  }
  return null;
};

/** Loads the menu, starts a match and returns the first snapshot of it. */
export const startMatch = async (page: Page, url = '/'): Promise<TestSnapshot> => {
  await gotoMenu(page, url);
  await page.getByTestId('play-button').click();
  await expect(page.getByTestId('hud')).toBeVisible();
  await waitForHook(page);
  await expect
    .poll(async () => (await readSnapshot(page)).phase, { timeout: 15_000, intervals: [100] })
    .toBe('running');
  return readSnapshot(page);
};

/**
 * Holds a control for `simMs` of simulated time and then releases it.
 *
 * The hold is measured in simulation time, not wall time: a substep only sees
 * held input, so a press shorter than one substep would fire nothing at all on
 * a fast machine and everything on a slow one.
 */
export const hold = async (page: Page, key: string, simMs: number): Promise<void> => {
  await page.keyboard.down(key);
  await advance(page, simMs);
  await page.keyboard.up(key);
};

export type InputStep =
  | { readonly kind: 'press'; readonly code: string; readonly holdMs: number }
  | { readonly kind: 'wait'; readonly simMs: number };

/** State of the world after one scripted step. */
export interface InputStepOutcome {
  readonly snapshot: TestSnapshot;
  readonly counters: TestCounters;
}

/**
 * A press of the key whose `event.code` is `code` — `Space`, `KeyQ`, `ArrowUp`.
 * The browser's code, not its `key`: that is what the input controller matches.
 */
export const press = (code: string, holdMs = 60): InputStep => ({
  kind: 'press',
  code,
  holdMs,
});

/** `simMs` of simulated time with no input change. */
export const wait = (simMs: number): InputStep => ({ kind: 'wait', simMs });

/**
 * Runs a scripted sequence of presses and simulated gaps in ONE call into the
 * page, returning the snapshot and counters after each step.
 *
 * WHY NOT `page.keyboard`. Each Playwright round trip costs real time — around
 * 100 ms here — and the simulation clock FOLLOWS real time. By the time a second
 * press could be issued, the front cannon's 380 ms cooldown would already have
 * expired and the assertion would be proving nothing. Inside a single
 * `evaluate` the browser's own frame loop cannot run, so the only time that
 * passes is the time the script asks for, and the result does not depend on how
 * loaded the machine is.
 *
 * WHAT THE EVENTS ARE. The same `keydown`/`keyup` with the same `event.code`
 * the real input controller consumes — it looks up `event.code`, ignores
 * repeats and never checks `isTrusted`, so this exercises the genuine input
 * path, just without the network latency wrapped around it.
 */
export const scriptInputs = (
  page: Page,
  steps: readonly InputStep[],
): Promise<readonly InputStepOutcome[]> =>
  page.evaluate((script) => {
    const hook = window.__pbTest;
    if (hook === undefined) {
      throw new Error('window.__pbTest is absent — start the match with startMatch() first');
    }
    const key = (type: 'keydown' | 'keyup', code: string): void => {
      window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
    };

    const trail: InputStepOutcome[] = [];
    for (const step of script) {
      if (step.kind === 'press') {
        key('keydown', step.code);
        hook.advance(step.holdMs);
        key('keyup', step.code);
      } else {
        hook.advance(step.simMs);
      }
      trail.push({ snapshot: hook.snapshot(), counters: hook.counters() });
    }
    return trail;
  }, steps);

/**
 * Holds a rudder until the heading reaches `targetAngle`, then releases it.
 *
 * WHY NOT `hold(page, 'ArrowRight', ms)`. A fixed hold in milliseconds lands
 * the bow wherever the machine's frame rate happens to put it — on a slow run
 * the hull turns far enough to slide down a channel and around the very island
 * the test means to drive into. Turning to a KNOWN HEADING makes direction an
 * input to the test rather than a by-product of load, which is the only reason
 * these specs can assert geometry at all.
 *
 * Returns the heading actually reached: within one 20 ms step of the target,
 * with the browser's loop unable to run while this call is in flight.
 */
export const turnTo = (page: Page, targetAngle: number): Promise<number> =>
  page.evaluate((target) => {
    const hook = window.__pbTest;
    if (hook === undefined) {
      throw new Error('window.__pbTest is absent — start the match with startMatch() first');
    }
    const heading = (): number => hook.snapshot().player?.angle ?? Number.NaN;
    const key = (type: 'keydown' | 'keyup', code: string): void => {
      window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
    };

    key('keydown', 'ArrowRight');
    let angle = heading();
    /* The guard bounds the loop even against a wrapped heading: 2 000 steps of
       20 ms is forty seconds of simulation, far more than any turn in here. */
    for (let step = 0; step < 2_000 && Number.isFinite(angle) && angle < target; step += 1) {
      hook.advance(20);
      angle = heading();
    }
    key('keyup', 'ArrowRight');
    return angle;
  }, targetAngle);

/**
 * Holds one pad button for exactly `holdMs` of SIMULATION time, then releases it.
 *
 * WHY ONE EVALUATE, as with `scriptInputs` above. A Playwright round trip costs
 * ~100 ms of wall time, the simulation clock follows wall time, and the button is
 * pressed for every millisecond of it — so a "400 ms" hold arrives as anywhere
 * between 400 and 700 ms depending on load, which is the difference between a
 * heading assertion and a coin toss. Dispatching the pointer events and stepping
 * the clock inside a single call makes the hold exact.
 *
 * The events are the ones the pad actually listens for, dispatched at the real
 * button: React's handler runs synchronously during dispatch, so the input is
 * held before the first slice of simulation is stepped. Nothing is mutated — the
 * game is driven through its own controls, exactly as a finger would.
 */
export const holdPad = (page: Page, label: string, holdMs: number): Promise<TestSnapshot> =>
  page.evaluate(
    ({ buttonLabel, ms }) => {
      const hook = window.__pbTest;
      if (hook === undefined) {
        throw new Error('window.__pbTest is absent — start the match with startMatch() first');
      }
      const buttons = Array.from(document.querySelectorAll('button'));
      const button = buttons.find((candidate) => candidate.getAttribute('aria-label') === buttonLabel);
      if (button === undefined) {
        const labels = buttons
          .map((candidate) => candidate.getAttribute('aria-label'))
          .filter((candidate): candidate is string => candidate !== null)
          .join(', ');
        throw new Error(`no button labelled "${buttonLabel}" (on screen: ${labels})`);
      }

      const point = (type: 'pointerdown' | 'pointerup'): void => {
        button.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true }));
      };
      point('pointerdown');
      hook.advance(ms);
      point('pointerup');
      return hook.snapshot();
    },
    { buttonLabel: label, ms: holdMs },
  );

/**
 * The signed difference between two headings, folded into (-π, π].
 *
 * Headings live in [-π, π] and wrap at the seam, so a raw subtraction lies: a
 * hull turned far enough to cross −π reports a LARGER number than it started
 * with, and "the heading decreased" then reads as the exact opposite of what
 * happened. Folding first is what lets a spec say "it turned left" without
 * caring where on the circle the turn began or ended.
 */
export const headingDelta = (to: number, from: number): number => {
  const delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) return delta - Math.PI * 2;
  if (delta < -Math.PI) return delta + Math.PI * 2;
  return delta;
};

/**
 * Holds one key for exactly `simMs` of simulation time, sampling the hull's
 * position every `stepMs` along the way — all inside a single evaluate.
 *
 * WHY THE PATH AND NOT THE DESTINATION. A drive made of separate round trips is
 * measured in machine time as well as simulation time: the real loop keeps
 * stepping while Playwright travels, so a loaded box adds distance the test
 * never asked for, and the hull ends up somewhere the assertion never intended
 * to describe. Sampling inside the call also makes the samples dense: at one
 * sample per 50 ms a hull cannot cross a 64-unit tile between two of them, which
 * is what lets a spec claim "it never entered the land" rather than "it was
 * outside the land at the four moments I happened to look".
 */
export const drive = (
  page: Page,
  code: string,
  simMs: number,
  stepMs = 50,
): Promise<readonly { readonly x: number; readonly y: number }[]> =>
  page.evaluate(
    ({ key, total, step }) => {
      const hook = window.__pbTest;
      if (hook === undefined) {
        throw new Error('window.__pbTest is absent — start the match with startMatch() first');
      }
      const send = (type: 'keydown' | 'keyup'): void => {
        window.dispatchEvent(new KeyboardEvent(type, { code: key, bubbles: true, cancelable: true }));
      };

      send('keydown');
      const path: { x: number; y: number }[] = [];
      for (let elapsed = 0; elapsed < total; elapsed += step) {
        hook.advance(step);
        const hull = hook.snapshot().player;
        if (hull !== null) path.push({ x: hull.x, y: hull.y });
      }
      send('keyup');
      return path;
    },
    { key: code, total: simMs, step: stepMs },
  );
