import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  CARD_SURFACE,
  CAMPAIGN_STATES,
  Card,
  CardHeader,
  DashboardSkeleton,
  DataTable,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  SEG_ORDER,
  SegmentedBar,
  fmtCount,
  StateBadge,
  type Column,
} from '@relayd/ui';
import { ApiError } from '../../api/client.js';
import {
  analyticsApi,
  analyticsKeys,
  formatDelta,
  formatFraction,
  formatRate,
  formatSmallRate,
  type AttentionItem,
  type DashboardCampaign,
  type DashboardSummary,
  type Overview,
} from '../../api/analytics.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { dayLabel } from './format.js';
import { OnboardingChecklist, useOnboardingProgress } from '../../components/onboarding-checklist.js';
import {
  ApproximateChip,
  BarTimeChart,
  BounceMeter,
  Chip,
  ComplaintMeter,
  HatchSwatch,
  HeadlineRateCard,
  MeterCard,
  ProviderCard,
  RangePicker,
  UsageBand,
  approximate,
  type ChartPoint,
} from './parts.js';

/**
 * The dashboard (frames C1, C2 dark, C3 new workspace, C4 all clear, Cm).
 *
 * Two requests, and the split between them is deliberate.
 * `GET /analytics/overview` is real and answers every *rate* on the page:
 * the four cards and the activity chart are drawn from it, so the numbers a
 * customer acts on come from the service that computes them once, with its
 * bot filtering and its confidence flags attached.
 *
 * The rest of the page is a composition — plan usage from billing, the
 * provider strip from connections, recent campaigns with their segment
 * counts, the attention column from anti-abuse and dunning, the suppression
 * footnote from the audience. No endpoint answers that today; it is one
 * pending request rather than five live ones, because the page is one
 * screen and five round trips would each need their own three states.
 *
 * When the composition is missing the page still works: the frames' four
 * cards and the chart render from the overview alone. Nothing here shows an
 * error for the pending half — it simply has less to show.
 */

export type RangeKey = 'period' | '7' | '30' | '90';

