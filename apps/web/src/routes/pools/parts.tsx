import { fmtCount, Icon } from '@relayd/ui';
import { ApiError } from '../../api/client.js';
import { strategyLabel, type PoolStrategy } from '../../api/pools.js';
import { headroomLow } from './headroom.js';

/**
 * The pieces H1a and H1b draw that are not on the design-system sheet: the
 * sender chip, the strategy pill and the headroom bar.
 *
 * They live here rather than in `@relayd/ui` because each is specific to one
 * cell of one table. The one that is nearly a sheet component is the pill —
 * see the note on `StrategyPill`.
 */

/* ------------------------------------------------------------- the chips -- */

/**
 * A sender in H1a's "Members" cell: a 16px provider tile and the address.
 *
 * Measured from the frame: `height: 22; padding: 0 7px 0 4px; border: 1px
 * solid var(--border); radius: 6; font-size: 12; gap: 5`, and the tile
 * `16x16, radius 4, --brand-soft on --brand, JetBrains Mono 7/500`. Seven
 * pixels is below the type scale, so it is written as an arbitrary size.
 */
export function SenderChip({ monogram, email }: { monogram: string; email: string }) {
  return (
    <span className="inline-flex h-[22px] items-center gap-[5px] rounded-badge border border-border pr-[7px] pl-1 text-caption whitespace-nowrap">
      <ProviderTile monogram={monogram} size="sm" />
      {email}
    </span>
  );
}

/** The provider letters: 16px in a chip (H1a), 24px in the drawer (H1b). */
export function ProviderTile({ monogram, size = 'md' }: { monogram: string; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden="true"
      className={[
        'grid flex-none place-items-center bg-brand-soft font-mono font-medium text-brand',
        size === 'sm' ? 'h-4 w-4 rounded-4 text-[7px]' : 'h-6 w-6 rounded-badge text-[8px]',
      ].join(' ')}
    >
      {monogram}
    </span>
  );
}

/* -------------------------------------------------------------- the pill -- */

/**
 * The strategy pill: brand for round-robin, info for failover.
 *
 * Deliberately not `@relayd/ui`'s `Badge`. A `Badge` always draws a leading
 * dot — it is the state vocabulary, and a state has a dot — and H1a's
 * strategy pill has none, because a strategy is a setting rather than a
 * state. Everything else about it is `Badge`'s geometry, kept identical so
 * the two sit at the same height in a row.
 */
export function StrategyPill({ strategy }: { strategy: PoolStrategy }) {
  const brand = strategy === 'round_robin';

  return (
    <span
      className={[
        'inline-flex h-[22px] items-center rounded-badge px-2 text-caption font-medium whitespace-nowrap',
        brand ? 'bg-brand-soft text-brand' : 'bg-info-soft text-info-text',
      ].join(' ')}
    >
      {strategyLabel(strategy)}
    </span>
  );
}

/* --------------------------------------------------------------- the bar -- */

export interface HeadroomBarProps {
  remaining: number;
  total: number;
  /** "2 connections · counted once each". */
  note?: string | undefined;
}

/**
 * "95,870 / 150,000" over a 6px bar, with the day's note underneath.
 *
 * The fill is what is *left*, not what is used, and it turns amber under a
 * quarter. A customer reading this cell is asking one question — will this
 * pool get through tonight's send — and the number that answers it is the
 * remaining one.
 */
export function HeadroomBar({ remaining, total, note }: HeadroomBarProps) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="h-1.5 min-w-8 flex-1 overflow-hidden rounded-3 bg-neutral-soft">
          <div
            className={`h-full rounded-3 ${headroomLow(remaining, total) ? 'bg-warning' : 'bg-brand'}`}
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
        <span className="text-caption whitespace-nowrap tabular-nums">
          {fmtCount(remaining)} / {fmtCount(total)}
        </span>
      </div>
      {note === undefined ? null : (
        <div className="mt-[3px] text-label text-text-2">{note}</div>
      )}
    </>
  );
}

/* ------------------------------------------------------------ the footnote -- */

/**
 * The line under H1a's table, and the one under H1b's headroom panel.
 *
 * The same warning in two places on purpose: it is the single fact about
 * pools that customers get wrong, and the frames repeat it where each
 * mistake is made — choosing members, and reading the result.
 */
export function Guardrail({ children, inset = false }: { children: string; inset?: boolean }) {
  return (
    <div
      className={[
        'flex items-start gap-2 text-caption',
        inset ? 'mt-3 border-t border-border pt-2.5 text-warning-text' : 'text-text-2',
      ].join(' ')}
    >
      <span className={inset ? 'mt-0.5 flex-none' : 'flex-none text-warning-text'}>
        <Icon name="alert" size={14} strokeWidth={2} />
      </span>
      <span>{children}</span>
    </div>
  );
}

/* ---------------------------------------------------------------- errors -- */

/** The server's sentence, punctuated, or a neutral one when there is none. */
export function sentence(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return message.endsWith('.') ? message : `${message}.`;
}

/** The trace id, when the failure carried one. Spread into `ErrorState`. */
export function requestId(error: unknown): { requestId?: string } {
  return error instanceof ApiError && error.requestId !== undefined
    ? { requestId: error.requestId }
    : {};
}
