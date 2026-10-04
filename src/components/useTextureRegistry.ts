import { useCallback, useEffect, useMemo, useState } from 'react';

import { type LoadProgress, type TextureRegistry } from '../game/assets/textureRegistry';
import { expectedTextureCount } from '../game/assets/assetManifest';
import { textureRegistryRef } from '../store/appStores';

/**
 * Loads every asset declared in the manifest and reports progress.
 *
 * LIFETIME — the registry is an app-level singleton (textureRegistryRef) that
 * outlives matches and screen transitions.
 *
 * Textures are uploaded to the GPU once and remain warm for subsequent matches.
 * The hook coordinates loading progress and reports error / ready state to the UI.
 */

export interface TextureLoadState {
  readonly registry: TextureRegistry | null;
  readonly progress: LoadProgress;
  readonly error: string | null;
  readonly retry: () => void;
}

export const useTextureRegistry = (): TextureLoadState => {
  const registry = textureRegistryRef;

  const [progress, setProgress] = useState<LoadProgress>(() => ({
    loaded: registry.isReady ? expectedTextureCount() : 0,
    total: expectedTextureCount(),
    ratio: registry.isReady ? 1 : 0,
  }));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(() => registry.isReady);

  useEffect(() => {
    if (registry.isReady) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the registry is an external system that may have finished loading between render and this effect; without catching up here the loading screen would wait forever
      setLoaded(true);
      setProgress({ loaded: expectedTextureCount(), total: expectedTextureCount(), ratio: 1 });
      return;
    }

    let cancelled = false;
    setError(null);
    setLoaded(false);
    setProgress({ loaded: 0, total: expectedTextureCount(), ratio: 0 });

    registry
      .load((next) => {
        if (!cancelled) setProgress(next);
      })
      .then(() => {
        if (cancelled) return;
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // Surface the cause verbatim: the loading screen shows it to the player.
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [registry, attempt]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return useMemo(
    () => ({ registry: loaded ? registry : null, progress, error, retry }),
    [registry, loaded, progress, error, retry],
  );
};
