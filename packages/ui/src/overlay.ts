import { useEffect, useRef, type RefObject } from 'react';

/**
 * Shared dialog behaviour for `Modal` and `Drawer` (design/00 Design
 * System.dc.html, "Drawer, modal, stepper, destructive confirmation").
 *
 * Internal to the package — not exported from `index.ts`. The two overlays
 * look nothing alike and are separate components, but the parts a keyboard
 * or screen-reader user depends on are identical, and a focus trap that is
 * written twice is a focus trap that is right once.
 *
 * The scrim colour is the one value in this group the design does not
 * tokenise: every frame paints it `rgba(17,24,39,.32)` literally, in light
 * and dark alike, and `tokens.css` has no variable for it. It lives here as
 * a single named constant so there is one place to change when a token
 * arrives.
 */
export const SCRIM = 'rgba(17,24,39,.32)';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** The tabbable elements inside a panel, in document order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
  );
}

export interface DialogBehaviour {
  open: boolean;
  panelRef: RefObject<HTMLElement>;
  onClose: () => void;
  /** Escape closes. Off for a dialog whose work must not be abandoned mid-way. */
  closeOnEscape: boolean;
}

/**
 * Focus in, focus trapped, focus back; Escape to close; the page behind does
 * not scroll.
 *
 * Escape is handled on the document in the bubble phase, not capture, so a
 * menu open *inside* the dialog can take the key first and close only
 * itself.
 */
export function useDialogBehaviour({ open, panelRef, onClose, closeOnEscape }: DialogBehaviour): void {
  // The close handler is nearly always an inline arrow, so it cannot be an
  // effect dependency: the effect would re-run on every render and drag
  // focus back to the first field while somebody was typing in the third.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const panel = panelRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panel === null ? undefined : focusables(panel)[0];
    (first ?? panel)?.focus();

    const scrollLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = scrollLock;
      previous?.focus();
    };
  }, [open, panelRef]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (event.key === 'Escape') {
        if (closeOnEscape) {
          event.preventDefault();
          closeRef.current();
        }
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (panel === null) return;

      const items = focusables(panel);
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) {
        // Nothing to move to: keep focus on the panel rather than letting
        // Tab wander out into the page behind the scrim.
        event.preventDefault();
        panel.focus();
        return;
      }

      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, closeOnEscape, panelRef]);
}
