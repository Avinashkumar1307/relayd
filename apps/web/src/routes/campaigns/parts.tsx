import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Icon, SEG_ORDER, fmtCount } from '@relayd/ui';
import type { ButtonVariant, IconName, SegmentCounts } from '@relayd/ui';
import { ApiError } from '../../api/client.js';
import type { CheckOutcome } from './wizard-steps.js';

/**
 * The pieces section G's frames draw that the design-system sheet does not
 * carry: the 18px metric chip, the recipient filter chip, the headroom meter
 * on the sender step, the pre-flight row, the event timeline and a `Button`
 * that navigates.
 *
 * Every measurement is read off `.design-rendered/frames/G/*.html`. Nothing
 * here re-implements something `@relayd/ui` already exports — the segmented
 * bar, the badges, the table, the stepper, the stat card and the empty and
 * error states all come from there.
 */

/* --------------------------------------------------------- link buttons -- */

const VARIANT: Record<'primary' | 'secondary', string> = {
  primary: 'border-transparent bg-brand text-on-brand hover:bg-brand-hover',
  secondary: 'border-border bg-surface text-text hover:bg-tint',
};

/**
 * A `Button` that navigates.
 *
 * G1's "Create campaign" and the wizard's "Continue to …" are `<a>` in the
 * export, and `@relayd/ui`'s Button only renders a `<button>`. Wiring a click
 * handler to `navigate()` instead would lose middle-click, the status bar and
 * open-in-new-tab, so this borrows the same geometry. Reported under uiGaps.
 */
