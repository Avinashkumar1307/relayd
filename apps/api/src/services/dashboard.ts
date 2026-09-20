import type {
  BounceSplitRow,
  DashboardCampaignRow,
  EnforcementRow,
  ProviderConnectionRow,
} from '@relayd/db';

/**
 * The dashboard's composition (design frames C1–C4).
 *
 * Pure. Every function here takes rows and returns the shape the browser
 * draws, so the arithmetic, the labels and the "needs attention" rules are
 * testable against fixtures rather than against a database. The service
 * beside this does the reads and nothing else.
 *
 * Two rules the whole file obeys:
 *
 *   **Nothing is counted here.** Every number arrives from a rollup —
 *   `campaign_counters`, `campaign_stats`, `campaign_daily_stats`,
 *   `provider_stats`, `usage_aggregates`. Nothing walks `email_events` and
 *   nothing counts `campaign_recipients` (CLAUDE.md section 12).
 *
 *   **The server owns the sentences.** `renewsLabel`, `when`, the attention
 *   copy: the frames print them as given, and computing them here means one
 *   place gets the pluralisation, the rounding and the timezone right
 *   instead of every component getting it slightly differently.
 */

export interface DashboardPeriod {
  label: string;
  timezone: string;
  comparedTo: string;
}

export interface DashboardUsage {
  sent: number;
  limit: number;
  renewsLabel: string;
  renewsShort: string;
  uncertain: number;
}

export interface DashboardProvider {
  connectionId: string;
  code: string;
  name: string;
  label: string;
  health: 'healthy' | 'degraded' | 'failed';
  sentToday: number;
  dailyLimit: number | null;
}

export interface DashboardCampaignCounts {
  delivered?: number;
  pending?: number;
  queued?: number;
  sending?: number;
  soft?: number;
  hard?: number;
  complaint?: number;
  failed?: number;
  uncertain?: number;
}

export interface DashboardCampaign {
  id: string;
  name: string;
  state: string;
  when: string;
  recipients: number | null;
  counts: DashboardCampaignCounts;
  clickRate: number | null;
}

export interface AttentionItem {
  id: string;
  tone: 'danger' | 'warning' | 'info';
  title: string;
  detail: string;
  action: { label: string; href: string } | null;
}

export interface DashboardSummary {
  period: DashboardPeriod;
  usage: DashboardUsage;
  deltas: { click: number | null; open: number | null };
  bounceSplit: { soft: number; hard: number } | null;
  complaintThreshold: number;
  providers: DashboardProvider[];
  campaigns: DashboardCampaign[];
  attention: AttentionItem[];
  suppressions: { applied: number; note: string } | null;
}

/**
 * The auto-pause line on the complaint meter.
 *
 * 0.3%, from CLAUDE.md section 11's launch anti-abuse set. Sent to the
 * browser rather than hard-coded there so the threshold lives in one place
 * and a change to it does not need a frontend deploy to be visible.
 */
export const COMPLAINT_THRESHOLD = 0.003;

/** How many campaign rows C1 lists. */
export const DASHBOARD_CAMPAIGNS = 8;

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

const PROVIDER_LABEL: Readonly<Record<string, { name: string; code: string }>> = {
  ses: { name: 'Amazon SES', code: 'SES' },
  sendgrid: { name: 'SendGrid', code: 'SG' },
  mailgun: { name: 'Mailgun', code: 'MG' },
  brevo: { name: 'Brevo', code: 'BR' },
  smtp: { name: 'SMTP', code: 'SMTP' },
  google: { name: 'Google Workspace', code: 'GW' },
};

// --------------------------------------------------------------------- dates

/**
 * The parts of an instant in a named zone.
 *
 * `Intl` rather than arithmetic, because the offset for a zone on a date is
 * not something to reimplement. An unknown zone — a workspace row edited by
 * hand, an IANA name dropped in a Node upgrade — falls back to UTC rather
 * than throwing: a dashboard that 500s because a timezone string is stale is
 * a worse failure than a dashboard labelled in UTC.
 */
export function partsIn(date: Date, timeZone: string): { year: number; month: number; day: number } {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });

    const parts = formatter.formatToParts(date);
    const value = (type: string): number =>
      Number(parts.find((part) => part.type === type)?.value ?? '0');

    return { year: value('year'), month: value('month'), day: value('day') };
  } catch {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
  }
}

