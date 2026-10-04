import { useEffect, type RefObject } from 'react';

/**
 * Focus containment for modal dialogs.
 *
 * WHAT A DIALOG OWES A KEYBOARD USER. When a modal opens, focus moves into it;
 * while it is open, Tab cycles INSIDE it rather than wandering into the page it
 * is supposed to be blocking; when it closes, focus returns to where it came
 * from. Without the last one, a player who dismisses the pause overlay is left
 * with focus on <body> and has to Tab from the beginning of the document.
 *
 * WHY A DOCUMENT-LEVEL LISTENER. The trap cannot be a handler on the container:
 * a Tab that leaves the container has already been handled by then. Listening in
 * the capture phase means the wrap happens BEFORE the browser moves focus, so
 * there is no single frame where focus sits behind the modal.
 *
 * `focusin` is guarded as well, because focus can move without Tab at all — a
 * click on the page behind the dialog, or the browser restoring focus to the
 * address bar and back into the document.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface FocusTrapOptions {
  /** Focused when the trap activates. Defaults to the first focusable child. */
  readonly initialFocusRef?: RefObject<HTMLElement>;
  /** Off = inert trap; used when the dialog is rendered but not modal. */
  readonly active?: boolean;
}

export function useFocusTrap(
  containerRef: RefObject<HTMLElement>,
  { initialFocusRef, active = true }: FocusTrapOptions = {},
): void {
  const initialFocus = initialFocusRef;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (container === null) return;

    const focusable = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.hasAttribute('aria-hidden') &&
          // Visible: a hidden control must not be the target we move focus to.
          element.getClientRects().length > 0,
      );

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // `preventScroll` on purpose. The dialog containers are scroll panes, and
    // browsers centre a freshly focused element inside them — which scrolled the
    // result screen down to its middle the moment it opened, leaving its title
    // above the fold. Handing over focus must never move the viewport: the panel
    // opens exactly where layout put it, and Tab still scrolls targets into view
    // afterwards, which is where scrolling is actually wanted.
    const preferred = initialFocus?.current ?? focusable()[0] ?? null;
    preferred?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;

      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) {
        // Nowhere to go: keep focus on the dialog rather than letting it escape.
        event.preventDefault();
        container.focus();
        return;
      }

      const current = document.activeElement;
      const inside = current !== null && container.contains(current);

      if (event.shiftKey && (!inside || current === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || current === last)) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || container.contains(target)) return;
      // Focus landed behind the dialog (a click, or programmatic focus).
      (focusable()[0] ?? container).focus();
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      if (previouslyFocused !== null && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [containerRef, initialFocus, active]);
}