export const RANGES: readonly { value: RangeKey; label: string }[] = [
  { value: 'period', label: 'This billing period' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

export function DashboardPage() {
  const [rangeKey, setRangeKey] = useState<RangeKey>('period');
  const range = rangeQuery(rangeKey);
  const { current, currentWorkspaceId } = useAuth();
  const onboarding = useOnboardingProgress();

  const overview = useQuery({
    queryKey: analyticsKeys.overview(currentWorkspaceId, range),
    queryFn: () => analyticsApi.overview(range),
  });

  // BACKEND PENDING: GET /analytics/dashboard
  const summary = useQuery({
    queryKey: analyticsKeys.dashboard(currentWorkspaceId),
    queryFn: () => analyticsApi.dashboard(),
    retry: false,
  });

  const data = summary.data;
  const picker = <RangePicker value={rangeKey} options={RANGES} onChange={setRangeKey} />;

  if (overview.isPending) {
    return (
      <>
        <PageHeader title="Dashboard" actions={picker} />
        <DashboardSkeleton />
      </>
    );
  }

  if (overview.isError) {
    return (
      <>
        <PageHeader title="Dashboard" actions={picker} />
        <ErrorState
          description="The dashboard could not be loaded. Nothing you did caused it and no data was changed."
          {...requestIdOf(overview.error)}
          onRetry={() => void overview.refetch()}
        />
      </>
    );
  }

  const attention = data?.attention ?? [];
  const aside = attention.length > 0 || !onboarding.complete;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={describe(current?.workspaceName, data)}
        actions={picker}
      />

      {data === undefined ? null : (
        <UsageBand
          sent={data.usage.sent}
          limit={data.usage.limit}
          renewsLabel={data.usage.renewsLabel}
          renewsShort={data.usage.renewsShort}
          uncertain={data.usage.uncertain}
        />
      )}

      <RateCards overview={overview.data} summary={data} />

      {data === undefined || data.providers.length === 0 ? null : (
        <div className="mb-5 hidden gap-4 sm:grid sm:grid-cols-2 lg:grid-cols-3">
          {data.providers.map((provider) => (
            <ProviderCard key={provider.connectionId} provider={provider} />
          ))}
        </div>
      )}

      <div
        className={`grid items-start gap-3 sm:gap-5 lg:gap-6 ${
          aside ? 'lg:grid-cols-[minmax(0,1fr)_352px]' : ''
        }`}
      >
        <div className="flex min-w-0 flex-col gap-3 sm:gap-5">
          {/* Cm has no chart: thirty bars four pixels wide say nothing a
              phone-sized reader can act on, and the frame spends the space
              on what needs attention instead. */}
          <div className="hidden sm:block">
            <ActivityCard points={overview.data.points} />
          </div>
          <RecentCampaigns campaigns={data?.campaigns} />
        </div>

        {aside ? (
          // Cm puts "Needs attention" above the campaign list — the reason to
          // open the dashboard on a phone is to find out whether anything is
          // wrong. On a wide screen it is the right-hand column again.
          <div className="order-first flex min-w-0 flex-col gap-3 sm:gap-5 lg:order-0">
            {attention.length > 0 ? (
              <AttentionPanel items={attention} suppressions={data?.suppressions ?? null} />
            ) : null}
            {/* C3's "Get set up": the compact card, with its progress bar and
                its "stays here until all four steps are done" footer. */}
            {onboarding.complete ? null : <OnboardingChecklist compact />}
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * "Northwind Voyages · 1–19 Sep 2026 · Asia/Dubai".
 *
 * Cm drops the timezone: the phone has 390px and the workspace's zone is the
 * one fact on the line a reader who is in that zone already knows.
 */
function describe(workspace: string | undefined, summary: DashboardSummary | undefined) {
  const head = [workspace, summary?.period.label]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
  const zone = summary?.period.timezone ?? '';

  return (
    <>
      {head}
      {zone === '' ? null : <span className="hidden sm:inline"> · {zone}</span>}
    </>
  );
}

/**
 * The four rate cards.
 *
 * The click rate leads at 32px and carries the "Headline" chip; the open
 * rate is one size down and always says "approximate", with a tilde on the
 * number. Both are docs/06 §13 rather than taste.
 *
 * When nothing has been sent every value is an em dash, never 0% — C3's
 * "Appears after your first campaign". A campaign that delivered nothing has
 * no click rate, and 0% says it performed badly.
 */
export function RateCards({ overview, summary }: { overview: Overview; summary: DashboardSummary | undefined }) {
  const { click, open, bounce, complaint } = overview.rates;
  const comparedTo = summary?.period.comparedTo ?? null;

  const clickDetail =
    click.value === null
      ? null
      : `${fmtCount(click.numerator)} unique clicks of ${fmtCount(click.denominator)} delivered`;
  const clickDelta =
    comparedTo === null || summary?.deltas.click == null
      ? null
      : formatDelta(summary.deltas.click, comparedTo);

  const openDelta =
    comparedTo === null || summary?.deltas.open == null
      ? null
      : formatDelta(summary.deltas.open, comparedTo);

  const threshold = summary?.complaintThreshold ?? 0.003;

  return (
    <div className="mb-3 grid grid-cols-3 gap-2.5 sm:mb-4 sm:gap-4 lg:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))]">
      {/* C1 puts the comparison and the raw counts on one success-coloured
          line; Cm keeps only the comparison, because the raw counts wrap to
          three lines on a phone and say nothing the number above has not. */}
      <HeadlineRateCard
        value={formatRate(click)}
        delta={
          click.value === null ? (
            'Appears after your first campaign'
          ) : (
            <>
              {clickDelta}
              {clickDetail === null ? null : (
                <span className="hidden sm:inline">
                  {clickDelta === null ? '' : ' · '}
                  {clickDetail}
                </span>
              )}
            </>
          )
        }
        sparkline={overview.points.map((point) => point.clicksUnique)}
        className="col-span-3 lg:col-span-1"
      />

      <MeterCard
        label="Open rate"
        shortLabel="Open · approx."
        compact
        weight="medium"
        aside={<ApproximateChip />}
        value={approximate(formatRate(open), open)}
        footnote={
          open.value === null
            ? 'Appears after your first campaign'
            : join(openDelta, 'privacy proxies inflate this')
        }
      />

      <MeterCard
        label="Bounce rate"
        shortLabel="Bounce"
        compact
        value={formatRate(bounce)}
        meter={
          summary?.bounceSplit == null ? undefined : (
            <BounceMeter soft={summary.bounceSplit.soft} hard={summary.bounceSplit.hard} />
          )
        }
        footnote={
          summary?.bounceSplit != null
            ? `Soft ${formatFraction(summary.bounceSplit.soft)} · Hard ${formatFraction(summary.bounceSplit.hard)}`
            : bounce.value === null
              ? 'No sends yet'
              : `${fmtCount(bounce.numerator)} of ${fmtCount(bounce.denominator)} accepted`
        }
      />

      <MeterCard
        label="Complaint rate"
        shortLabel="Complaint"
        compact
        value={formatSmallRate(complaint)}
        meter={<ComplaintMeter value={complaint.value} threshold={threshold} />}
        footnote={
          <>
            Auto-pause threshold <span className="text-danger-text">{formatFraction(threshold, 1)}</span>
          </>
        }
      />
    </div>
  );
}

/** "+0.4 pts vs Aug · 6,912 unique clicks of 181,890 delivered" */
function join(...parts: (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(' · ');
}

/**
 * Sending activity.
 *
 * "Emails accepted by provider", never "delivered" — CLAUDE.md section 12:
 * a provider's accept is an accept. Today's bar is drawn at full strength
 * because it is still filling up.
 */
export function ActivityCard({ points }: { points: Overview['points'] }) {
  const bars: ChartPoint[] = points.map((point, index) => ({
    label: dayLabel(point.day),
    value: point.sent,
    opacity: index === points.length - 1 ? 1 : 0.5,
  }));

  return (
    <Card className="pt-4 pb-3.5">
      <CardHeader
        size="sm"
        title="Sending activity"
        actions={
          <span className="text-caption font-normal text-text-2">
            Last {points.length} days · emails accepted by provider
          </span>
        }
      />
      <BarTimeChart points={bars} axisLabels={axisLabels(bars)} unit="accepted" />
    </Card>
  );
}

/**
 * Four captions under the plot: first, two inside, last — as the frame.
 *
 * The two inside ones are pulled to a round day when one is within a couple
 * of buckets: C1 prints "21 Aug · 1 Sep · 10 Sep · 19 Sep" rather than the
 * arithmetic thirds (30 Aug, 9 Sep) sitting beside them. Same reason the y
 * axis is rounded to a round step — an axis caption is a landmark, and the
 * 1st of a month is a landmark in a way the 30th is not.
 */
function axisLabels(points: readonly ChartPoint[]): string[] {
  if (points.length <= 4) return points.map((point) => point.label);

  const last = points.length - 1;
  const at = (index: number): string => points[Math.min(last, Math.max(0, index))]?.label ?? '';

  return [at(0), at(round(points, last / 3)), at(round(points, (last * 2) / 3)), at(last)];
}

/** The nearest bucket to `target` whose day is the 1st, 10th or 20th. */
function round(points: readonly ChartPoint[], target: number): number {
  const start = Math.round(target);

  for (const offset of [0, -1, 1, -2, 2]) {
    const day = Number(points[start + offset]?.label.split(' ')[0] ?? NaN);
    if (day === 1 || day === 10 || day === 20) return start + offset;
  }

  return start;
}

/**
 * Recent campaigns.
 *
 * The progress column is the segmented bar, delivery uncertain hatched and
 * never hidden (D3). Click rate is an em dash until something has been
 * delivered, for the same reason the cards above are.
 *
 * At 390px the table becomes the frame's card list: five columns do not
 * survive a phone, and a horizontally scrolling table is not what Cm draws.
 */
function RecentCampaigns({ campaigns }: { campaigns: DashboardCampaign[] | undefined }) {
  const rows = campaigns ?? [];

  const empty = (
    <EmptyState
      icon="campaigns"
      size="table"
      title="No campaigns yet"
      description="Finish the setup steps on the right, then create your first campaign. Sending activity will appear here."
    />
  );

  const columns: Column<DashboardCampaign>[] = [
    {
      key: 'name',
      header: 'Campaign',
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{row.name}</div>
          <div className="truncate text-caption text-text-2">{row.when}</div>
        </div>
      ),
    },
    {
      key: 'state',
      header: 'State',
      width: '168px',
      cell: (row) => <StateBadge states={CAMPAIGN_STATES} state={row.state} />,
    },
    {
      key: 'progress',
      header: 'Progress',
      width: '120px',
      cell: (row) => (
        <SegmentedBar
          className="w-24"
          size="sm"
          legend={false}
          note={false}
          counts={row.counts}
          total={row.recipients ?? 0}
        />
      ),
    },
    {
      key: 'recipients',
      header: 'Recipients',
      width: '92px',
      align: 'right',
      cell: (row) => (row.recipients === null ? '—' : fmtCount(row.recipients)),
    },
    {
      key: 'clicks',
      header: 'Click rate',
      width: '88px',
      align: 'right',
      cell: (row) => formatFraction(row.clickRate),
    },
  ];

  return (
    <>
      <div className="hidden sm:block">
        <DataTable
          label="Recent campaigns"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          empty={empty}
          toolbar={
            <div className="flex w-full items-center justify-between gap-3">
              <span className="text-body font-semibold">Recent campaigns</span>
              <Link to="/campaigns" className="text-ui font-medium text-brand">
                View all
              </Link>
            </div>
          }
          footer={rows.length === 0 ? undefined : <SegmentLegend />}
        />
      </div>

      <div className={`${CARD_SURFACE} overflow-hidden sm:hidden`}>
        <div className="flex items-center justify-between gap-3 px-3.5 py-3">
          <span className="text-ui font-semibold">Recent campaigns</span>
          <Link to="/campaigns" className="text-caption font-medium text-brand">
            View all
          </Link>
        </div>

        {rows.length === 0 ? (
          <div className="border-t border-border">{empty}</div>
        ) : (
          rows.map((row) => (
            <div key={row.id} className="border-t border-border px-3.5 py-3">
              <div className="flex items-start justify-between gap-2 text-ui">
                <span className="min-w-0 font-medium">{row.name}</span>
                <StateBadge states={CAMPAIGN_STATES} state={row.state} />
              </div>
              <SegmentedBar
                className="mt-2"
                size="sm"
                legend={false}
                note={false}
                counts={row.counts}
                total={row.recipients ?? 0}
              />
              <div className="mt-1.5 flex justify-between text-caption text-text-2">
                <span>{row.recipients === null ? '—' : fmtCount(row.recipients)} recipients</span>
                <span>{formatFraction(row.clickRate)} clicks</span>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

/** The six segments, always all six, as the frame prints them. */
function SegmentLegend() {
  return (
    <div className="flex w-full flex-wrap gap-x-3.5 gap-y-2">
      {SEG_ORDER.map((segment) => (
        <span key={segment.key} className="inline-flex items-center gap-1.5">
          {segment.fill === 'hatch' ? (
            <HatchSwatch />
          ) : (
            <span aria-hidden="true" className={`h-2.5 w-2.5 flex-none rounded-2 ${segment.fill}`} />
          )}
          {segment.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Needs attention (C1's right column).
 *
 * Absent entirely when there is nothing to attend to — C4 collapses the
 * column rather than showing an empty card, because a permanent "all clear"
 * panel trains people to stop reading the place warnings appear.
 */
function AttentionPanel({
  items,
  suppressions,
}: {
  items: readonly AttentionItem[];
  suppressions: DashboardSummary['suppressions'];
}) {
  return (
    <div className={`${CARD_SURFACE} overflow-hidden`}>
      <div className="flex items-center gap-2 border-b border-border px-4.5 py-3.5">
        <span className="text-body font-semibold">Needs attention</span>
        <Chip tone="warning">{items.length}</Chip>
      </div>

      {items.map((item) => (
        <div key={item.id} className="flex gap-3 border-b border-border px-4.5 py-3.5">
          <span
            className={`grid h-6.5 w-6.5 flex-none place-items-center rounded-badge ${
              item.tone === 'danger'
                ? 'bg-danger-soft text-danger-text'
                : item.tone === 'info'
                  ? 'bg-info-soft text-info-text'
                  : 'bg-warning-soft text-warning-text'
            }`}
          >
            <Icon name="alert" size={14} strokeWidth={2} />
          </span>

          <div className="min-w-0 flex-1">
            <div className="text-ui font-medium">{item.title}</div>
            <div className="mt-0.5 hidden text-caption text-pretty text-text-2 sm:block">{item.detail}</div>
            {item.action === null ? null : (
              <Link
                to={item.action.href}
                className="mt-2 inline-block text-ui font-medium text-brand sm:mt-2"
              >
                {item.action.label} →
              </Link>
            )}
          </div>
        </div>
      ))}

      {suppressions === null ? null : (
        <div className="px-4.5 py-3 text-caption text-text-2">
          Suppressions applied this period:{' '}
          <span className="font-medium text-text">{fmtCount(suppressions.applied)}</span>
          {suppressions.note === '' ? null : ` · ${suppressions.note}`}
        </div>
      )}
    </div>
  );
}

/**
 * The trace id for an `ErrorState`, as props rather than a value.
 *
 * `exactOptionalPropertyTypes` makes `requestId={undefined}` a type error on
 * an optional prop, and an error page whose id we do not have still has to
 * render.
 */
export function requestIdOf(error: unknown): { requestId?: string } {
  const id = error instanceof ApiError ? error.requestId : undefined;
  return id === undefined ? {} : { requestId: id };
}

/** The overview's query for a picked range; the billing period is the server's default. */
export function rangeQuery(key: RangeKey, now = new Date()): { from?: string; to?: string } {
  if (key === 'period') return {};
  return rangeFor(Number(key), now);
}

/** A range in UTC days, matching how the server stores and buckets them. */
export function rangeFor(days: number, now = new Date()): { from: string; to: string } {
  return {
    from: new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
  };
}
