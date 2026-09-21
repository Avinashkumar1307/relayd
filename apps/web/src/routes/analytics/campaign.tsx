import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  CAMPAIGN_STATES,
  CARD_SURFACE,
  Card,
  CardHeader,
  DataTable,
  DetailSkeleton,
  EmptyState,
  ErrorState,
  PageHeader,
  StateBadge,
  fmtCount,
  type Column,
} from '@relayd/ui';
import {
  analyticsApi,
  analyticsKeys,
  formatDelta,
  formatFraction,
  formatRate,
  rateFootnote,
  type CampaignAnalytics,
  type CampaignProviderRow,
  type DeviceBreakdown,
  type LinkRow,
} from '../../api/analytics.js';
import { campaignKeys, campaignsApi, type Campaign } from '../../api/campaigns.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { hourCaption, hourLabel, instantLabel, shortDateLabel, timeLabel, zoneLabel } from './format.js';
import {
  ApproximateChip,
  BarTimeChart,
  BotChip,
  DownloadLink,
  HeadlineRateCard,
  MeterCard,
  MeterRow,
  StackBar,
  approximate,
  prettyUrl,
  type ChartPoint,
  type Slice,
} from './parts.js';
import { requestIdOf } from './dashboard.js';

/**
 * The campaign report (frames G4a and G4b, which is the same page in the
 * dark tokens — nothing here special-cases the theme).
 *
 * The page is owned by analytics rather than by campaigns because every
 * number on it carries a confidence, and the rules about that live here:
 *
 *   the click rate is the headline, at 32px, and it is the only card marked
 *   `data-headline`;
 *
 *   the open rate is always "approximate", always with a tilde, and says
 *   where the inflation comes from — not on hover, every time;
 *
 *   the bot exclusions are in the header, beside the export. They are the
 *   answer to "why is this lower than my provider's dashboard", and a
 *   footnote at the bottom of a long page answers it too late;
 *
 *   delivery uncertain (D3) is its own number in the provider breakdown and
 *   is never folded into the bounce count.
 *
 * All six requests are real. What is still missing is two fields rather
 * than an endpoint — the comparison line on the campaign report and an
 * hourly bucket on the timeseries, both marked at the call site. When a
 * field is absent the page renders everything else rather than an error.
 */
export function CampaignAnalyticsPage() {
  const { id = '' } = useParams();
  const { currentWorkspaceId } = useAuth();

  const report = useQuery({
    queryKey: analyticsKeys.campaign(currentWorkspaceId, id),
    queryFn: () => analyticsApi.campaign(id),
  });

  const campaign = useQuery({
    queryKey: campaignKeys.one(currentWorkspaceId, id),
    queryFn: () => campaignsApi.get(id),
  });

  // BACKEND PENDING: GET /analytics/campaigns/{id}/timeseries accepts no
  // `bucket` parameter — it buckets by day from `campaign_daily_stats` and
  // ignores the one sent here. The frame's chart is "First 48 hours ·
  // hourly", which needs an hourly rollup that does not exist.
  const series = useQuery({
    queryKey: analyticsKeys.timeseries(currentWorkspaceId, id, { bucket: 'hour' }),
    queryFn: () => analyticsApi.timeseries(id, { bucket: 'hour' }),
  });

  const links = useQuery({
    queryKey: analyticsKeys.links(currentWorkspaceId, id),
    queryFn: () => analyticsApi.links(id),
  });

  const devices = useQuery({
    queryKey: analyticsKeys.devices(currentWorkspaceId, id),
    queryFn: () => analyticsApi.devices(id),
  });

  const providers = useQuery({
    queryKey: analyticsKeys.campaignProviders(currentWorkspaceId, id),
    queryFn: () => analyticsApi.campaignProviders(id),
    retry: false,
  });

  const back = (
    <Link to={`/campaigns/${id}`} className="font-medium text-brand no-underline">
      ← Campaign
    </Link>
  );

  if (report.isPending) {
    return (
      <>
        <PageHeader back={back} title="Campaign analytics" />
        <DetailSkeleton />
      </>
    );
  }

  if (report.isError) {
    return (
      <>
        <PageHeader back={back} title="Campaign analytics" />
        <ErrorState
          title="We couldn't load this report"
          description="The campaign is unaffected — only this page failed to load. Send support the request ID if it keeps happening."
          {...requestIdOf(report.error)}
          onRetry={() => void report.refetch()}
        />
      </>
    );
  }

  const data = report.data;
  const row = campaign.data?.campaign;
  const zone = row?.timezone ?? null;
  const pool = providers.data?.poolLabel ?? null;

  return (
    <>
      <PageHeader
        back={back}
        title={row?.name ?? 'Campaign analytics'}
        badge={row === undefined ? undefined : <StateBadge states={CAMPAIGN_STATES} state={row.status} />}
        description={subtitle(data, row, pool, zone)}
        actions={
          <>
            {data.botExcluded === undefined || data.botExcluded === 0 ? null : (
              <BotChip count={data.botExcluded} />
            )}
            <DownloadLink href={analyticsApi.exportUrl(id)}>Export CSV</DownloadLink>
          </>
        }
      />

      <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.6fr)]">
        <HeadlineRateCard
          value={formatRate(data.rates.click)}
          detail={clickDetail(data)}
          delta={
            data.comparison == null ? null : formatDelta(data.comparison.points, data.comparison.label)
          }
        />

        <MeterCard
          label="Open rate"
          weight="medium"
          aside={<ApproximateChip />}
          value={approximate(formatRate(data.rates.open), data.rates.open)}
          footnote={openDetail(data)}
        />

        <FunnelCard counts={data.counts} clickRate={formatRate(data.rates.click)} />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <ClicksOverTime points={series.data?.points ?? []} zone={zone} />
        <ProviderBreakdown
          poolLabel={pool}
          routing={providers.data?.routing ?? null}
          rows={providers.data?.providers ?? []}
          note={providers.data?.note ?? null}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <LinkPerformance rows={links.data?.links ?? []} loading={links.isPending} />

        <div className="flex min-w-0 flex-col gap-4">
          <DeviceCard data={devices.data} />
          <ClientCard data={devices.data} />
        </div>
      </div>
    </>
  );
}