/** "19 Sep". Hand-rolled so the output does not depend on the container's ICU data. */
export function dayMonth(date: Date, timeZone: string): string {
  const { month, day } = partsIn(date, timeZone);
  return `${day} ${MONTHS[month - 1] ?? '???'}`;
}

/** "1–19 Sep 2026", collapsing the month and year when both ends share them. */
export function periodLabel(from: Date, to: Date, timeZone: string): string {
  const start = partsIn(from, timeZone);
  const end = partsIn(to, timeZone);

  const endLabel = `${end.day} ${MONTHS[end.month - 1] ?? '???'} ${end.year}`;

  if (start.year === end.year && start.month === end.month) {
    return `${start.day}–${endLabel}`;
  }

  const startLabel = `${start.day} ${MONTHS[start.month - 1] ?? '???'}${
    start.year === end.year ? '' : ` ${start.year}`
  }`;

  return `${startLabel} – ${endLabel}`;
}

/** The UTC day a rollup is keyed by. Storage is UTC; only labels convert. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function wholeDaysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / 86_400_000));
}

// -------------------------------------------------------------------- period

/**
 * The window the dashboard describes: the billing period, not a calendar month.
 *
 * "74% · renews 1 Oct" only makes sense against the period the allowance
 * resets on. A workspace with no subscription has no such period, so it falls
 * back to the calendar month — which is what its usage counter is keyed by
 * anyway.
 */
export function resolvePeriod(input: {
  now: Date;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  timezone: string;
}): { start: Date; end: Date; period: DashboardPeriod } {
  const start =
    input.currentPeriodStart ??
    new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), 1));

  const end =
    input.currentPeriodEnd ??
    new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth() + 1, 1));

  // The comparison is the period before this one, named by the month it
  // mostly fell in. "Aug" is what C1 prints under a delta.
  const previousMidpoint = new Date(start.getTime() - (end.getTime() - start.getTime()) / 2);

  return {
    start,
    end,
    period: {
      // The label stops at today, not at the period end: a customer reading
      // "1–30 Sep" on the 19th would take the numbers for a full month.
      label: periodLabel(start, min(input.now, end), input.timezone),
      timezone: input.timezone,
      comparedTo: MONTHS[partsIn(previousMidpoint, input.timezone).month - 1] ?? '',
    },
  };
}

