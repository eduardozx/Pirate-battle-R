import { useEffect, useRef } from 'react';

import type { TextureRegistry } from '../game/assets/textureRegistry';
import type { GameSession } from '../game/core/gameSession';
import { FrameProfiler } from '../game/core/frameProfiler';
import type { GameConfig } from '../game/config/gameConfig';
import { GameRenderer } from '../game/render/gameRenderer';
import { installTestHook } from '../game/testHook';
import type { HudStore } from '../store/hudStore';

/**
 * ============================================================================
 *  GAME CANVAS — the React ⇄ PixiJS bridge
 * ============================================================================
 *
 * The only component that talks to PixiJS.
 *
 * OWNERSHIP (this is the part that matters):
 *   MatchScreen owns the SESSION — it creates it and destroys it.
 *   GameCanvas owns the RENDERER — the WebGL context and the display list.
 *
 * GameCanvas deliberately does NOT destroy the session. Under StrictMode this
 * component's effect is mounted, unmounted and re-mounted while the parent
 * session object is the same instance; destroying it here would kill the match on
 * the discarded first mount and leave the live one dead. The parent unmounts the
 * canvas together with the session, so its cleanup still runs exactly once.
 *
 * The remaining StrictMode hazard is async renderer initialisation, handled with a
 * generation token plus a cancel flag: an initialisation that resolves after being
 * superseded tears itself down instead of attaching a second canvas.
 *
 * The texture registry is owned by neither — it outlives every match, because a
 * restart must reuse warm GPU textures rather than re-download the atlas.
 */

export interface GameCanvasProps {
  readonly session: GameSession;
  readonly hudStore: HudStore;
  readonly config: GameConfig;
  readonly paused: boolean;
  readonly registry: TextureRegistry;
}

/**
 * Bridges the Pixi ticker to the engine's frame callback.
 *
 * Exactly ONE callback is registered per session, and it does the whole frame in
 * the correct order: simulate, then copy state to the display list. The session
 * has no say in the ticker, which is what guarantees these two can never
 * interleave incorrectly.
 */
class TickerDriver {
  private readonly tick: (ticker: { deltaMS: number }) => void;

  constructor(
    private readonly renderer: GameRenderer,
    onFrame: (deltaMs: number) => void,
  ) {
    // Bound once so the same reference can be added and later removed.
    this.tick = (ticker) => onFrame(ticker.deltaMS);
  }

  start(): void {
    this.renderer.ticker.add(this.tick);
  }

  stop(): void {
    this.renderer.ticker.remove(this.tick);
  }
}

/**
 * Profiling is opt-in and read from the URL.
 *
 * Gated on `import.meta.env.DEV || import.meta.env.PROFILE` so a shipped build
 * carries no way to turn it on, and driven by a query parameter rather than a
 * config file so a profiled run and a clean run differ by nothing except the URL.
 * `PROFILE` is `true` only for `vite build --mode profile` (`npm run build:profile`)
 * — the same optimised build with the profiler compiled in, which is how CPU cost
 * and entity counts get measured off a production bundle; the deployed build gets
 * `false` here and the whole block is minified away, exactly like the dev branch.
 * When off, the frame driver contains no timestamps and no sample writes — see
 * `FrameProfiler.measure`.
 */
const profiler = new FrameProfiler();

if ((import.meta.env.DEV || import.meta.env.PROFILE) && typeof location !== 'undefined') {
  profiler.setEnabled(new URLSearchParams(location.search).has('profile'));

  /* Read surface for the profiling harness. It returns the summary on demand
     rather than sampling in the background, so collecting a measurement costs the
     running game nothing until someone asks. */
  (window as unknown as Record<string, unknown>)['__pbProfile'] = {
    summary: (): unknown => profiler.summary(),
    reset: (): void => profiler.reset(),
    enabled: (): boolean => profiler.isEnabled,
  };
}

export function GameCanvas({
  session,
  hudStore,
  config,
  paused,
  registry,
}: GameCanvasProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    // Any previous attempt (e.g. StrictMode's discarded mount) is now stale.
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let cancelled = false;

    /* The E2E suite's read surface for this match. It lives and dies with the
       effect — same lifetime as the renderer — so a spec can never observe a
       destroyed session. Compiled out of production builds entirely. */
    const uninstallTestHook = import.meta.env.DEV ? installTestHook(session) : null;

    const renderer = new GameRenderer(config);
    let driver: TickerDriver | null = null;

    // The session is the single source of truth for coarse HUD state, so the
    // store is fed by SUBSCRIBING to it rather than by polling from the frame
    // loop. Polling required a "did anything change?" flag, and such a flag
    // inevitably forgets the clock — which is exactly how a frozen timer ships.
    // The session already notifies on every discrete change, and the store
    // dedupes, so React still re-renders only when a visible value moves.
    const unsubscribeHud = session.subscribeHud((state) => hudStore.publish(state));

    void renderer.initialise(host, registry, session.world).then(
      () => {
        console.log('[GameCanvas] renderer initialised successfully');
        if (cancelled || generation !== generationRef.current) {
          // Superseded: release the GPU resources this attempt created.
          renderer.destroy();
          return;
        }

        driver = new TickerDriver(
          renderer,
          profiler.measure(
            // Per frame: simulate, then copy state to the display list.
            // React is never involved in this path.
            (deltaMs) => session.stepFrame(deltaMs),
            () => renderer.sync(session.world),
            // World size, so the timings above can be read against the load that
            // produced them rather than floating free of any subject.
            () => session.world.entityCount,
          ),
        );

        console.log('[GameCanvas] starting session');
        session.start();
        driver.start();
      },
      (error: unknown) => {
        console.error('[GameCanvas] renderer initialisation failed', error);
        renderer.destroy();
      },
    );

    return () => {
      cancelled = true;
      unsubscribeHud();
      driver?.stop();
      uninstallTestHook?.();
      // Only the renderer is released here. The session belongs to MatchScreen,
      // which destroys it exactly once when the screen itself unmounts.
      renderer.destroy();
    };
  }, [session, config, hudStore, registry]);

  // Keyboard capture follows the UI state, so arrows and space keep their normal
  // meaning while a menu or dialog owns the focus.
  useEffect(() => {
    session.setInputCapture(!paused);
  }, [session, paused]);

  return <div ref={hostRef} className="game-canvas" data-testid="game-canvas" />;
}
