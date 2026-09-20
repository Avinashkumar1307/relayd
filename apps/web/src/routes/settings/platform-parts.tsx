import type { ReactNode } from 'react';
import type { StateStyle } from '@relayd/ui';
import type { WebhookEndpoint } from '../../api/platform.js';

/**
 * The pieces J3 (API keys) and J4 (webhooks) both draw.
 *
 * Two pages, one vocabulary: the mono scope/event chip, the four endpoint
 * states, and the date forms the frames print. Measured off the export once,
 * here, rather than twice in two files that would drift.
 */

/* ------------------------------------------------------------------ */
/* Dates, as the J frames print them                                   */
/* ------------------------------------------------------------------ */

/**
 * "Sept" is not a month. `en-GB` abbreviates September to four letters, so
 * the month comes from this table rather than from the locale — the same
 * rule `routes/analytics/format.ts` and `routes/billing/parts.tsx` write
 * down for their own sections.
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

/** "2 Jun 2026" — J3a's Created column. */
export function formatDate(value: string | null | undefined): string {
  const date = parse(value);
  if (date === null) return '—';
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`;
}

/**
 * The parts of an instant in a given zone.
 *
 * Every J4 timestamp is printed in the workspace's own zone, not the
 * reader's: "06:12" in a browser set to Lisbon is a different moment from
 * the one the endpoint was disabled at, and the on-call rota that has to
 * act on it runs on the workspace's clock.
 */
function zoned(date: Date, timeZone: string | null): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
    ...(timeZone === null ? {} : { timeZone }),
  }).formatToParts(date);

  const out: Record<string, string> = {};
  for (const part of parts) out[part.type] = part.value;
  return out;
}

const monthOf = (parts: Record<string, string>): string =>
  MONTHS[Number(parts['month'] ?? '0') - 1] ?? '';

/** "17 Sep, 06:12" — J4a's Last delivery when it is not today. */
export function formatDayTime(value: string | null | undefined, timeZone: string | null): string {
  const date = parse(value);
  if (date === null) return '—';
  const parts = zoned(date, timeZone);
  return `${parts['day'] ?? ''} ${monthOf(parts)}, ${parts['hour'] ?? ''}:${parts['minute'] ?? ''}`;
}

/** "20 Sep 2026 09:14" — J3c's "created by Dana Haddad, …". */
export function formatDateTime(value: string | null | undefined, timeZone: string | null): string {
  const date = parse(value);
  if (date === null) return '—';
  const parts = zoned(date, timeZone);
  return `${parts['day'] ?? ''} ${monthOf(parts)} ${parts['year'] ?? ''} ${parts['hour'] ?? ''}:${parts['minute'] ?? ''}`;
}

/** "17 Sep" on its own — J4c's "kept for 7 days (until 24 Sep)". */
export function formatDayMonth(value: string | null | undefined, timeZone: string | null): string {
  const date = parse(value);
  if (date === null) return '—';
  const parts = zoned(date, timeZone);
  return `${parts['day'] ?? ''} ${monthOf(parts)}`;
}

/** "17 Sep, 06:12:04" — J4c's Time column, to the second. */
export function formatDayTimeSeconds(
  value: string | null | undefined,
  timeZone: string | null,
): string {
  const date = parse(value);
  if (date === null) return '—';
  const parts = zoned(date, timeZone);
  return `${formatDayTime(value, timeZone)}:${parts['second'] ?? ''}`;
}

/**
 * "17 Sep 2026, 06:12 GST" — J4c's banner, in the workspace's own zone.
 *
 * The zone abbreviation is the point: "06:12" in the reader's zone is a
 * different moment from the one the endpoint was disabled at, and the
 * customer's on-call rota runs on the workspace's clock.
 */
export function formatInstant(value: string | null | undefined, timeZone: string | null): string {
  const date = parse(value);
  if (date === null) return '—';

  const parts = zoned(date, timeZone);
  const zone = parts['timeZoneName'] ?? '';

  return `${parts['day'] ?? ''} ${monthOf(parts)} ${parts['year'] ?? ''}, ${parts['hour'] ?? ''}:${parts['minute'] ?? ''}${zone === '' ? '' : ` ${zone}`}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "4 minutes ago", "2 days ago" — J3a's Last used, which is always relative
 * because the question it answers is "is this key still in use", not "on
 * what date".
 */
export function formatAgo(value: string | null | undefined): string {
  const date = parse(value);
  if (date === null) return 'Never';

  const elapsed = Date.now() - date.getTime();
  if (elapsed < MINUTE) return 'Just now';
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(elapsed / DAY);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * "2 min ago", "3 hours ago", then "17 Sep, 06:12", then "2 Aug 2026" —
 * J4a's Last delivery, which switches to an absolute time once "ago" stops
 * being the useful answer.
 */
export function formatLastDelivery(
  value: string | null | undefined,
  timeZone: string | null,
): string {
  const date = parse(value);
  if (date === null) return '—';

  const elapsed = Date.now() - date.getTime();
  if (elapsed < MINUTE) return 'Just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (elapsed < 7 * DAY) return formatDayTime(value, timeZone);
  return formatDate(value);
}

/** "99.8%", "100%", "12.4%" — J4a prints a whole number when it is one. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

/** "1,334" — thousands separated, as every count in the J frames is. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/* ------------------------------------------------------------------ */
/* The mono chip both tables use                                       */
/* ------------------------------------------------------------------ */

/**
 * `contacts:write`, `hard_bounced`, `*` — 20px, 11px mono on the neutral
 * tint, as J3a's Scopes and J4a's Events columns draw it.
 */
export function CodeChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 items-center rounded-badge bg-neutral-soft px-1.5 font-mono text-label text-neutral-text">
      {children}
    </span>
  );
}

