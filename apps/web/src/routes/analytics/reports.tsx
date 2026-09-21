import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Card,
  CardHeader,
  DashboardSkeleton,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  fmtCount,
} from '@relayd/ui';
import {
  analyticsApi,
  analyticsKeys,
  formatRate,
  formatSmallRate,
  type ProviderStatsRow,
} from '../../api/analytics.js';
import { providerApi, providerKeys, type Connection } from '../../api/providers.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { dayLabel } from './format.js';
import { ActivityCard, RANGES, RateCards, rangeQuery, requestIdOf, type RangeKey } from './dashboard.js';
import { RangePicker } from './parts.js';

/**
 * Reports — the workspace's own numbers over a range.
 *
 * NO FRAME EXISTS FOR THIS PAGE. The sidebar has linked "Reports" to
 * `/reports` since the shell was built (K4d draws the route, but only in its
 * error state), and the app answered it with the not-found page. It is built
 * here out of the dashboard's own vocabulary — the same four rate cards, the
 * same activity chart, the same range control — plus the one thing the
 * dashboard has no room for: `GET /analytics/providers`, which is the only
 * place in the product that answers "is one of my connections dragging the
 * rest down".
 *
 * Nothing is invented visually: every block on the page already exists on a
 * frame. What is new is only which blocks are on it.
 *
 * The connection *names* come from `GET /providers`, because `provider_stats`
 * knows an id and the connection list owns the label. A missing name falls
 * back to the id rather than to "Unknown provider" — the id is at least
 * something support can act on.
 */
export function ReportsPage() {
  const [rangeKey, setRangeKey] = useState<RangeKey>('period');
  const range = rangeQuery(rangeKey);
  const { current, currentWorkspaceId } = useAuth();

  const overview = useQuery({
    queryKey: analyticsKeys.overview(currentWorkspaceId, range),
    queryFn: () => analyticsApi.overview(range),
  });

  // Only the bounce split and the auto-pause threshold are read from it
  // here; if the call fails the cards drop those two lines and every rate
  // still renders.
  const summary = useQuery({
    queryKey: analyticsKeys.dashboard(currentWorkspaceId),
    queryFn: () => analyticsApi.dashboard(),
    retry: false,
  });

  const providers = useQuery({
    queryKey: analyticsKeys.providers(currentWorkspaceId, range),
    queryFn: () => analyticsApi.providers(range),
  });

  const connections = useQuery({
    queryKey: providerKeys.connections(currentWorkspaceId ?? 'none'),
    queryFn: providerApi.list,
  });

  const picker = <RangePicker value={rangeKey} options={RANGES} onChange={setRangeKey} />;
  const header = (
    <PageHeader
      title="Reports"
      description={describe(current?.workspaceName, overview.data)}
      actions={picker}
    />
  );

  if (overview.isPending) {
    return (
      <>
        {header}
        <DashboardSkeleton label="Loading reports" />
      </>
    );
  }

  if (overview.isError) {
    return (
      <>
        {header}
        <ErrorState
          title="We couldn't load your reports"
          description="Nothing you did caused it and no data was changed. Send support the request ID if it keeps happening."
          {...requestIdOf(overview.error)}
          onRetry={() => void overview.refetch()}
        />
      </>
    );
  }

  if (overview.data.points.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          icon="reports"
          title="Nothing sent in this period"
          description="Reports are drawn from what your campaigns sent. Pick a wider range, or send your first campaign."
          action={
            <Link
              to="/campaigns/new"
              className="inline-flex h-8.5 items-center rounded-control bg-brand px-3 text-ui font-medium text-on-brand no-underline hover:bg-brand-hover"
            >
              Create campaign
            </Link>
          }
        />
      </>
    );
  }

  return (
    <>
      {header}

      <RateCards overview={overview.data} summary={summary.data} />

      <div className="mt-3 flex flex-col gap-3 sm:mt-0 sm:gap-5">
        <ActivityCard points={overview.data.points} />

        <ProviderDelivery
          rows={providers.data?.providers ?? []}
          connections={connections.data ?? []}
          loading={providers.isPending}
          error={providers.isError ? providers.error : null}
          onRetry={() => void providers.refetch()}
        />
      </div>
    </>
  );
}

/** "Northwind Voyages · 21 Aug – 19 Sep" */
function describe(workspace: string | undefined, overview: { from: string; to: string } | undefined): string {
  const period = overview === undefined ? null : `${dayLabel(overview.from)} – ${dayLabel(overview.to)}`;

  return [workspace, period]
    .filter((part): part is string => part !== undefined && part !== null && part !== '')
    .join(' · ');
}

/**
 * Delivery by connection.
 *
 * Rows rather than a table, which is what G4a's "Provider breakdown" does
 * with the same information: five numeric columns do not survive 390px, and
 * the frames never put a provider in a table anywhere in the product.
 *
 * The complaint rate is printed to two decimals for the same reason C1's
 * card is: one decimal turns 0.08% into 0.1%, a third of the way to the 0.3%
 * auto-pause threshold, and the difference between those two numbers is the
 * difference between fine and nearly paused.
 */
function ProviderDelivery({
  rows,
  connections,
  loading,
  error,
  onRetry,
}: {
  rows: readonly ProviderStatsRow[];
  connections: readonly Connection[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (error !== null) {
    return (
      <ErrorState
        size="table"
        title="We couldn't load delivery by provider"
        description="The rates above are unaffected."
        {...requestIdOf(error)}
        onRetry={onRetry}
      />
    );
  }

  const nameOf = (id: string): string =>
    connections.find((connection) => connection.id === id)?.name ?? id;

  return (
    <Card>
      <CardHeader
        size="sm"
        title="Delivery by provider"
        actions={
          // Beside the title on a desktop, as every card caption in the
          // frames is; gone at 390px, where a sentence that long lands on
          // top of the title rather than beside it.
          <span className="hidden text-caption font-normal text-text-2 sm:inline">
            Accepted by the provider, not delivered to a mailbox
          </span>
        }
      />

      {loading ? (
        <div className="mt-3 flex flex-col gap-2.5">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} height={34} radius={8} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          className="mt-3"
          icon="providers"
          size="table"
          title="No provider activity in this period"
          description="Delivery is attributed to a connection as events arrive from it."
        />
      ) : (
        <ul className="m-0 mt-3 flex list-none flex-col gap-2.5 p-0">
          {rows.map((row) => (
            <li key={row.providerConnectionId} className="min-w-0">
              <div className="flex justify-between gap-2 text-ui">
                <span className="truncate font-medium">{nameOf(row.providerConnectionId)}</span>
                <span className="flex-none tabular-nums">{fmtCount(row.sent)} accepted</span>
              </div>
              <div className="text-caption text-text-2 tabular-nums">
                {formatRate(row.deliveryRate)} delivered · {formatRate(row.bounceRate)} bounce ·{' '}
                {formatSmallRate(row.complaintRate)} complaint
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
