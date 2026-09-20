import type { ReactNode } from 'react';
import { CopyButton } from './CopyButton.js';

/**
 * Monospace identifiers (design/00 Design System.dc.html, "Monospace IDs and
 * reveal-once secrets").
 *
 * The sheet's rule, verbatim: "IDs are chips with a copy button."
 *
 * Three measured forms:
 *   chip   28px, radius 6, `tint` on the field border, mono 12, 10 left and
 *          4 right when it carries the copy button, capped at 260px.
 *   field  36px, radius 8, full width — the sheet's "Read-only mono field
 *          with copy", the inbound webhook URL. Pair it with a label by
 *          putting it where a `Field`'s input would go.
 *   inline the same face and size with no box — how a provider message id
 *          or a key prefix appears inside a sentence on E1d and J3c.
 *
 * `truncate` shortens what is *shown*; the full value stays in the tooltip
 * and is what the copy button puts on the clipboard. An id that has been cut
 * down for the layout must never be the one somebody pastes.
 */

export interface MonoProps {
  value: string;
  /** Show at most N characters, with an ellipsis. The full value still copies. */
  truncate?: number | undefined;
  /** Append the copy button (chip and field). */
  copy?: boolean | undefined;
  /** The accessible name of that button — "Copy campaign ID". */
  copyLabel?: string | undefined;
  variant?: 'chip' | 'field' | 'inline' | undefined;
  /** Overrides the tooltip; defaults to the full value. */
  title?: string | undefined;
  children?: ReactNode | undefined;
  className?: string | undefined;
}

export function Mono({
  value,
  truncate,
  copy = false,
  copyLabel,
  variant = 'chip',
  title,
  children,
  className = '',
}: MonoProps) {
  const shown = truncate !== undefined && value.length > truncate ? `${value.slice(0, truncate)}…` : value;

  if (variant === 'inline') {
    return (
      <span className={`font-mono text-caption ${className}`} title={title ?? value}>
        {shown}
        {children}
      </span>
    );
  }

  if (variant === 'field') {
    return (
      <span
        className={[
          'flex h-9 w-full items-center gap-2 rounded-control border border-border bg-tint',
          copy ? 'pl-3 pr-1.5' : 'px-3',
          'font-mono text-caption text-text',
          className,
        ].join(' ')}
        title={title ?? value}
      >
        <span className="min-w-0 flex-1 truncate">{shown}</span>
        {children}
        {copy ? <CopyButton text={value} size="sm" ariaLabel={copyLabel} /> : null}
      </span>
    );
  }

  return (
    <span
      className={[
        'inline-flex h-7 max-w-[260px] items-center gap-1.5 rounded-badge border border-border bg-tint',
        copy ? 'pl-2.5 pr-1' : 'px-2.5',
        'font-mono text-caption text-text',
        className,
      ].join(' ')}
      title={title ?? value}
    >
      <span className="truncate">{shown}</span>
      {children}
      {copy ? <CopyButton text={value} size="xs" ariaLabel={copyLabel} /> : null}
    </span>
  );
}