/**
 * The toggleable form of the same chip: J3b's scope picker and J4b's event
 * picker are both a wrapped row of these, a 14px box then the mono name.
 *
 * A real `<input type="checkbox">` sits behind the drawn box so the keyboard
 * and assistive tech see a checkbox rather than a styled button — the frames
 * draw a `<button>`, but what this is, is a checkbox.
 */
export function CheckChip({
  value,
  checked,
  onChange,
  disabled = false,
  title,
}: {
  value: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  title?: string | undefined;
}) {
  return (
    <label
      title={title}
      className={[
        'inline-flex h-[26px] items-center gap-1.5 rounded-badge border py-0 pr-2 pl-1.5 font-mono text-label',
        disabled ? 'cursor-not-allowed text-text-3' : 'cursor-pointer text-text',
        checked ? 'border-brand bg-brand-soft' : 'border-border bg-surface',
      ].join(' ')}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={[
          'grid h-3.5 w-3.5 flex-none place-items-center rounded-4 border',
          checked ? 'border-brand bg-brand text-on-brand' : 'border-border bg-surface',
        ].join(' ')}
      >
        {checked ? (
          <svg viewBox="0 0 24 24" width={10} height={10} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : null}
      </span>
      {value}
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* J3b — the scope groups                                              */
/* ------------------------------------------------------------------ */

/**
 * The six rows J3b draws, and the resources that fall in each.
 *
 * The server decides which scopes exist and which this person may grant
 * (`GET /api-keys/scopes`); this table only decides which row each one is
 * printed on. A scope whose resource is not listed here lands in the last
 * group rather than disappearing — a permission the UI has not heard of is
 * exactly the one somebody needs to see before they grant it.
 */
export const SCOPE_GROUPS: readonly { label: string; resources: readonly string[] }[] = [
  { label: 'Contacts', resources: ['contact', 'contacts'] },
  { label: 'Lists & segments', resources: ['list', 'lists', 'segment', 'segments'] },
  { label: 'Campaigns', resources: ['campaign', 'campaigns'] },
  { label: 'Templates', resources: ['template', 'templates'] },
  { label: 'Suppressions', resources: ['suppression', 'suppressions'] },
  {
    label: 'Reports & webhooks',
    resources: ['report', 'reports', 'analytics', 'webhook', 'webhooks'],
  },
];

/** The row anything unrecognised lands on. Never rendered when empty. */
const OTHER_SCOPES = 'Workspace';

export interface ScopeGroup {
  label: string;
  scopes: string[];
}

/**
 * Buckets the grantable scopes into J3b's rows.
 *
 * `billing:*` is dropped on the way through. CLAUDE.md section 11:
 * `billing:write` can never be attached to an API key, and the modal says so
 * in words rather than leaving a gap where a row would be.
 */
export function groupScopes(scopes: readonly string[]): ScopeGroup[] {
  const groups: ScopeGroup[] = SCOPE_GROUPS.map((group) => ({ label: group.label, scopes: [] }));
  const other: string[] = [];

  for (const scope of scopes) {
    if (scope.startsWith('billing:')) continue;

    const resource = scope.split(':')[0] ?? scope;
    const index = SCOPE_GROUPS.findIndex((group) => group.resources.includes(resource));

    if (index === -1) other.push(scope);
    else (groups[index] as ScopeGroup).scopes.push(scope);
  }

  if (other.length > 0) groups.push({ label: OTHER_SCOPES, scopes: other });
  return groups.filter((group) => group.scopes.length > 0);
}

/* ------------------------------------------------------------------ */
/* J4 — the endpoint's four states and its event groups                */
/* ------------------------------------------------------------------ */

/**
 * The status column of J4a.
 *
 * `disabled` is ours and `paused` is theirs, and the labels keep them apart:
 * "Auto-disabled" in warning is something to fix, "Disabled" in neutral is
 * something somebody chose. `failing` is still trying.
 */
export const ENDPOINT_STATES: Readonly<Record<string, StateStyle>> = {
  active: { label: 'Active', tone: 'success' },
  failing: { label: 'Failing', tone: 'warning', pulse: true },
  disabled: { label: 'Auto-disabled', tone: 'warning' },
  paused: { label: 'Disabled', tone: 'neutral' },
};

/** True when we stopped an endpoint, rather than the customer. */
export const isAutoDisabled = (endpoint: WebhookEndpoint): boolean => endpoint.status === 'disabled';

/** Every state in which we are not sending to this endpoint. */
export const isOff = (endpoint: WebhookEndpoint): boolean =>
  endpoint.status === 'disabled' || endpoint.status === 'paused';

/**
 * The three groups J4b draws over the event list, and the events in each.
 *
 * Same contract as the scope groups: the server says which events exist
 * (`GET /webhook-endpoints/event-types`), this says where each is printed,
 * and anything unrecognised lands in the last group rather than vanishing.
 */
export const EVENT_GROUPS: readonly { label: string; events: readonly string[] }[] = [
  {
    label: 'Delivery',
    events: ['sent', 'delivered', 'soft_bounced', 'hard_bounced', 'complained', 'delivery_uncertain'],
  },
  { label: 'Engagement', events: ['opened', 'clicked', 'unsubscribed'] },
  {
    label: 'Campaign',
    events: [
      'campaign.launched',
      'campaign.paused',
      'campaign.completed',
      'campaign.failed',
      'import.completed',
    ],
  },
];

export interface EventGroup {
  label: string;
  events: string[];
}

export function groupEvents(eventTypes: readonly string[]): EventGroup[] {
  const groups: EventGroup[] = EVENT_GROUPS.map((group) => ({ label: group.label, events: [] }));
  const other: string[] = [];

  for (const type of eventTypes) {
    const index = EVENT_GROUPS.findIndex((group) => group.events.includes(type));
    if (index === -1) other.push(type);
    else (groups[index] as EventGroup).events.push(type);
  }

  if (other.length > 0) groups.push({ label: 'Other', events: other });
  return groups.filter((group) => group.events.length > 0);
}

/** The 11px uppercase caption over each group in J4b. */
export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-label font-semibold tracking-label text-text-3 uppercase">{children}</div>
  );
}