/** "Sent 8 Sep 2026, 10:00 GST · 22,870 recipients · EU marketing pool · Analytics through 20 Sep" */
function subtitle(
  data: CampaignAnalytics,
  row: Campaign | undefined,
  pool: string | null,
  zone: string | null,
): string {
  const sent =
    data.sentLabel ??
    (row?.launchedAt == null ? null : `Sent ${instantLabel(row.launchedAt, zone)}`);
  const recipients =
    row === undefined ? null : `${fmtCount(row.recipientCount)} recipients`;

  return [sent, recipients, pool, `Analytics through ${shortDateLabel(data.computedAt, zone)}`]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
}

/** "1,023 unique clickers of 22,241 delivered · 1,540 total clicks" */
function clickDetail(data: CampaignAnalytics): string | null {
  const { clicksUnique, delivered, clicksTotal } = data.counts;
  if (delivered === 0) return null;

  return `${fmtCount(clicksUnique)} unique clickers of ${fmtCount(delivered)} delivered · ${fmtCount(clicksTotal)} total clicks`;
}

/**
 * "≈ 9,920 opens · 61% from Apple Mail proxies".
 *
 * The approximation is in the number itself, not only in the chip: an open
 * count that a proxy fetched on nobody's behalf is not a count of readers.
 * When the proxy share is not known the bot-filtered count takes its place,
 * because something has to explain the gap.
 */
function openDetail(data: CampaignAnalytics): string | null {
  const opens = `≈ ${fmtCount(data.counts.opensUniqueNonbot)} opens`;
  if (data.proxyShare != null) {
    return `${opens} · ${Math.round(data.proxyShare * 100)}% from Apple Mail proxies`;
  }

  const footnote = rateFootnote(data.rates.open);
  return footnote === null ? opens : `${opens} · ${footnote}`;
}

/**
 * Sent → delivered → clicked, as three bars on one scale.
 *
 * The bars are shares of what was sent, so the drop between them is the
 * point of the block; the percentages beside them are the rates the rest of
 * the product quotes (delivery of sent, clicks of delivered), which is why
 * the last bar is 4% wide next to a 4.6% label.
 */
function FunnelCard({
  counts,
  clickRate,
}: {
  counts: CampaignAnalytics['counts'];
  clickRate: string;
}) {
  const { sent, delivered, clicksUnique } = counts;
  const share = (value: number): number => (sent === 0 ? 0 : (value / sent) * 100);

  const value = (count: number, pct: string) => (
    <>
      <span className="font-medium">{fmtCount(count)}</span>{' '}
      <span className="text-caption text-text-2">{pct}</span>
    </>
  );

  return (
    <div className={`${CARD_SURFACE} min-w-0 px-5 py-4.5`}>
      <div className="mb-2.5 text-ui text-text-2">Funnel</div>
      <div className="flex flex-col gap-2">
        <MeterRow label="Sent" width={100} fill="bg-seg-pending" value={value(sent, '100%')} />
        <MeterRow
          label="Delivered"
          width={share(delivered)}
          fill="bg-success"
          value={value(delivered, formatFraction(sent === 0 ? null : delivered / sent))}
        />
        <MeterRow
          label="Clicked"
          width={share(clicksUnique)}
          fill="bg-brand"
          value={value(clicksUnique, clickRate)}
        />
      </div>
    </div>
  );
}

