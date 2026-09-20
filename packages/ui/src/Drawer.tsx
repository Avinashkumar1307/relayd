import { useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.js';
import { SCRIM, useDialogBehaviour } from './overlay.js';

/**
 * Right-side drawer (design/00 Design System.dc.html, "Drawer, modal,
 * stepper, destructive confirmation"; D1 contact drawer, E provider drawer,
 * H pool drawer, J webhook drawer).
 *
 * The sheet's rule, verbatim: "Drawers (440px) hold detail views so the
 * table stays in context."
 *
 * Measured from the sheet: pinned top/right/bottom, 440px, surface with a
 * 1px left border and the overlay shadow. Header `18px 20px` with a 16/600
 * title, a 13px text-2 subtitle 2px under it and a 30px close button; body
 * `16px 20px` and scrollable; footer pushed to the bottom, `14px 20px`,
 * separated by a 1px rule, with its actions spread apart — the frames put
 * the destructive one on the left and the ordinary one on the right.
 *
 * `sm` is the sheet's 440; `md` (480) and `lg` (560) are the other two
 * widths the section frames use.
 */

export type DrawerSize = 'sm' | 'md' | 'lg';

const WIDTH: Record<DrawerSize, number> = { sm: 440, md: 480, lg: 560 };

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** 16/600 — the record this drawer is about, and the accessible name. */
  title: ReactNode;
  /** The line under it: an email address, or an id in mono. */
  subtitle?: ReactNode | undefined;
  /** Badges and chips under the subtitle, as on the contact drawer. */
  headerExtra?: ReactNode | undefined;
  children?: ReactNode | undefined;
  footer?: ReactNode | undefined;
  size?: DrawerSize | undefined;
  width?: number | undefined;
  closeOnEscape?: boolean | undefined;
  closeOnScrimClick?: boolean | undefined;
  closeLabel?: string | undefined;
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  headerExtra,
  children,
  footer,
  size = 'sm',
  width,
  closeOnEscape = true,
  closeOnScrimClick = true,
  closeLabel = 'Close',
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const titleId = `${id}-title`;

  useDialogBehaviour({ open, panelRef, onClose, closeOnEscape });

  if (!open) return null;

  const onScrimMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (closeOnScrimClick && event.target === event.currentTarget) onClose();
  };

  return createPortal(
    <div
      data-rl-scrim="drawer"
      onMouseDown={onScrimMouseDown}
      className="fixed inset-0 z-50"
      style={{ background: SCRIM }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="fixed top-0 right-0 bottom-0 flex max-w-full flex-col border-l border-border bg-surface text-text shadow-overlay outline-none"
        style={{ width: width ?? WIDTH[size] }}
      >
        <header className="flex flex-none items-start justify-between gap-3 border-b border-border px-5 py-[18px]">
          <div className="min-w-0">
            <div id={titleId} className="text-card font-semibold leading-heading">
              {title}
            </div>
            {subtitle === undefined ? null : <div className="mt-0.5 text-ui text-text-2">{subtitle}</div>}
            {headerExtra === undefined ? null : <div className="mt-2 flex gap-1.5">{headerExtra}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="grid h-[30px] w-[30px] flex-none cursor-pointer place-items-center rounded-control bg-transparent text-text-2 hover:bg-tint"
          >
            <Icon name="x" size={16} strokeWidth={2} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-ui">{children}</div>

        {footer === undefined ? null : (
          <div className="mt-auto flex flex-none justify-between gap-2 border-t border-border px-5 py-[14px]">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
