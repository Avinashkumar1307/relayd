import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Card, Icon, fmtCount, useToast, type ToastApi } from '@relayd/ui';
import type { PlanSummary, UsageRow } from '../../api/billing.js';

/**
 * The pieces every billing frame repeats.
 *
 * The I frames draw four things over and over — a money amount, a date, the
 * 8px usage meter, and a label/value strip on `--tint` — and each of them is
 * measured off the export exactly once, here.
 */

/**
 * `useToast()` that survives a missing provider.
 *
 * `apps/web/src/main.tsx` does not wrap the app in `<ToastProvider>` yet, and
 * the real hook throws without one — which would take a whole billing page
 * down over a confirmation message. Until main.tsx mounts the provider (it is
 * shared, and not this section's file to edit), the absence degrades to no
 * toast and the page still works. Delete this the day the provider is there.
 */
const NO_TOAST: ToastApi = { toast: () => '', dismiss: () => undefined };

export function useSafeToast(): ToastApi {
  try {
    return useToast();
  } catch {
    return NO_TOAST;
  }
}

/** The tooltip on every control `billing:write` withholds. */
export const OWNER_ONLY_TITLE = 'Only the workspace owner can change billing';
export const READ_ONLY_TITLE = 'Workspace is read-only';

/**
 * "Sept" is not a month. `en-GB` abbreviates September to four letters, so
 * the month comes from this table rather than from the locale — the same
 * rule the analytics section writes down in `routes/analytics/format.ts`.
 */
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function parse(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** An ISO instant → "1 Oct 2026", the form every I frame prints. */
export function formatDate(value: string | null | undefined): string {
  const date = parse(value);
  if (date === null) return '—';
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`;
}

/** "15 Sep" — the dunning card's retry dates, which are all this year. */
export function formatDayMonth(value: string | null | undefined): string {
  const date = parse(value);
  if (date === null) return '—';
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''}`;
}

/**
 * "19, 22 and 26 Sep" — I1b's retry schedule.
 *
 * The month is printed once, at the end, because the frame does: three
 * repetitions of "Sep" in one sentence is noise, and the dates are all in
 * the same month by construction.
 */
export function formatRetrySchedule(dates: string[]): string {
  const parsed = dates.map(parse).filter((date): date is Date => date !== null);
  if (parsed.length === 0) return '—';

  const last = parsed[parsed.length - 1] as Date;
  const month = MONTHS[last.getUTCMonth()] ?? '';
  const days = parsed.map((date) => String(date.getUTCDate()));
  const head = days.slice(0, -1).join(', ');

  return head === '' ? `${days[0]} ${month}` : `${head} and ${days[days.length - 1]} ${month}`;
}

/** "1–19 Sep 2026" — the usage card's period. */
export function formatPeriod(start: string | null | undefined, end: string | null | undefined): string {
  const from = parse(start);
  const to = parse(end);
  if (from === null || to === null) return '—';

  if (from.getUTCMonth() === to.getUTCMonth() && from.getUTCFullYear() === to.getUTCFullYear()) {
    return `${from.getUTCDate()}–${to.getUTCDate()} ${MONTHS[to.getUTCMonth()] ?? ''} ${to.getUTCFullYear()}`;
  }

  return `${formatDayMonth(start)} – ${formatDate(end)}`;
}

/** "08/2028" — the card expiry. */
export function formatExpiry(month: number | null | undefined, year: number | null | undefined): string {
  if (month === null || month === undefined || year === null || year === undefined) return '—';
  return `${String(month).padStart(2, '0')}/${year}`;
}

/**
 * Minor units to a readable amount. Stripe gives cents; nobody reads cents.
 *
 * `Intl` throws a RangeError for anything that is not three letters, and a
 * truncated currency code from a misconfigured account must not take the
 * billing page down with it.
 */
export function formatMoney(minorUnits: number, currency: string): string {
  const amount = minorUnits / 100;

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** The whole-unit form the plan columns use: "$249", never "$249.00". */
export function formatWholeMoney(minorUnits: number, currency: string): string {
  const amount = minorUnits / 100;

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency.toUpperCase()}`;
  }
}

/** A feature key the way a person says it. */
export function featureLabel(key: string): string {
  const labels: Record<string, string> = {
    'emails.sent': 'Emails sent',
    'contacts.stored': 'Contacts',
    'campaigns.per_month': 'Campaigns this month',
    'campaigns.sending_pools': 'Sending pools',
    'campaigns.ab_testing': 'A/B testing',
    'tracking.custom_domains': 'Custom tracking domains',
    'api.access': 'API access',
    'api.webhooks': 'Outbound webhooks',
    'workspace.seats': 'Seats',
    'analytics.retention_days': 'Analytics retention',
    'support.priority': 'Priority support',
    'providers.connections': 'Provider connections',
  };

  return labels[key] ?? key;
}

/** "13-month retention" from a day count, because nobody counts 395 days. */
export function retentionLabel(days: number | null | undefined): string {
  if (days === null || days === undefined) return 'Custom';
  const months = Math.round(days / 30.4375);
  return `${months} month${months === 1 ? '' : 's'}`;
}

/** What one plan includes, as I1a's one-line summary of the current plan. */
export function planInclusions(plan: PlanSummary | undefined): string {
  if (plan === undefined) return '';

  const parts: string[] = [];
  const emails = plan.limits['emails.sent'];
  const contacts = plan.limits['contacts.stored'];
  const seats = plan.limits['workspace.seats'];
  const retention = plan.limits['analytics.retention_days'];

  if (emails !== undefined && emails !== null) parts.push(`${fmtCount(emails)} emails`);
  if (contacts !== undefined && contacts !== null) parts.push(`${fmtCount(contacts)} contacts`);
  if (seats !== undefined && seats !== null) parts.push(`${seats} seats`);
  if (retention !== undefined && retention !== null) {
    parts.push(`${retentionLabel(retention).replace(' months', '-month')} retention`);
  }

  return parts.join(', ');
}

/**
 * The 8px usage meter: `height: 8; radius: 4; background: --neutral-soft`
 * with a `--brand` fill, exactly as I1a and I1m draw it.
 *
 * An unlimited feature gets no bar. A progress bar at 0% reads as "you have
 * nothing" and one at 100% reads as "you are out"; neither is true of
 * unlimited.
 */
export function UsageMeter({ row, note }: { row: UsageRow; note: ReactNode }) {
  const unlimited = row.included === null;
  const percent = unlimited ? 0 : Math.min(100, Math.round((row.used / Math.max(1, row.included ?? 1)) * 100));

  return (
    <div className="min-w-0">
      <div className="flex justify-between gap-2 text-ui">
        <span className="truncate text-text-2">{featureLabel(row.featureKey)}</span>
        <span className="flex-none tabular-nums">
          <span className="font-semibold">{fmtCount(row.used)}</span>{' '}
          <span className="text-text-2">{unlimited ? 'used' : `/ ${fmtCount(row.included ?? 0)}`}</span>
        </span>
      </div>

      {unlimited ? null : (
        <div
          role="progressbar"
          aria-label={featureLabel(row.featureKey)}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          className="mt-2 h-2 overflow-hidden rounded-4 bg-neutral-soft"
        >
          <div className="h-full rounded-4 bg-brand" style={{ width: `${percent}%` }} />
        </div>
      )}

      <div className="mt-1.5 flex justify-between gap-2 text-caption text-text-2">
        <span>{unlimited ? 'Unlimited' : `${percent}% used`}</span>
        <span className="text-right">{note}</span>
      </div>
    </div>
  );
}

/**
 * A card with the 20px padding the I frames measure.
 *
 * `Card` from the design system is the surface — border, radius and
 * background, all four values read off the sheet — but its padding is fixed
 * at the dashboard's 18/16 and every card in section I is drawn at 20. So
 * this is `Card flush` (the variant that drops the padding) with the frame's
 * own padding inside, rather than a second card.
 */
export function Panel({
  children,
  className = '',
  pad = 'p-5',
}: {
  children: ReactNode;
  className?: string;
  /** Override for the two frames that pad differently: I9a's 18/20, I9b's 28. */
  pad?: string;
}) {
  return (
    <Card flush className={className}>
      <div className={pad}>{children}</div>
    </Card>
  );
}

/**
 * The label/value strip on `--tint` that I4, I5a, I5b, I5c and I9b all use:
 * `padding: 12px 14px; radius: 8; font-size: 13`, rows `justify-between`.
 */
export function DetailStrip({ rows }: { rows: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="m-0 flex w-full flex-col gap-1.5 rounded-control bg-tint px-3.5 py-3 text-left text-ui">
      {rows.map((row, index) => (
        <div key={index} className="flex justify-between gap-2">
          <dt className="text-text-2">{row.label}</dt>
          <dd className="m-0 text-right font-medium">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The centred card I4, I5a/b/c and I6 are all drawn on: 560 wide, 56px down
 * the page, 36px of padding, everything centred.
 */
export function StatusCard({
  tone,
  icon,
  title,
  description,
  children,
  actions,
  footnote,
}: {
  tone: 'brand' | 'success' | 'warning' | 'neutral';
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  footnote?: ReactNode;
}) {
  // I5a's spinner has no tile behind it — 44px, brand, nothing else. The
  // three settled states are the 48px `radius: 12` tile on their own soft.
  const TILE: Record<'brand' | 'success' | 'warning' | 'neutral', string> = {
    brand: 'h-11 w-11 text-brand',
    success: 'h-12 w-12 rounded-card bg-success-soft text-success-text',
    warning: 'h-12 w-12 rounded-card bg-warning-soft text-warning-text',
    neutral: 'h-12 w-12 rounded-card bg-neutral-soft text-text-2',
  };

  return (
    <div className="mx-auto mt-8 flex max-w-140 flex-col items-center gap-3.5 rounded-card border border-border bg-surface px-6 py-9 text-center sm:mt-14 sm:px-9">
      <span className={`grid flex-none place-items-center ${TILE[tone]}`}>{icon}</span>

      <div>
        <div className="text-section font-semibold leading-heading">{title}</div>
        <p className="mt-2 mb-0 text-pretty text-ui text-text-2">{description}</p>
      </div>

      {children}

      {actions === undefined ? null : <div className="flex flex-wrap justify-center gap-2">{actions}</div>}

      {footnote === undefined ? null : <div className="text-caption text-text-3">{footnote}</div>}
    </div>
  );
}

/**
 * A clock, which `@relayd/ui`'s ICON_PATHS does not have and I5c and I9a
 * both draw. Same geometry as every icon there: 24-box, currentColor, round
 * caps, `aria-hidden`.
 */
export function ClockGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

/** The `← Billing` link above every sub-page title. */
export function BackToBilling() {
  return (
    <Link to="/billing" className="text-ui font-medium text-brand no-underline">
      ← Billing
    </Link>
  );
}

/** The card brand chip: 44×30 on the navy, 10/600, letter-spaced. */
export function CardBrand({ brand, size = 'sm' }: { brand: string | null; size?: 'sm' | 'lg' }) {
  return (
    <span
      className={[
        'grid flex-none place-items-center bg-sidebar font-semibold tracking-pill text-white uppercase',
        size === 'lg' ? 'h-9.5 w-14 rounded-control text-label' : 'h-7.5 w-11 rounded-badge text-pill',
      ].join(' ')}
    >
      {brand ?? 'CARD'}
    </span>
  );
}

/** The footnote every card-bearing frame prints under a fact it qualifies. */
export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 flex items-start gap-2 border-t border-border pt-3 text-caption text-text-2">
      <Icon name="info" size={14} strokeWidth={2} className="mt-0.5 flex-none" />
      <span className="text-pretty">{children}</span>
    </div>
  );
}
