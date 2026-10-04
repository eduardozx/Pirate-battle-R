import { setupWorker } from 'msw/browser';

import { ensureSeeded, handlers, scenarioRuntime } from './handlers';
import { mockDb } from './db';
import { SCENARIOS } from './scenarios';

/**
 * MSW starts in the BROWSER, in every environment including production.
 *
 * The brief requires the published build to run the mocks and to work standalone
 * with no private services. So the worker is registered unconditionally and
 * `onUnhandledRequest: 'bypass'` lets genuinely unrelated requests (fonts, the
 * app's own assets) through untouched.
 */

let started = false;

export interface MswStartup {
  readonly started: boolean;
  readonly error: Error | null;
}

export const startMockServer = async (): Promise<MswStartup> => {
  if (started) return { started: true, error: null };
  started = true;

  ensureSeeded();

  try {
    const worker = setupWorker(...handlers);
    await worker.start({
      onUnhandledRequest: 'bypass',
      serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
      quiet: true,
    });
    return { started: true, error: null };
  } catch (error) {
    // A failed mock server must never be fatal: only the ranking and history tabs
    // depend on it, never the game itself.
    console.warn('[msw] could not start the mock server', error);
    return { started: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
};

/**
 * Switches the active scenario and re-seeds fixtures if the record count changed.
 *
 * @returns the newly active scenario id.
 */
export const selectScenario = (id: string): string => {
  const scenario = scenarioRuntime.setScenario(id);
  ensureSeeded();
  mockDb.flushPersist();
  return scenario.id;
};

/** Restores the initial mock state: default scenario, seeded fixtures, no records. */
export const resetMockServer = (): void => {
  scenarioRuntime.setScenario(SCENARIOS[0]?.id ?? 'success');
  mockDb.reset();
  ensureSeeded();
  mockDb.flushPersist();
};

export { SCENARIOS, mockDb };
