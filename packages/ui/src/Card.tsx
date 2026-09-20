import type { ReactNode } from 'react';
import type { Tone } from './states.js';

/**
 * Cards and stat tiles (design/01 Shell + Dashboard options.dc.html, frame
 * 1a; design/00 Design System.dc.html, "Space and elevation").
 *
 * The surface appears on nearly every frame and it is always the same four
 * values, read off 1a: `background: var(--surface); border: 1px solid
 * var(--border); border-radius: 12px; padding: 16px 18px`. The sheet's rule
 * is "one soft shadow, for overlays only" — a card never has one, it is
 * separated from the page by its border alone.
 *
 * `flush` is the other half of the pattern: a card whose content runs to its
 * own edge (a table, a list of rows) drops the padding and clips instead, as
 * every table card in the frames does with `overflow: hidden`.
 */

export interface CardProps {
  children: ReactNode;
  /** Content runs to the edge and is clipped: tables, row lists. */
  flush?: boolean | undefined;
  /** An `<article>`/`<section>` where the card is a landmark, else a div. */
  as?: 'div' | 'section' | 'article' | undefined;
  className?: string | undefined;
}

export const CARD_SURFACE = 'bg-surface border border-border rounded-card';

export function Card({ children, flush = false, as: As = 'div', className = '' }: CardProps) {
  return (
    <As className={[CARD_SURFACE, flush ? 'overflow-hidden' : 'px-4.5 py-4', className].join(' ')}>
      {children}
    </As>
  );
}

/**
 * A card's title row: title left, actions right, baseline-aligned.
 *
 * Two title sizes exist in the frames and both are here. The dashboard's
 * panels ("Sending activity") use the inherited 14/600; a detail page's
 * section titles (E, G, H) use 16/1.2/600 — `text-card`, the size the sheet
 * names "card titles".
 */
export interface CardHeaderProps {
  title: ReactNode;
  description?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  /** `sm` is the dashboard panel's 14/600; `md` the 16/600 section title. */
  size?: 'sm' | 'md' | undefined;
  className?: string | undefined;
}

export function CardHeader({ title, description, actions, size = 'md', className = '' }: CardHeaderProps) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <div
          className={
            size === 'md' ? 'text-card font-semibold leading-heading' : 'text-body font-semibold leading-heading'
          }
        >
          {title}
        </div>
        {description === undefined ? null : <div className="mt-1 text-caption text-text-2">{description}</div>}
      </div>
      {actions === undefined ? null : <div className="flex flex-none items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * The delta line under a stat value. 1a colours it by meaning: a good move
 * is `--success-text`, a bad one `--danger-text`, anything neutral stays
 * `--text-2`. The tone vocabulary is `states.ts`'s so a stat and a badge
 * never disagree about what "warning" looks like.
 */
export const TONE_TEXT: Readonly<Record<Tone, string>> = {
  neutral: 'text-text-2',
  info: 'text-info-text',
  brand: 'text-brand',
  warning: 'text-warning-text',
  success: 'text-success-text',
  danger: 'text-danger-text',
  uncertain: 'text-text-2',
  bot: 'text-text-2',
};

export interface StatProps {
  label: ReactNode;
  /** 24/1.2/600, tabular figures — the sheet's `text-title`. */
  value: ReactNode;
  /** The chip beside the label: "Headline", "approximate". */
  aside?: ReactNode | undefined;
  /** A meter, sparkline or segmented bar between the value and the delta. */
  children?: ReactNode | undefined;
  delta?: ReactNode | undefined;
  deltaTone?: Tone | undefined;
  className?: string | undefined;
}

export function Stat({ label, value, aside, children, delta, deltaTone = 'neutral', className = '' }: StatProps) {
  return (
    <div className={`${CARD_SURFACE} flex min-w-0 flex-col gap-2 px-4.5 py-4 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-ui text-text-2">{label}</span>
        {aside}
      </div>
      <div className="text-title font-semibold leading-heading tracking-heading tabular-nums">{value}</div>
      {children}
      {delta === undefined ? null : <div className={`text-caption ${TONE_TEXT[deltaTone]}`}>{delta}</div>}
    </div>
  );
}
