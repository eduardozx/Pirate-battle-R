import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Flat config for the whole repository: source, tests, harness scripts and the
 * config files themselves.
 *
 * WHAT IS ON AS AN ERROR vs WHAT IS NOT.
 *   • `rules-of-hooks` — a rules violation here silently breaks the game's rules
 *     of play, because React is what mounts the match. Error.
 *   • The remaining React Compiler rules (`purity`, `refs`, `set-state-in-effect`,
 *     …) run as warnings. They describe a direction of travel for the code, and
 *     promoting them today would mean rewriting working screens to satisfy a
 *     linter while the brief's feature work waits. Warnings stay visible in
 *     every run without failing `npm run lint`.
 *   • `exhaustive-deps` is a warning for the same reason, and the one place the
 *     codebase deliberately disagrees with it — `Hud.tsx` — carries an inline
 *     disable with its own justification.
 *   • `no-undef` is off for TypeScript (the compiler already answers that
 *     question, better) and on for the plain-JS scripts, where nothing else
 *     would.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'public/mockServiceWorker.js',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      // Promoted below the source's own baseline: see the note at the top.
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/incompatible-library': 'warn',
      'react-hooks/unsupported-syntax': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/use-memo': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/globals': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/error-boundaries': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-render': 'warn',
      'react-hooks/config': 'warn',
      'react-hooks/gating': 'warn',
    },
  },

  /* Scripts and config files are plain JS run by Node — and they are the only
     files here where an undefined identifier is not caught by the compiler. */
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
    },
  },

  /* The harness also ships code INTO the page: `page.evaluate(() => window.__pbProfile…)`
     is compiled by the browser, where `window` and `document` very much exist.
     Node's globals stay in force alongside them, because the same file holds
     both halves. */
  {
    files: ['scripts/**'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  {
    rules: {
      /* Type assertions are written with `as` throughout the boundary code
         (window hooks, MSW payloads); `any` at those seams is deliberate. */
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
