import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Unit-test configuration.
 *
 * The environment is `node` on purpose: the rule engine under test imports no
 * DOM API and no rendering library, so it runs headless and fast. If a test ever
 * needs a browser, it belongs in the Playwright suite instead.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/rules/**/*.spec.ts'],
    /* Playwright owns `tests/e2e`. Both runners glob for `*.spec.ts`, so without
       this Vitest would load browser tests into a node environment and fail on
       the first `@playwright/test` import — a confusing error that looks like a
       broken spec rather than a runner collision. */
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
    reporters: ['default'],
  },
});
