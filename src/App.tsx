import { useCallback, useEffect, useMemo, useState } from 'react';

import { MainMenu } from './components/screens/MainMenu';
import { MatchScreen, type MatchResult } from './components/screens/MatchScreen';
import { OptionsScreen } from './components/screens/OptionsScreen';
import { ResultScreen } from './components/screens/ResultScreen';

import { optionsStoreRef } from './store/appStores';
import { useOptions } from './store/optionsStore';
import { clearLastResult, loadLastResult, saveLastResult } from './store/lastResultStore';
import { useConfigFingerprint } from './services/outbox/submitMatchOutcome';
import { startOutboxDelivery } from './services/outbox/outboxStore';
import { startMockServer } from './services/msw/browser';

/**
 * App shell, routing and bootstrapping.
 *
 * Routing is a discriminated union rather than a router dependency: with five
 * screens there is nothing to gain from URL semantics, and avoiding it keeps the
 * state machine obvious and the bundle lean.
 *
 * THREE RULES ENCODED HERE:
 *   • Abandoning a match produces no result screen, so nothing is recorded.
 *   • The configuration is snapshotted when a match STARTS, so editing options
 *     afterwards cannot retroactively change what a match was recorded as.
 *   • The last completed result is persisted and restored, so a refresh does not
 *     erase the one screen that shows the score.
 */

type Screen =
  | { name: 'menu' }
  | { name: 'options' }
  | { name: 'match' }
  | { name: 'result'; result: MatchResult };

const isTouchDevice = (): boolean =>
  typeof window !== 'undefined' &&
  (window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0);

export function App(): JSX.Element {
  /* Boot straight back to the result if one was interrupted by a refresh — see
     `lastResultStore`. Leaving it through either action clears the entry. */
  const [screen, setScreen] = useState<Screen>(() => {
    const restored = loadLastResult();
    return restored === null ? { name: 'menu' } : { name: 'result', result: restored };
  });
  const [ready, setReady] = useState(false);
  const showTouchControls = useMemo(() => isTouchDevice(), []);

  const options = useOptions(optionsStoreRef);

  // The config is snapshotted per match: a match in progress keeps the settings
  // it started with, exactly as the brief requires.
  const [matchConfig, setMatchConfig] = useState(() => optionsStoreRef.toGameConfig());
  const fingerprint = useConfigFingerprint(matchConfig, options);

  /**
   * Bootstraps the mock API server and background submission delivery.
   *
   * Both are started ONCE for the whole app, not per screen: the mock database
   * must stay consistent between the ranking and history panels, and a pending
   * submission must survive navigating away from the result screen.
   */
  useEffect(() => {
    let cancelled = false;
    let stopDelivery: (() => void) | null = null;

    void startMockServer().finally(() => {
      if (cancelled) return;
      stopDelivery = startOutboxDelivery();
      setReady(true);
    });

    return () => {
      cancelled = true;
      stopDelivery?.();
    };
  }, []);

  const startMatch = useCallback(() => {
    clearLastResult();
    setMatchConfig(optionsStoreRef.toGameConfig());
    setScreen({ name: 'match' });
  }, []);

  const handleCompleted = useCallback((result: MatchResult) => {
    // Persisted BEFORE the screen changes: a refresh a frame later must still
    // find the outcome, not a blank menu.
    saveLastResult(result);
    setScreen({ name: 'result', result });
  }, []);

  const handleAbandoned = useCallback(() => {
    setScreen({ name: 'menu' });
  }, []);

  /** Leaves the result screen. The stored copy is consumed by leaving it. */
  const leaveResult = useCallback(() => {
    clearLastResult();
    setScreen({ name: 'menu' });
  }, []);

  return (
    <div className="app" data-testid="app">
      {screen.name === 'menu' && (
        <MainMenu
          onPlay={startMatch}
          onOpenOptions={() => setScreen({ name: 'options' })}
          configFingerprint={fingerprint}
          showTouchControls={showTouchControls}
        />
      )}

      {screen.name === 'options' && (
        <OptionsScreen store={optionsStoreRef} onBack={() => setScreen({ name: 'menu' })} />
      )}

      {screen.name === 'match' && (
        <MatchScreen
          config={matchConfig}
          options={options}
          onCompleted={handleCompleted}
          onAbandoned={handleAbandoned}
          showTouchControls={showTouchControls}
        />
      )}

      {screen.name === 'result' && (
        <ResultScreen
          result={screen.result}
          onPlayAgain={startMatch}
          onMainMenu={leaveResult}
        />
      )}

      {/* Bootstrapping indicator: keeps the menu from being interactive before
          the mock server is ready, which would show a spurious error state. */}
      {!ready && (
        <div className="boot" role="status" aria-live="polite" data-testid="boot-status">
          Starting services…
        </div>
      )}
    </div>
  );
}
