import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  analyticsApi,
  analyticsKeys,
  formatRate,
  rateFootnote,
  type Rate,
} from '../../api/analytics.js';
import { Loading, LoadError, Page, Table, Cell, EmptyState } from '../../components/ui.js';

/**
 * Analytics.
 *
 * docs/06 §13 decides most of what is here, and the decisions are visible
 * rather than implied:
 *
 *   Click rate is the headline and sits first, at the largest size. Open rate
 *   sits beside it, smaller, with its caveat attached — every time, not on
 *   hover. A customer who makes a decision on a number wrong by 30-60% was
 *   misled by us, and a tooltip nobody opens is not a disclosure.
 *
 *   The bot-filtered count appears under any rate that has one. It is the
 *   number that answers "why is this lower than my old tool", and answering
 *   it in the interface is cheaper than answering it in support.
 *
 *   The unknown device share is its own slice. Apple's privacy proxy reports
 *   a generic client, so a large unknown share is expected and hiding it
 *   would flatter us in proportion to how private the audience is.
 */

export function DashboardPage() {
  const [days, setDays] = useState(30);
  const range = rangeFor(days);

  const overview = useQuery({
    queryKey: analyticsKeys.overview(range),
    queryFn: () => analyticsApi.overview(range),
  });

  return (
    <Page title="Dashboard" action={<RangePicker days={days} onChange={setDays} />}>
      {overview.isPending ? <Loading /> : null}
      {overview.isError ? (
        <LoadError error={overview.error} onRetry={() => void overview.refetch()} />
      ) : null}

      {overview.data !== undefined ? (
        overview.data.points.length === 0 ? (
          <EmptyState title="Nothing sent in this period">
            <Link className="text-sm underline" to="/campaigns/new">
              Create a campaign
            </Link>
          </EmptyState>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <RateTile label="Click rate" rate={overview.data.rates.click} headline />
              <RateTile label="Open rate" rate={overview.data.rates.open} />
              <RateTile label="Bounce rate" rate={overview.data.rates.bounce} />
              <RateTile label="Complaint rate" rate={overview.data.rates.complaint} />
            </div>

            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <CountTile label="Sent" value={overview.data.totals.sent} />
              <CountTile label="Delivered" value={overview.data.totals.delivered} />
              <CountTile label="Bounced" value={overview.data.totals.bounced} />
              <CountTile label="Unsubscribed" value={overview.data.totals.unsubscribed} />
            </div>

            <section className="mt-8">
              <h2 className="mb-2 text-sm font-medium text-slate-700">Over time</h2>
              <TimeChart points={overview.data.points} />
            </section>
          </>
        )
      ) : null}
    </Page>
  );
}

