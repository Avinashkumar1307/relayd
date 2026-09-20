import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons.js';

/**
 * Empty states (design/00 Design System.dc.html, "Empty and error states";
 * the page-sized variant is the same block at 72px on D, E, F, G, H, I, J).
 *
 * The sheet's rule, verbatim: "Empty: one icon, one sentence, one action."
 *
 * Measured: a card with `padding: 56px 24px` in a table (the sheet) or
 * `72px 24px` as a whole page, `display:flex; flex-direction:column;
 * align-items:center; text-align:center; gap:12px`; a 44px `border-radius:
 * 12px` tile in `--brand-soft` on `--brand` holding a 20px icon; the title
 * at `16px/1.2/600`; the sentence at 13 on `--text-2` with `text-wrap:
 * pretty` and a max width of 360 (table) or 420 (page); the actions row
 * `gap: 8px; margin-top: 4px`.
 *
 * One icon, one sentence, one action is a rule about restraint, so the
 * action slots take nodes rather than a list: there is room for a primary
 * and at most one secondary, and no room for a third.
 */

export interface EmptyStateProps {
  icon: IconName;
  title: ReactNode;
  description?: ReactNode | undefined;
  /** The one primary action — a `Button`. */
  action?: ReactNode | undefined;
  /** A quieter escape beside it: "Learn about imports". */
  secondary?: ReactNode | undefined;
  /** `table` is the 56px card inside a table; `page` the 72px whole page. */
  size?: 'table' | 'page' | undefined;
  className?: string | undefined;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  secondary,
  size = 'page',
  className = '',
}: EmptyStateProps) {
  return (
    <div
      className={[
        'flex flex-col items-center gap-3 rounded-card border border-border bg-surface px-6 text-center',
        size === 'page' ? 'py-18' : 'py-14',
        className,
      ].join(' ')}
    >
      <span className="grid h-11 w-11 place-items-center rounded-card bg-brand-soft text-brand">
        <Icon name={icon} size={20} />
      </span>

      <div className="text-card font-semibold leading-heading">{title}</div>

      {description === undefined ? null : (
        <div className={`text-ui text-pretty text-text-2 ${size === 'page' ? 'max-w-105' : 'max-w-90'}`}>
          {description}
        </div>
      )}

      {action === undefined && secondary === undefined ? null : (
        <div className="mt-1 flex gap-2">
          {secondary}
          {action}
        </div>
      )}
    </div>
  );
}