/**
 * Clicks in the first 48 hours.
 *
 * The first day is drawn at full strength and the second faded: almost every
 * click a campaign will ever get arrives in the first 24 hours, and the
 * frame makes that shape visible rather than leaving it to be inferred.
 */
function ClicksOverTime({ points, zone }: { points: { day: string; clicksUnique: number }[]; zone: string | null }) {
  const first = points[0]?.day ?? '';

  const bars: ChartPoint[] = points.map((point, index) => ({
    label: hourLabel(point.day, first),
    value: point.clicksUnique,
    opacity: index < 24 ? 0.85 : 0.5,
  }));

  // Five captions, every twelfth hour, as the frame prints them: the day
  // boundaries carry their date and the ones between carry only the time.
  const captions = points.length === 0
    ? []
    : [0, 12, 24, 36, 48].map((hour) => {
        const at = new Date(new Date(first).getTime() + hour * 3_600_000).toISOString();
        return hour % 24 === 0 ? hourCaption(at, zone) : timeLabel(at, zone);
      });

  const zoneName = zoneLabel(zone);

  return (
    <Card className="pt-4 pb-3.5">
      <CardHeader
        size="sm"
        title="Clicks over time"
        actions={
          <span className="text-caption font-normal text-text-2">
            First 48 hours · hourly{zoneName === '' ? '' : ` · ${zoneName}`}
          </span>
        }
      />
      <BarTimeChart points={bars} axisLabels={captions} unit="clicks" />
    </Card>
  );
}

/**
 * Delivery per connection.
 *
 * Delivery uncertain is a column here rather than a footnote because this is
 * where its cause is: one provider's webhook went quiet, and the sends it
 * could not confirm belong against that provider's name, unbilled (D3).
 */
