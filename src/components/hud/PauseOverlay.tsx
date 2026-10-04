import { useEffect, useRef } from 'react';

import type { PauseReason } from '../../game/core/types';
import { useFocusTrap } from '../useFocusTrap';

/**
 * Pause overlay.
 *
 * Two behaviours the spec is explicit about:
 *   • Resuming REQUIRES a deliberate player action. No key, no timer, no
 *     auto-resume on focus — a button click or Enter/Space.
 *   • Nothing accumulated during the pause may leak into the resumed match.
 *     The session already releases all held inputs on pause; this overlay only
 *     has to make the state obvious.
 */

const PAUSE_COPY: Record<Exclude<PauseReason, null>, { title: string; hint: string }> = {
  manual: {
    title: 'Paused',
    hint: 'The clock, cooldowns and simulation are frozen.',
  },
  'focus-lost': {
    title: 'Paused — window lost focus',
    hint: 'Resume when you are ready.',
  },
  'hidden-tab': {
    title: 'Paused — tab hidden',
    hint: 'Resume when you are ready.',
  },
};

export interface PauseOverlayProps {
  readonly reason: PauseReason;
  readonly onResume: () => void;
}

export function PauseOverlay({ reason, onResume }: PauseOverlayProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const resumeRef = useRef<HTMLButtonElement | null>(null);
  const copy = reason === null ? PAUSE_COPY.manual : PAUSE_COPY[reason];

  // Focus lands on Resume (the one action that matters) and Tab stays inside the
  // dialog until it closes.
  useFocusTrap(panelRef, { initialFocusRef: resumeRef, active: reason !== null });

  // Escape dismisses the dialog, matching the convention for modal dialogs.
  // Gated on the dialog actually being open: while the match is RUNNING this
  // listener must stay out of the way, or it would race the pause binding.
  useEffect(() => {
    if (reason === null) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onResume();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [reason, onResume]);

  if (reason === null) return null;

  return (
    <div className="overlay" data-testid="pause-overlay">
      <div
        ref={panelRef}
        className="overlay__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pause-title"
        tabIndex={-1}
      >
        <h2 id="pause-title" className="overlay__title">
          {copy.title}
        </h2>
        <p className="overlay__hint">{copy.hint}</p>
        <button
          ref={resumeRef}
          type="button"
          className="button button--primary"
          onClick={onResume}
          data-testid="resume-button"
        >
          Resume
        </button>
      </div>
    </div>
  );
}