function min(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

// --------------------------------------------------------------------- usage

export function buildUsage(input: {
  sent: number;
  limit: number | null;
  uncertain: number;
  periodEnd: Date;
  now: Date;
  timezone: string;
}): DashboardUsage {
  const renews = dayMonth(input.periodEnd, input.timezone);
  const days = wholeDaysBetween(input.now, input.periodEnd);

  // An unlimited plan is reported as a limit of zero, which is what the
  // browser's `limit: number` can express — and the percentage is omitted
  // rather than computed against it. A percentage of unlimited is not a
  // number, and rendering one as 0% would read as "no allowance left".
  const limit = input.limit ?? 0;
  const percent = limit > 0 ? Math.min(100, Math.round((input.sent / limit) * 100)) : null;

  const countdown = days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;

  return {
    sent: input.sent,
    limit,
    renewsLabel:
      percent === null
        ? `Renews ${renews} (${countdown})`
        : `${percent}% · renews ${renews} (${countdown})`,
    renewsShort: `Renews ${renews}`,
    uncertain: input.uncertain,
  };
}

// ------------------------------------------------------------------ campaigns

/** A campaign's segment counts, from the counters and the rollup. Never a COUNT(*). */
export function countsFor(row: DashboardCampaignRow): DashboardCampaignCounts {
  const counts: DashboardCampaignCounts = {};

  // Only non-zero segments are emitted. The browser renders a bar per key it
  // finds, and a zero-width segment with a tooltip saying "0 hard bounces" is
  // noise on every healthy campaign.
  const put = (key: keyof DashboardCampaignCounts, value: number | undefined): void => {
    if (value !== undefined && value > 0) counts[key] = value;
  };

  put('pending', row.counters?.pending);
  put('queued', row.counters?.queued);
  put('sending', row.counters?.sending);
  put('failed', row.counters?.failed);
  put('uncertain', row.counters?.uncertain);

  put('delivered', row.stats?.delivered);
  put('soft', row.stats?.bouncedSoft);
  put('hard', row.stats?.bouncedHard);
  put('complaint', row.stats?.complained);

  return counts;
}

/**
 * The line under a campaign's name.
 *
 * Built from the timestamp that matches the state rather than from one
 * "updated" field, because "Paused 16 Sep, 11:12" and "Started today, 09:00"
 * answer different questions and a single relative time answers neither.
 */
export function whenFor(row: DashboardCampaignRow, now: Date, timeZone: string): string {
  const at = (date: Date, prefix: string): string => {
    const today = partsIn(now, timeZone);
    const then = partsIn(date, timeZone);
    const sameDay =
      today.year === then.year && today.month === then.month && today.day === then.day;

    return `${prefix} ${sameDay ? 'today' : dayMonth(date, timeZone)}, ${clock(date, timeZone)}`;
  };

  if (row.status === 'paused' && row.pausedAt !== null) return at(row.pausedAt, 'Paused');
  if (row.status === 'scheduled' && row.scheduledAt !== null) return at(row.scheduledAt, 'Scheduled');
  if (row.completedAt !== null) return at(row.completedAt, 'Finished');
  if (row.launchedAt !== null) return at(row.launchedAt, 'Started');
  if (row.status === 'held') return `Held since ${dayMonth(row.updatedAt, timeZone)}`;

  return `Edited ${dayMonth(row.updatedAt, timeZone)}`;
}

function clock(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

export function buildCampaigns(
  rows: readonly DashboardCampaignRow[],
  now: Date,
  timeZone: string,
): DashboardCampaign[] {
  return rows.map((row) => {
    const delivered = row.stats?.delivered ?? 0;
    const clicks = row.stats?.clicksUniqueNonbot ?? 0;

    return {
      id: row.campaignId,
      name: row.name,
      state: row.status,
      when: whenFor(row, now, timeZone),
      // Null for a draft, which has no audience yet. Never zero: "0
      // recipients" reads as an empty segment rather than as "not chosen".
      recipients: row.counters?.total ?? (row.recipientCount > 0 ? row.recipientCount : null),
      counts: countsFor(row),
      clickRate: delivered === 0 ? null : clicks / delivered,
    };
  });
}

// ------------------------------------------------------------------ providers

export function buildProviders(
  connections: readonly ProviderConnectionRow[],
  sentToday: ReadonlyMap<string, number>,
): DashboardProvider[] {
  return connections.map((connection) => {
    const known = PROVIDER_LABEL[connection.providerType];
    const quota = connection.quotaSnapshot ?? {};
    const limit = quota['max24Hour'];

    return {
      connectionId: connection.id,
      code: known?.code ?? connection.providerType.slice(0, 4).toUpperCase(),
      name: known?.name ?? connection.providerType,
      // The customer's own name for the connection, plus the one identifying
      // thing in its config. Never the whole config: `config` is documented
      // as non-secret by review and not by the database.
      label: connectionDetail(connection),
      health: healthOf(connection.status),
      sentToday: sentToday.get(connection.id) ?? 0,
      // Null, not zero. SMTP reports no quota, and a bar drawn against zero
      // would show every connection as full.
      dailyLimit: typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : null,
    };
  });
}

function connectionDetail(connection: ProviderConnectionRow): string {
  for (const key of ['region', 'domain', 'host'] as const) {
    const value = connection.config[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return `${value.trim()} · ${connection.name}`;
    }
  }

  return connection.name;
}

function healthOf(status: ProviderConnectionRow['status']): DashboardProvider['health'] {
  if (status === 'active') return 'healthy';
  if (status === 'error' || status === 'revoked' || status === 'disabled') return 'failed';
  return 'degraded';
}

// ------------------------------------------------------------------ attention

/**
 * "Needs attention", from facts rather than from guesses.
 *
 * Every item names a row someone can act on and links to the page that fixes
 * it. Ordered danger first, because the column is read top-down and the
 * thing losing mail belongs above the thing that will lose mail on Friday.
 */
export function buildAttention(input: {
  connections: readonly ProviderConnectionRow[];
  campaigns: readonly DashboardCampaignRow[];
  enforcement: EnforcementRow;
  pastDue: boolean;
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const connection of input.connections) {
    if (connection.status === 'error' || connection.status === 'revoked') {
      const message = connection.lastError?.['message'];

      items.push({
        id: `att_connection_${connection.id}`,
        tone: 'danger',
        title: `${connection.name} needs attention`,
        detail:
          typeof message === 'string' && message !== ''
            ? message
            : `This connection is ${connection.status}. Campaigns routed through it cannot send.`,
        action: { label: 'Fix connection', href: `/providers/${connection.id}` },
      });
    }
  }

  if (input.enforcement.stage !== 'none') {
    const rate = input.enforcement.observedRate;

    items.push({
      id: 'att_enforcement',
      tone: input.enforcement.stage === 'warned' ? 'warning' : 'danger',
      title: `Sending is ${input.enforcement.stage.replace(/_/gu, ' ')}`,
      detail:
        input.enforcement.reason ??
        (rate === null
          ? 'Review the anti-abuse notice on this workspace.'
          : `The complaint rate reached ${(rate * 100).toFixed(2)}%, above the ${(COMPLAINT_THRESHOLD * 100).toFixed(1)}% threshold.`),
      action: { label: 'Review', href: '/settings/workspace' },
    });
  }

  for (const campaign of input.campaigns) {
    if (campaign.status === 'paused') {
      const unsent = (campaign.counters?.pending ?? 0) + (campaign.counters?.queued ?? 0);

      items.push({
        id: `att_paused_${campaign.campaignId}`,
        tone: 'warning',
        title: `${campaign.name} is paused`,
        detail:
          unsent === 0
            ? 'It is paused and has nothing left to send.'
            : `${unsent.toLocaleString('en-US')} recipients have not been sent.`,
        action: { label: 'Review campaign', href: `/campaigns/${campaign.campaignId}` },
      });
    }

    if (campaign.status === 'held') {
      items.push({
        id: `att_held_${campaign.campaignId}`,
        tone: 'warning',
        title: `${campaign.name} is held by billing`,
        detail: 'The campaign launches once payment clears.',
        action: { label: 'Update payment method', href: '/billing/payment-method' },
      });
    }
  }

  if (input.pastDue) {
    items.push({
      id: 'att_past_due',
      tone: 'warning',
      title: 'An invoice is past due',
      detail: 'Sending continues for now. Launches are blocked once the grace period ends.',
      action: { label: 'Update payment method', href: '/billing/payment-method' },
    });
  }

  const rank = { danger: 0, warning: 1, info: 2 } as const;
  return items.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

// -------------------------------------------------------------- bounce split

/**
 * The bounce meter's two tones, as rates over accepted sends.
 *
 * Null when nothing was sent, never `{ soft: 0, hard: 0 }`: a workspace that
 * has sent nothing has no bounce rate, and two empty bars say it performed
 * perfectly.
 */
export function bounceSplitOf(row: BounceSplitRow): { soft: number; hard: number } | null {
  if (row.sent <= 0) return null;

  return { soft: row.bouncedSoft / row.sent, hard: row.bouncedHard / row.sent };
}

/**
 * Movement against the previous period, in percentage points.
 *
 * Points rather than a percentage change, because C1 prints "+0.4" beside a
 * rate: a click rate going from 3.8% to 4.2% moved 0.4 points and 10.5
 * percent, and only the first is what the arrow means.
 *
 * Null when either side has no denominator. A period with nothing delivered
 * has no rate, and treating it as zero would report a catastrophic drop the
 * first month of every new workspace.
 */
export function deltaPoints(
  current: { numerator: number; denominator: number },
  previous: { numerator: number; denominator: number },
): number | null {
  if (current.denominator <= 0 || previous.denominator <= 0) return null;

  const points =
    (current.numerator / current.denominator - previous.numerator / previous.denominator) * 100;

  // One decimal place, which is what the frame prints. Rounded here so the
  // browser is not deciding how precise our own number is.
  return Math.round(points * 10) / 10;
}