function ProviderBreakdown({
  poolLabel,
  routing,
  rows,
  note,
}: {
  poolLabel: string | null;
  routing: string | null;
  rows: readonly CampaignProviderRow[];
  note: string | null;
}) {
  const subtitle = [poolLabel, routing].filter((part): part is string => part !== null).join(', ');

  return (
    <Card>
      <CardHeader
        size="sm"
        title={
          <>
            Provider breakdown{' '}
            {subtitle === '' ? null : (
              <span className="text-caption font-normal text-text-2">· {subtitle}</span>
            )}
          </>
        }
      />

      {rows.length === 0 ? (
        <p className="mt-3 mb-0 text-ui text-text-2">
          No sends have been attributed to a provider yet.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-2.5">
          {rows.map((provider) => (
            <div key={provider.connectionId} className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-control bg-brand-soft font-mono text-label font-medium text-brand">
                {provider.code}
              </span>

              <div className="min-w-0">
                <div className="flex justify-between gap-2 text-ui">
                  <span className="truncate font-medium">{provider.name}</span>
                  <span className="flex-none tabular-nums">
                    {formatFraction(provider.clickRate)} click
                  </span>
                </div>
                <div className="flex justify-between gap-2 text-caption text-text-2">
                  <span className="truncate">
                    {fmtCount(provider.delivered)} delivered · {formatFraction(provider.bounceRate)} bounce
                  </span>
                  <span className="flex-none">{fmtCount(provider.uncertain)} uncertain</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {note === null ? null : (
        <div className="mt-3 border-t border-border pt-2.5 text-caption text-text-2">{note}</div>
      )}
    </Card>
  );
}

/**
 * Link performance.
 *
 * The bar is each link's share of total clicks against the best link, so the
 * ranking is readable; the number beside it is the share of all clicks,
 * which is the figure a copywriter compares between campaigns.
 */
function LinkPerformance({ rows, loading }: { rows: readonly LinkRow[]; loading: boolean }) {
  const totalClicks = rows.reduce((sum, row) => sum + row.clicksTotal, 0);
  const topClicks = rows.reduce((top, row) => Math.max(top, row.clicksTotal), 0);

  const columns: Column<LinkRow>[] = [
    {
      key: 'url',
      header: 'URL',
      width: '50%',
      mono: true,
      cell: (row) => <span className="block truncate">{row.label ?? prettyUrl(row.url)}</span>,
    },
    {
      key: 'unique',
      header: 'Unique',
      width: '90px',
      align: 'right',
      cell: (row) => <span className="tabular-nums">{fmtCount(row.clicksUniqueNonbot)}</span>,
    },
    {
      key: 'total',
      header: 'Total',
      width: '90px',
      align: 'right',
      cell: (row) => <span className="tabular-nums text-text-2">{fmtCount(row.clicksTotal)}</span>,
    },
    {
      key: 'share',
      header: 'Share',
      cell: (row) => {
        const ratio = topClicks === 0 ? 0 : row.clicksTotal / topClicks;
        const share = totalClicks === 0 ? 0 : row.clicksTotal / totalClicks;

        return (
          <div className="flex items-center gap-2">
            <span className="h-2 flex-1 overflow-hidden rounded-4 bg-neutral-soft">
              <span
                className="block h-full rounded-4 bg-brand"
                style={{ width: `${ratio * 100}%`, opacity: 0.35 + 0.65 * ratio }}
              />
            </span>
            <span className="w-9 text-right text-caption tabular-nums">
              {Math.round(share * 100)}%
            </span>
          </div>
        );
      },
    },
  ];

  return (
    <DataTable
      label="Link performance"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.linkId}
      toolbar={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-body font-semibold">Link performance</span>
          <span className="text-caption text-text-2">Unique clicks · share of all clicks</span>
        </div>
      }
      loading={loading ? <div className="px-4 py-14 text-center text-ui text-text-2">Loading links…</div> : undefined}
      empty={
        <EmptyState
          icon="campaigns"
          size="table"
          title="No tracked links in this campaign"
          description="Links are tracked when click tracking is on and the email contains at least one link."
        />
      }
    />
  );
}

/** The three device colours the frame uses, in its own order. */
const DEVICE_FILL: Record<string, string> = {
  mobile: 'bg-brand',
  desktop: 'bg-info',
  tablet: 'bg-success',
  unknown: 'bg-bot',
};

const DEVICE_LABEL: Record<string, string> = {
  mobile: 'Mobile',
  desktop: 'Desktop',
  tablet: 'Tablet',
  unknown: 'Unknown',
};

/**
 * Device, as a share of clicks.
 *
 * Clicks rather than opens: an open can be a proxy fetching an image, and a
 * device breakdown of proxy fetches describes the proxy's data centre.
 */
function DeviceCard({ data }: { data: DeviceBreakdown | undefined }) {
  const slices = shareOf(data, (row) => row.deviceType).map<Slice>(([key, share]) => ({
    label: DEVICE_LABEL[key] ?? key,
    share,
    fill: DEVICE_FILL[key] ?? 'bg-bot',
  }));

  return (
    <Card>
      <CardHeader
        size="sm"
        title={
          <>
            Device <span className="text-caption font-normal text-text-2">· of clicks</span>
          </>
        }
      />
      <div className="mt-2.5">
        {slices.length === 0 ? (
          <p className="m-0 text-ui text-text-2">No clicks recorded yet.</p>
        ) : (
          <StackBar slices={slices} />
        )}
      </div>
    </Card>
  );
}

/**
 * Email client, as a share of clicks.
 *
 * "Unknown or proxied" stays in the list at its real size (docs/06 §13).
 * Apportioning it across the named clients would flatter us exactly in
 * proportion to how private the audience is.
 */
function ClientCard({ data }: { data: DeviceBreakdown | undefined }) {
  const rows = shareOf(data, (row) => (row.isUnknown ? 'Unknown or proxied' : row.clientFamily));
  const top = rows.reduce((best, [, share]) => Math.max(best, share), 0);

  return (
    <Card>
      <CardHeader
        size="sm"
        title={
          <>
            Email client <span className="text-caption font-normal text-text-2">· of clicks</span>
          </>
        }
      />

      {rows.length === 0 ? (
        <p className="mt-2.5 mb-0 text-ui text-text-2">No clicks recorded yet.</p>
      ) : (
        <div className="mt-2.5 flex flex-col gap-2">
          {rows.map(([label, share]) => (
            <MeterRow
              key={label}
              label={label}
              width={top === 0 ? 0 : (share / top) * 100}
              value={`${Math.round(share * 100)}%`}
              barHeight={8}
              columns="90px 1fr 40px"
            />
          ))}
        </div>
      )}
    </Card>
  );
}

/** Groups the device rows by a key and returns each group's share of clicks. */
function shareOf(
  data: DeviceBreakdown | undefined,
  key: (row: DeviceBreakdown['breakdown'][number]) => string,
): [string, number][] {
  const rows = data?.breakdown ?? [];
  const total = rows.reduce((sum, row) => sum + row.clicks, 0);
  if (total === 0) return [];

  const groups = new Map<string, number>();
  for (const row of rows) {
    const name = key(row);
    groups.set(name, (groups.get(name) ?? 0) + row.clicks);
  }

  // Biggest first, except the two catch-alls: "Other" and the proxied share
  // are the end of a list, not a rank in it, wherever their totals land.
  const catchAll = (name: string): number => (name === 'Other' || name === 'Unknown or proxied' ? 1 : 0);

  return [...groups.entries()]
    .map(([name, clicks]): [string, number] => [name, clicks / total])
    .sort((a, b) => catchAll(a[0]) - catchAll(b[0]) || b[1] - a[1]);
}
