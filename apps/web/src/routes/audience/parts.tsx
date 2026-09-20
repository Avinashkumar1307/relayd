import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Icon } from '@relayd/ui';
import type { ButtonVariant, IconName } from '@relayd/ui';
import type { TagRef } from '../../api/audience-extra.js';

/**
 * The pieces section D's frames draw that the design-system sheet does not
 * carry: a tag pill with the tag's own colour, the list card's sparkline,
 * the filter chips D7 puts above its table, the drawer's uppercase section
 * labels and its suppression strip, and the table footer's page controls.
 *
 * Every measurement here is read off `.design-rendered/frames/D/*.html`.
 * Nothing in this file re-implements something `@relayd/ui` already exports.
 *
 * A tag's dot colour is inline rather than a utility class on purpose: it is
 * a value the workspace chose and stored, the same way the frames render it
 * (`background: rgb(14, 165, 233)`), not a colour invented here.
 */

/* --------------------------------------------------------- link button -- */

const VARIANT: Record<'primary' | 'secondary', string> = {
  primary: 'border-transparent bg-brand text-on-brand hover:bg-brand-hover',
  secondary: 'border-border bg-surface text-text hover:bg-tint',
};

/**
 * A `Button` that navigates.
 *
 * D1's Import and D1e's "Import contacts" are `<a>` in the export, and
 * `@relayd/ui`'s Button only renders a `<button>`. Rather than wire a click
 * handler to `navigate()` — which loses middle-click, the status bar and
 * open-in-new-tab — this borrows the same geometry and the two variants it
 * needs. Reported under uiGaps: Button should take an `as="a"`.
 */
export function LinkButton({
  to,
  variant = 'primary',
  children,
}: {
  to: string;
  variant?: Extract<ButtonVariant, 'primary' | 'secondary'>;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={`inline-flex h-8.5 items-center justify-center gap-1.5 whitespace-nowrap rounded-control border px-3 text-ui font-medium no-underline ${VARIANT[variant]}`}
    >
      {children}
    </Link>
  );
}

/* --------------------------------------------------- segmented toggle -- */

/**
 * D3's Cards / Table switch: one bordered group, 32px tall, the chosen half
 * on `--brand-soft` in `--brand` and a 1px rule between them.
 *
 * Not `Tabs`: these do not filter the table underneath, they choose how the
 * same rows are drawn, and the frame gives them a control's chrome rather
 * than an underline.
 */
export function SegmentedToggle<T extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  className?: string;
}) {
  return (
    <span role="group" aria-label={label} className={`overflow-hidden rounded-control border border-border text-caption ${className === '' ? 'inline-flex' : className}`}>
      {options.map((option, index) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(option.value)}
            className={[
              'grid h-8 cursor-pointer place-items-center border-0 px-2.5',
              index === 0 ? '' : 'border-l border-border',
              on ? 'bg-brand-soft font-medium text-brand' : 'bg-surface text-text-2',
            ].join(' ')}
          >
            {option.label}
          </button>
        );
      })}
    </span>
  );
}

/* ----------------------------------------------------------- tag pills -- */

/** D1's table pill: 20px tall, 11px text, the tag's dot at 6px. */
export function TagPill({ tag }: { tag: TagRef }) {
  return (
    <span className="inline-flex h-5 items-center gap-[5px] whitespace-nowrap rounded-badge border border-border px-[7px] text-label">
      <Dot color={tag.color} />
      {tag.name}
    </span>
  );
}

/** D2's header pill: the same thing at 22px and 12px, beside the state badge. */
export function TagChip({ tag }: { tag: TagRef }) {
  return (
    <span className="inline-flex h-[22px] items-center gap-[5px] whitespace-nowrap rounded-badge border border-border px-2 text-caption">
      <Dot color={tag.color} />
      {tag.name}
    </span>
  );
}

export function Dot({ color, size = 6 }: { color: string | null; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex-none rounded-full"
      style={{ width: size, height: size, background: color ?? 'var(--text-3)' }}
    />
  );
}

/** The dashed "+ Tag" affordance on the drawer header. */
export function AddTagChip({ onClick, disabled, title }: { onClick: () => void; disabled: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'inline-flex h-[22px] items-center rounded-badge border border-dashed border-border px-2 text-caption text-text-2',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-tint',
      ].join(' ')}
    >
      + Tag
    </button>
  );
}

/** D2's Lists row: a solid neutral chip, 24px tall. */
export function ListChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-6 items-center rounded-badge bg-neutral-soft px-2 text-caption font-medium text-neutral-text">
      {children}
    </span>
  );
}

/* ------------------------------------------------------------ sparkline -- */

/**
 * The 120×32 trend on a D3 list card.
 *
 * The frame's polyline is drawn in a `0 0 100 32` box with
 * `preserveAspectRatio="none"`, so the points are a percentage of the width
 * and the stroke stays 1.5 through `vector-effect`.
 */