export function CampaignAnalyticsPage() {
  const { id = '' } = useParams();
  const [days, setDays] = useState(30);
  const range = rangeFor(days);

  const summary = useQuery({
    queryKey: analyticsKeys.campaign(id),
    queryFn: () => analyticsApi.campaign(id),
  });

  const series = useQuery({
    queryKey: analyticsKeys.timeseries(id, range),
    queryFn: () => analyticsApi.timeseries(id, range),
  });

  const links = useQuery({
    queryKey: analyticsKeys.links(id),
    queryFn: () => analyticsApi.links(id),
  });

  const devices = useQuery({
    queryKey: analyticsKeys.devices(id),
    queryFn: () => analyticsApi.devices(id),
  });

  if (summary.isPending) return <Page title="Analytics"><Loading /></Page>;
  if (summary.isError) {
    return (
      <Page title="Analytics">
        <LoadError error={summary.error} onRetry={() => void summary.refetch()} />
      </Page>
    );
  }

  const data = summary.data;

  return (
    <Page
      title="Campaign analytics"
      action={
        <div className="flex items-center gap-3">
          <RangePicker days={days} onChange={setDays} />
          {/* An anchor, not a fetch: the browser handles the download and the
              Content-Disposition header, and a blob would lose the filename. */}
          <a
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
            href={analyticsApi.exportUrl(id, range)}
            download
          >
            Export CSV
          </a>
        </div>
      }
    >
      <p className="mb-4 text-xs text-slate-500">
        {data.computedBy === 'incremental'
          ? 'Updating live — these numbers are recomputed every 30 seconds while the campaign sends.'
          : `Last recomputed ${new Date(data.computedAt).toLocaleString()}.`}
      </p>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <RateTile label="Click rate" rate={data.rates.click} headline />
        <RateTile label="Open rate" rate={data.rates.open} />
        <RateTile label="Delivery rate" rate={data.rates.delivery} />
        <RateTile label="Bounce rate" rate={data.rates.bounce} />
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <CountTile label="Sent" value={data.counts.sent} />
        <CountTile label="Delivered" value={data.counts.delivered} />
        <CountTile label="Failed" value={data.counts.failed} />
        <CountTile
          label="Delivery uncertain"
          value={data.counts.deliveryUncertain}
          hint="Sent, but the provider never confirmed. Not charged."
        />
      </div>

      <section className="mt-8">
        <h2 className="mb-2 text-sm font-medium text-slate-700">Over time</h2>
        {series.data === undefined ? <Loading /> : <TimeChart points={series.data.points} />}
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-sm font-medium text-slate-700">Links</h2>
        {links.data === undefined ? (
          <Loading />
        ) : links.data.links.length === 0 ? (
          <EmptyState title="No tracked links in this campaign" />
        ) : (
          <Table columns={['Link', 'Unique clicks', 'Click rate']}>
            {links.data.links.map((link) => (
              <tr key={link.linkId} className="border-t border-slate-200">
                <Cell>
                  <span className="break-all text-xs">{link.url}</span>
                </Cell>
                <Cell muted>{link.clicksUniqueNonbot.toLocaleString()}</Cell>
                <Cell>
                  {formatRate(link.clickRate)}
                  {link.clickRate.botFiltered > 0 ? (
                    <span className="ml-2 text-xs text-slate-500">
                      {link.clickRate.botFiltered} automated
                    </span>
                  ) : null}
                </Cell>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-sm font-medium text-slate-700">Devices and clients</h2>
        {devices.data === undefined ? <Loading /> : <DeviceTable data={devices.data} />}
      </section>
    </Page>
  );
}

function DeviceTable({ data }: { data: NonNullable<Awaited<ReturnType<typeof analyticsApi.devices>>> }) {
  if (data.total === 0) return <EmptyState title="No opens recorded yet" />;

  return (
    <>
      {data.unknownShare !== null && data.unknownShare > 0.2 ? (
        <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {/* Shown rather than hidden. A chart that apportions this away
              flatters us in proportion to how private the audience is. */}
          {Math.round(data.unknownShare * 100)}% of opens came through a privacy proxy that
          reports a generic client. That share is normal and is not an error.
        </p>
      ) : null}

      <Table columns={['Device', 'Client', 'Opens', 'Share']}>
        {data.breakdown.map((row) => (
          <tr key={`${row.deviceType}-${row.clientFamily}`} className="border-t border-slate-200">
            <Cell muted>{row.deviceType}</Cell>
            <Cell>{row.isUnknown ? 'Unknown or proxied' : row.clientFamily}</Cell>
            <Cell muted>{row.opens.toLocaleString()}</Cell>
            <Cell muted>{row.share === null ? '—' : `${Math.round(row.share * 100)}%`}</Cell>
          </tr>
        ))}
      </Table>
    </>
  );
}

/**
 * The timeline.
 *
 * Clicks and opens on the same axis as delivered, because the question is
 * always "of the mail that arrived, how much was engaged with" — two axes
 * would let a chart show a click line above a delivered line.
 */
function TimeChart({ points }: { points: { day: string; delivered: number; clicksUnique: number; opensUniqueNonbot: number }[] }) {
  return (
    <div className="h-64 w-full rounded-lg border border-slate-200 bg-white p-3">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
          <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="#94a3b8" />
          <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" allowDecimals={false} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="delivered" name="Delivered" stroke="#0f172a" dot={false} />
          <Line type="monotone" dataKey="clicksUnique" name="Clicks" stroke="#2563eb" dot={false} />
          <Line
            type="monotone"
            dataKey="opensUniqueNonbot"
            name="Opens (filtered)"
            stroke="#94a3b8"
            strokeDasharray="4 2"
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * One rate.
 *
 * The headline gets more size. Everything else gets the same treatment, and
 * the footnote — the bot-filtered count, or the caveat — is rendered as text
 * rather than as a tooltip, because a disclosure nobody opens is not one.
 */
function RateTile({ label, rate, headline }: { label: string; rate: Rate | undefined; headline?: boolean }) {
  const footnote = rateFootnote(rate);

  return (
    <div
      // Marked rather than inferred from a class name. docs/06 makes the
      // click rate the headline, and a redesign that changes the styling
      // should have to change this deliberately rather than by accident.
      data-headline={headline === true ? 'true' : undefined}
      className={[
        'rounded-md border bg-white p-3',
        headline === true ? 'border-slate-900' : 'border-slate-200',
      ].join(' ')}
    >
      <p className="text-xs uppercase tracking-wide text-slate-500">
        {label}
        {rate?.confidence === 'directional' ? (
          <span className="ml-1 font-normal normal-case text-amber-600">approximate</span>
        ) : null}
      </p>
      <p
        className={[
          'mt-1 font-semibold text-slate-900',
          headline === true ? 'text-3xl' : 'text-2xl',
        ].join(' ')}
      >
        {formatRate(rate)}
      </p>
      {footnote === null ? null : <p className="mt-1 text-xs text-slate-500">{footnote}</p>}
    </div>
  );
}

function CountTile({ label, value, hint }: { label: string; value: number | undefined; hint?: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">
        {typeof value === 'number' ? value.toLocaleString() : '—'}
      </p>
      {hint === undefined ? null : <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function RangePicker({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return (
    <>
      <label className="sr-only" htmlFor="range">
        Date range
      </label>
      <select
        id="range"
        value={days}
        onChange={(event) => onChange(Number(event.target.value))}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
      >
        <option value={7}>Last 7 days</option>
        <option value={30}>Last 30 days</option>
        <option value={90}>Last 90 days</option>
        <option value={365}>Last year</option>
      </select>
    </>
  );
}

/** A range in UTC days, matching how the server stores and buckets them. */
export function rangeFor(days: number, now = new Date()): { from: string; to: string } {
  return {
    from: new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
  };
}
