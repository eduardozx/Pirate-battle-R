/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * True only for `vite build --mode profile` (`npm run build:profile`).
   *
   * Vite's `define` in `vite.config.ts` replaces every occurrence with a literal,
   * so the default build sees `false` here and the minifier removes the profiler
   * exactly as it removes the `import.meta.env.DEV` branches. The deployed build
   * therefore has no profiling code in it at all; this flag exists so that CPU
   * cost and entity counts can still be measured from an optimised bundle rather
   * than inferred from the dev one.
   */
  readonly PROFILE: boolean;
}
