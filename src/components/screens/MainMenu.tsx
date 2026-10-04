import { useState, type ReactNode } from 'react';

import { KEY_HINTS } from '../../game/input/inputController';
import { RankingPanel } from '../panels/RankingPanel';
import { MatchHistoryPanel } from '../panels/MatchHistoryPanel';
import { ScenarioPanel } from '../panels/ScenarioPanel';
import { useOptions } from '../../store/optionsStore';
import { optionsStoreRef } from '../../store/appStores';
import { usePendingSubmissionCount } from '../../services/data/queries';
import { useTextureRegistry } from '../useTextureRegistry';
import { UiPanel, UiPrimaryButton, UiSecondaryButton, UiTitle } from '../UiComponents';

/**
 * Main menu. React owns every pixel here — no canvas, no ticker.
 *
 * The Ranking and Match History tabs are REAL: they query the mocked API through
 * Axios and TanStack Query and render all four states (loading, empty, error,
 * data). The scenario panel below them exposes the MSW conditions the brief
 * requires to be selectable.
 */

export interface MainMenuProps {
  readonly onPlay: () => void;
  readonly onOpenOptions: () => void;
  readonly configFingerprint: string;
  /** True on a touch device: the menu then documents the on-screen pad. */
  readonly showTouchControls: boolean;
}

type MenuTab = 'ranking' | 'history';

const TABS: ReadonlyArray<{ id: MenuTab; label: string }> = [
  { id: 'ranking', label: 'Ranking' },
  { id: 'history', label: 'Match History' },
];

/**
 * On-screen controls, mirrored from `Hud`'s touch pad.
 *
 * A touch player has no keyboard hints to read, and an undocumented control pad
 * is an unusable one: the brief asks for touch instructions in the menu, so the
 * pad's glyphs are listed here with what each one does. Shown INSTEAD of the
 * keyboard table on a touch device, because on a phone the keyboard table is
 * describing hardware the player does not have.
 */
const TOUCH_HINTS: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: '▲', action: 'Hold to sail forward' },
  { keys: '⟲ ⟳', action: 'Hold to turn' },
  { keys: '✦', action: 'Fire forward cannon' },
  { keys: '◀︎ ▶︎', action: 'Fire left / right broadside (3 shots)' },
  { keys: '❚❚', action: 'Pause' },
];

export function MainMenu({
  onPlay,
  onOpenOptions,
  configFingerprint,
  showTouchControls,
}: MainMenuProps): ReactNode {
  const [tab, setTab] = useState<MenuTab>('ranking');
  const options = useOptions(optionsStoreRef);
  const pendingCount = usePendingSubmissionCount();
  const { registry, progress, error, retry } = useTextureRegistry();

  if (registry === null) {
    return (
      <div className="screen screen--center" data-testid="main-menu">
        <div className="panel panel--menu" style={{ minWidth: 300 }}>
          <div className="spinner" />
          {error !== null && (
            <p className="panel__error" data-testid="asset-error">
              {error}
            </p>
          )}
          {/* Retry is enabled whenever the load FAILED, not whenever the bar is
              empty. A failed load still ticks the progress bar to its last value,
              so gating only on progress left the button stuck on "Loading…" — the
              one moment the player actually needs it. */}
          <button
            type="button"
            className="button button--primary"
            onClick={retry}
            disabled={error === null && progress.ratio > 0}
            data-testid="asset-retry"
          >
            {error === null && progress.ratio > 0 ? 'Loading…' : 'Retry'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen screen--center" data-testid="main-menu">
      <MainMenuInner
        onPlay={onPlay}
        onOpenOptions={onOpenOptions}
        tab={tab}
        setTab={setTab}
        options={options}
        pendingCount={pendingCount}
        configFingerprint={configFingerprint}
        showTouchControls={showTouchControls}
      />
    </div>
  );
}

interface MainMenuInnerProps {
  onPlay: () => void;
  onOpenOptions: () => void;
  tab: MenuTab;
  setTab: (tab: MenuTab) => void;
  options: ReturnType<typeof useOptions>;
  pendingCount: number;
  configFingerprint: string;
  showTouchControls: boolean;
}

function MainMenuInner({
  onPlay,
  onOpenOptions,
  tab,
  setTab,
  options,
  pendingCount,
  configFingerprint,
  showTouchControls,
}: MainMenuInnerProps): ReactNode {
  const hints = showTouchControls ? TOUCH_HINTS : KEY_HINTS;
  return (
    <UiPanel logicalWidth={620} logicalHeight={520} className="panel panel--menu">
      <UiTitle />

      <p className="panel__subtitle">Outwit the fleet. Hold the line. Sink every ship.</p>

      <div className="menu-actions" style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap', margin: '20px 0 26px' }}>
        <UiPrimaryButton onClick={onPlay} data-testid="play-button" style={{ minWidth: 180 }}>
          Play
        </UiPrimaryButton>
        <UiSecondaryButton onClick={onOpenOptions} data-testid="options-button" style={{ minWidth: 180 }}>
          Options
        </UiSecondaryButton>
      </div>

      {pendingCount > 0 && (
        <p className="menu-pending" role="status" data-testid="menu-pending">
          {pendingCount} match{pendingCount === 1 ? '' : 'es'} waiting to be recorded — it will
          be submitted automatically.
        </p>
      )}

      <section className="tabs" aria-label="Records">
        <div className="tabs__list" role="tablist">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`tab-${entry.id}`}
              aria-selected={tab === entry.id}
              aria-controls={`panel-${entry.id}`}
              className={`tabs__tab${tab === entry.id ? ' tabs__tab--active' : ''}`}
              onClick={() => setTab(entry.id)}
              data-testid={`tab-${entry.id}`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          id={`panel-${tab}`}
          aria-labelledby={`tab-${tab}`}
          className="tabs__panel"
        >
          {/* Only the active tab queries, so switching tabs is cheap and the
              other panel's cache stays warm for when it is revisited. */}
          {tab === 'ranking' ? (
            <RankingPanel
              configFingerprint={configFingerprint}
              sessionSeconds={options.sessionSeconds}
              spawnIntervalSeconds={options.spawnIntervalSeconds}
            />
          ) : (
            <MatchHistoryPanel />
          )}
        </div>
      </section>

      <section className="controls-hint" aria-labelledby="controls-heading" data-testid="controls-hint">
        <h2 id="controls-heading" className="panel__subtitle">
          {showTouchControls ? 'Touch controls' : 'Controls'}
        </h2>
        <dl className="controls-hint__list">
          {hints.map((hint) => (
            <div key={hint.keys} className="controls-hint__row">
              <dt className="controls-hint__keys">
                <kbd>{hint.keys}</kbd>
              </dt>
              <dd className="controls-hint__action">{hint.action}</dd>
            </div>
          ))}
        </dl>
      </section>

      <ScenarioPanel />
    </UiPanel>
  );
}