export function LinkButton({
  to,
  variant = 'primary',
  className = '',
  children,
}: {
  to: string;
  variant?: Extract<ButtonVariant, 'primary' | 'secondary'>;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={`inline-flex h-8.5 items-center justify-center gap-1.5 whitespace-nowrap rounded-control border px-3 text-ui font-medium no-underline ${VARIANT[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}

/**
 * The design's fourth button kind: an outlined control whose *label* is
 * danger-coloured.
 *
 * `design/G Campaigns.dc.html` draws G3's Cancel as
 * `border: 1px solid var(--border); background: var(--surface); color:
 * var(--danger-text)` — not the filled red `Button variant="danger"`, which
 * on a campaign header would read as the primary thing to do with a send in
 * flight. `@relayd/ui`'s Button has no such variant; reported under uiGaps.
 */
export function DangerOutlineButton({
  onClick,
  disabled = false,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string | undefined;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'inline-flex h-8.5 items-center justify-center gap-1.5 whitespace-nowrap rounded-control border px-3 text-ui font-medium',
        'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft',
        disabled
          ? 'cursor-not-allowed border-transparent bg-neutral-soft text-text-3'
          : 'cursor-pointer border-border bg-surface text-danger-text hover:bg-tint',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------- chips -- */

export type ChipTone = 'brand' | 'neutral';

/**
 * The small kind chip: "Pool", "Sender", "Segment", "List", "Headline",
 * "approx.", "Always on".
 *
 * `height: 18-20; padding: 0 6; radius: 6; font-size: 10-11; weight: 500` in
 * the frames, brand-soft/brand for the emphasised kind and
 * neutral-soft/neutral-text for the rest. `Badge` is the 22px/12px state
 * badge and is a different thing: putting a state badge next to a value would
 * say the value has a state.
 */
export function Chip({
  tone = 'neutral',
  size = 'sm',
  children,
}: {
  tone?: ChipTone;
  size?: 'xs' | 'sm';
  children: ReactNode;
}) {
  return (
    <span
      className={[
        'inline-flex flex-none items-center rounded-badge px-1.5 font-medium whitespace-nowrap',
        size === 'xs' ? 'h-[18px] text-pill' : 'h-5 text-label',
        tone === 'brand' ? 'bg-brand-soft text-brand' : 'bg-neutral-soft text-neutral-text',
      ].join(' ')}
    >
      {children}
    </span>
  );
}

/** G3's recipient filter chips: 28px tall, 12/500, brand when picked. */
export function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: string | undefined;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-control border px-2.5 text-caption font-medium',
        'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft',
        active ? 'border-brand bg-brand-soft text-brand' : 'border-border bg-surface text-text-2',
      ].join(' ')}
    >
      {label}
      {count === undefined ? null : <span className="opacity-70 tabular-nums">{count}</span>}
    </button>
  );
}

/* -------------------------------------------------------- headroom meter -- */

/**
 * The 4px quota bar inside a sender or pool option (G2s3).
 *
 * Amber under 20% left rather than a second colour token: the design computes
 * exactly that, and the point is that a sender about to run out reads
 * differently from one that is not.
 */
export function HeadroomBar({ left, total }: { left: number; total: number }) {
  const share = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;

  return (
    <span className="mt-2 flex items-center gap-2">
      <span className="h-1 flex-1 overflow-hidden rounded-2 bg-neutral-soft">
        <span
          className={`block h-full rounded-2 ${share < 0.2 ? 'bg-warning' : 'bg-brand'}`}
          style={{ width: `${share * 100}%` }}
        />
      </span>
      <span className="flex-none text-caption tabular-nums text-text-2">
        {fmtCount(left)} left today
      </span>
    </span>
  );
}

/* --------------------------------------------------------- pre-flight row -- */

const MARK: Record<CheckOutcome, string> = {
  pass: 'bg-success-soft text-success-text',
  warn: 'bg-warning-soft text-warning-text',
  fail: 'bg-danger-soft text-danger-text',
};

/** One row of G2s7's pre-flight list: a 22px round mark, the claim, the evidence. */
export function PreflightRow({
  outcome,
  title,
  detail,
  action,
}: {
  outcome: CheckOutcome;
  title: string;
  detail: string;
  action?: ReactNode | undefined;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <span
        aria-hidden="true"
        className={`grid h-5.5 w-5.5 flex-none place-items-center rounded-full text-caption font-bold ${MARK[outcome]}`}
      >
        {outcome === 'pass' ? (
          <Icon name="check" size={12} strokeWidth={3} />
        ) : outcome === 'warn' ? (
          '!'
        ) : (
          <Icon name="x" size={12} strokeWidth={3} />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="block text-caption text-text-2">{detail}</span>
      </span>

      <span className="sr-only">
        {outcome === 'pass' ? 'Passed' : outcome === 'warn' ? 'Warning' : 'Failed'}
      </span>

      {action}
    </div>
  );
}

/* -------------------------------------------------------------- timeline -- */

const DOT: Record<string, string> = {
  brand: 'bg-brand',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-neutral',
};

export interface TimelineRow {
  id: string;
  title: string;
  time: string;
  detail: string;
  tone: string;
}

/** G3's "Event timeline" card body: a 8px dot, a 1px rail, title/time/detail. */
export function Timeline({ events }: { events: readonly TimelineRow[] }) {
  return (
    <ol className="flex flex-col">
      {events.map((event, index) => (
        <li key={event.id} className="grid grid-cols-[16px_1fr] gap-2.5">
          <span className="flex flex-col items-center">
            <span
              aria-hidden="true"
              className={`mt-1.5 h-2 w-2 flex-none rounded-full ${DOT[event.tone] ?? DOT['neutral'] ?? ''}`}
            />
            {index === events.length - 1 ? null : <span className="w-px flex-1 bg-border" />}
          </span>
          <span className={index === events.length - 1 ? '' : 'pb-3.5'}>
            <span className="flex justify-between gap-2 text-caption">
              <span className="font-medium text-text">{event.title}</span>
              <span className="whitespace-nowrap text-text-3">{event.time}</span>
            </span>
            <span className="mt-0.5 block text-caption text-pretty text-text-2">{event.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/* --------------------------------------------------------- segment legend -- */

/**
 * G1's table footer: every segment's swatch and name, with no counts.
 *
 * A key for the bars in the rows above, so the order is `SEG_ORDER`'s and
 * `delivery uncertain` is present whether or not any campaign has one — a
 * legend that appears only when the thing it explains does is a legend nobody
 * has read by the time they need it.
 */
const HATCH_SWATCH = {
  background: 'repeating-linear-gradient(135deg,var(--uncertain) 0 1.5px,transparent 1.5px 4px)',
  outline: '1px dashed var(--uncertain)',
  outlineOffset: '-1px',
};

export function SegmentKeyLegend() {
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {SEG_ORDER.map((seg) => (
        <span key={seg.key} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`h-2.5 w-2.5 flex-none rounded-2 ${seg.fill === 'hatch' ? '' : seg.fill}`}
            style={seg.fill === 'hatch' ? HATCH_SWATCH : undefined}
          />
          {seg.label}
        </span>
      ))}
    </span>
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

/* ------------------------------------------------------------ formatting -- */

export { fmtCount };

/** "48,213" or an em dash. Campaign counts are null until a snapshot exists. */
export function countOrDash(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : fmtCount(value);
}

/** The six buckets folded out of a campaign's counters. */
export function bounceTotal(counts: SegmentCounts | undefined): number {
  return (counts?.soft ?? 0) + (counts?.hard ?? 0);
}

/** An icon name that exists, so a frame's glyph cannot silently become none. */
export const CAMPAIGN_ICON: IconName = 'campaigns';
