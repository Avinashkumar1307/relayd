import { useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SCRIM, useDialogBehaviour } from './overlay.js';

/**
 * Modal dialog (design/00 Design System.dc.html, "Drawer, modal, stepper,
 * destructive confirmation"; the same box in D2 merge-tags, E disconnect,
 * I billing and J settings).
 *
 * The sheet's rule, verbatim: "Drawers (440px) hold detail views so the
 * table stays in context. Modals (520px) hold short forms."
 *
 * Measured from the sheet: 520px wide, `max-width: calc(100% - 40px)`, a
 * 12px radius on the surface with a 1px border and the one overlay shadow.
 * Header `20px 20px 0` with a 20/600 title and an 8px-above description in
 * 13px text-2; body `16px 20px 0`; footer right-aligned with an 8px gap and
 * `16px 20px 20px`. The frames also use 460, 480, 560 and 600 — `sm`, `md`
 * and `lg` are the three the sheet's own examples settle on, and `width`
 * takes the rest rather than letting a page invent one.
 *
 * ## No ✕ in the header
 *
 * Not an omission: no modal in the export has one. The footer's Cancel is
 * the visible way out, Escape and the scrim are the invisible ones. A modal
 * with no footer should pass one.
 */

export type ModalSize = 'sm' | 'md' | 'lg';

const WIDTH: Record<ModalSize, number> = { sm: 460, md: 520, lg: 600 };

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Names the dialog: 20/600, and the accessible name. */
  title: ReactNode;
  /** The sentence under the title — what this does, or what it will cost. */
  description?: ReactNode | undefined;
  children?: ReactNode | undefined;
  /** Right-aligned actions. Cancel first, the primary or danger action last. */
  footer?: ReactNode | undefined;
  size?: ModalSize | undefined;
  /** For the frames that measure 480 or 560 rather than one of the three sizes. */
  width?: number | undefined;
  closeOnEscape?: boolean | undefined;
  closeOnScrimClick?: boolean | undefined;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  width,
  closeOnEscape = true,
  closeOnScrimClick = true,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;

  useDialogBehaviour({ open, panelRef, onClose, closeOnEscape });

  if (!open) return null;

  // mousedown, not click: a selection dragged from inside the dialog out
  // onto the scrim must not count as clicking away.
  const onScrimMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (closeOnScrimClick && event.target === event.currentTarget) onClose();
  };

  return createPortal(
    <div
      data-rl-scrim="modal"
      onMouseDown={onScrimMouseDown}
      // No padding here: the 20px gutter is the panel's own
      // `max-width: calc(100% - 40px)`, exactly as the sheet writes it.
      className="fixed inset-0 z-50 grid place-items-center"
      style={{ background: SCRIM }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        className="max-h-[calc(100vh-40px)] overflow-y-auto rounded-card border border-border bg-surface pb-5 text-text shadow-overlay outline-none"
        style={{ width: width ?? WIDTH[size], maxWidth: 'calc(100% - 40px)' }}
      >
        <div className="px-5 pt-5">
          <h2 id={titleId} className="text-section font-semibold leading-heading">
            {title}
          </h2>
          {description === undefined ? null : (
            <p id={descriptionId} className="mt-2 text-pretty text-ui text-text-2">
              {description}
            </p>
          )}
        </div>

        {children === undefined ? null : <div className="px-5 pt-4 text-ui">{children}</div>}
        {footer === undefined ? null : <div className="flex justify-end gap-2 px-5 pt-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
