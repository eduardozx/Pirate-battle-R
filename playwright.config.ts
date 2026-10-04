import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * WHY THE DEV SERVER, NOT `preview`. The mocked API is part of the application, so
 * a production build and a dev build exercise the same code paths. Testing the dev
 * server keeps the `?sessionSeconds=` test seam available (it is compiled out of
 * production builds) and makes failures report against readable source.
 *
 * PARALLELISM IS SAFE HERE. The mock database lives in `localStorage`, and every
 * test gets a fresh browser context, so no test can observe another test's
 * matches. Each spec is genuinely independent.
 */
const PORT = 5173;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',

  /* A spec that plays a match legitimately takes tens of seconds. The default
     expect budget is raised for the same reason: a failed revalidation retries
     with exponential backoff before surfacing, which is measured in seconds. */
  timeout: 120_000,
  expect: { timeout: 30_000 },

  /* One retry is enough to absorb a loaded CI machine; a test that fails twice
     is a real failure, and retrying more only hides it. */
  retries: process.env.CI ? 1 : 0,

  /* Fail the build on flakiness, not just on failures. A suite nobody trusts is
     worse than no suite. */
  forbidOnly: !!process.env.CI,

  fullyParallel: true,

  /**
   * Deliberately few workers.
   *
   * The simulation advances with the render loop and the loop refuses to catch up
   * in a burst — correct for a game, but it means simulation time runs slower than
   * wall time whenever frames are starved. Several specs run REAL matches, and
   * their assertions are about simulation time. Under four concurrent WebGL
   * contexts that starved hard enough to fail assertions which pass every time in
   * isolation, which is the worst failure mode there is: it teaches the team to
   * re-run "flaky" tests and stop believing the suite.
   *
   * Two workers keeps frame timing honest. The suite takes longer and stops
   * producing ghosts.
   */
  workers: 2,

  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],

  use: {
    baseURL,
    /* Screenshots on failure only: a passing run should not write gigabytes. */
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    /* The trace is the fastest way to see what a failed step actually did. */
    trace: 'on-first-retry',
    /* Guards against an accidentally serialised suite. */
    actionTimeout: 15_000,
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      /* The brief calls for mobile-class performance and a touch control set, so
         touch is a first-class target rather than an afterthought.
         LANDSCAPE on purpose: the arena is landscape-only, and a portrait phone
         legitimately shows a rotate prompt instead of the menu. */
      name: 'mobile',
      use: { ...devices['Pixel 5 landscape'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});