export function Sparkline({ points, label }: { points: readonly number[]; label: string }) {
  if (points.length < 2) return <span className="block h-8 w-[120px]" />;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min === 0 ? 1 : max - min;
  const step = 100 / (points.length - 1);

  const path = points
    .map((value, index) => `${(index * step).toFixed(1)},${(28 - ((value - min) / span) * 24).toFixed(1)}`)
    .join(' ');

  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" width={120} height={32} className="block" role="img" aria-label={label}>
      <polyline fill="none" stroke="var(--brand)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" points={path} />
    </svg>
  );
}

/* --------------------------------------------------------- filter chips -- */

/**
 * D7's "Reason All ⌄" chip.
 *
 * A real `<select>` inside the chip rather than a menu: it is a single
 * choice from a short fixed list, which is what a select is for, and it
 * gets the keyboard and the mobile picker for nothing. The native control
 * is transparent and stretched over the chip so the frame's chrome shows
 * through; the label and value below it are what is read.
 */
export function FilterChip({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (next: string) => void;
}) {
  const current = options.find((option) => option.value === value);

  return (
    <span className="relative inline-flex h-7 items-center gap-1.5 rounded-control border border-border bg-tint px-2.5 text-caption text-text">
      {label}
      <span className="font-medium">{current?.label ?? value}</span>
      <Icon name="chevronDown" size={12} className="text-text-2" />
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/* --------------------------------------------------------- table footer -- */

/** "Rows per page 50 ⌄" — the same chip at 26px, on the footer row. */
export function RowsPerPage({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  return (
    <span className="inline-flex items-center gap-2">
      Rows per page
      <span className="relative inline-flex h-[26px] items-center gap-1 rounded-badge border border-border bg-surface px-2 text-text">
        {value}
        <Icon name="chevronDown" size={12} className="text-text-2" />
        <select
          aria-label="Rows per page"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="absolute inset-0 cursor-pointer opacity-0"
        >
          {[25, 50, 100].map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </span>
    </span>
  );
}

/** The ‹ › pair: one bordered group, 28×26 each, split by a 1px rule. */
export function Pager({
  onPrevious,
  onNext,
  canGoBack,
  canGoForward,
}: {
  onPrevious: () => void;
  onNext: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
}) {
  const cell = 'grid h-[26px] w-7 place-items-center bg-transparent p-0';

  return (
    <span className="inline-flex overflow-hidden rounded-badge border border-border">
      <button
        type="button"
        onClick={onPrevious}
        disabled={!canGoBack}
        aria-label="Previous page"
        className={`${cell} border-0 border-r border-border ${canGoBack ? 'cursor-pointer text-text hover:bg-tint' : 'cursor-not-allowed text-text-3'}`}
      >
        ‹
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={!canGoForward}
        aria-label="Next page"
        className={`${cell} border-0 ${canGoForward ? 'cursor-pointer text-text hover:bg-tint' : 'cursor-not-allowed text-text-3'}`}
      >
        ›
      </button>
    </span>
  );
}

/* --------------------------------------------------------------- drawer -- */

/** The drawer's 12/600 uppercase rule: PROFILE, LISTS, ENGAGEMENT TIMELINE. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 text-caption font-semibold uppercase tracking-label text-text-3">{children}</div>
  );
}

export function FieldPair({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-caption text-text-2">{label}</div>
      <div>{value}</div>
    </div>
  );
}

/**
 * The strip under the drawer header: tint when the contact is sendable
 * (D2a), danger when it is not (D2b). Full-bleed, so it cancels the
 * drawer body's padding rather than sitting inside it.
 */
export function SuppressionStrip({
  tone,
  icon,
  headline,
  detail,
}: {
  tone: 'neutral' | 'danger';
  icon: IconName;
  headline: string;
  detail: string;
}) {
  const danger = tone === 'danger';

  return (
    <div
      role={danger ? 'alert' : 'status'}
      className={[
        '-mx-5 -mt-4 mb-1 flex items-center gap-2.5 border-b px-6 py-2.5 text-ui',
        danger ? 'border-danger-text bg-danger-soft text-danger-text' : 'border-border bg-tint text-text-2',
      ].join(' ')}
    >
      <Icon name={icon} size={16} className="flex-none" />
      <span className="flex-1">
        <span className="font-semibold">{headline}</span>{' '}
        <span className={danger ? 'text-text-2' : 'text-text-2'}>{detail}</span>
      </span>
    </div>
  );
}

/** One row of D2's engagement timeline: dot, rail, badge, time, detail. */
export function TimelineRow({
  color,
  badge,
  when,
  detail,
  last,
}: {
  color: string;
  badge: ReactNode;
  when: string;
  detail: string;
  last: boolean;
}) {
  return (
    <div className="grid min-h-11 grid-cols-[20px_1fr] gap-2.5">
      <div className="flex flex-col items-center">
        <span aria-hidden="true" className="mt-[7px] h-2 w-2 flex-none rounded-full" style={{ background: color }} />
        {last ? null : <span aria-hidden="true" className="w-px flex-1 bg-border" />}
      </div>
      <div className="pb-3">
        <div className="flex justify-between gap-2">
          <span>{badge}</span>
          <span className="whitespace-nowrap text-caption text-text-3">{when}</span>
        </div>
        <div className="mt-1 text-caption text-text-2">{detail}</div>
      </div>
    </div>
  );
}
