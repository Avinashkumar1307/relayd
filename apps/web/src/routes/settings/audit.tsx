import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import {
  Avatar,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  SearchInput,
  TableSkeleton,
  type Column,
} from '@relayd/ui';
import { ApiError } from '../../api/client.js';
import {
  AUDIT_RANGES,
  auditApi,
  auditCsvHref,
  auditKeys,
  type AuditEvent,
  type AuditQuery,
  type AuditRange,
} from '../../api/audit.js';
import { workspaceApi, workspaceKeys } from '../../api/workspace.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { InlineSelect, formatDateTime } from './workspace-parts.js';

/**
 * J6, J6e and J6f — /settings/audit.
 *
 * The filters live in the query string rather than in component state, so a
 * row somebody found can be sent to a colleague as a link. That is also how
 * the Resource chip gets set: the campaign and provider pages link here with
 * `?resource=cmp_8f3k2a`, and the chip is the visible, removable form of
 * that parameter.
 */

const PAGE_SIZE = 10;
const DEFAULT_RANGE: AuditRange = 'last_30';

function readQuery(params: URLSearchParams): AuditQuery {
  const range = params.get('range');
  const page = Number.parseInt(params.get('page') ?? '1', 10);

  return {
    actor: params.get('actor') ?? undefined,
    action: params.get('action') ?? undefined,
    resource: params.get('resource') ?? undefined,
    range: AUDIT_RANGES.some((option) => option.value === range)
      ? (range as AuditRange)
      : DEFAULT_RANGE,
    q: params.get('q') ?? undefined,
    page: Number.isFinite(page) && page > 0 ? page : 1,
    limit: PAGE_SIZE,
  };
}

/** Anything other than the default 30-day window counts as filtering. */
function isFiltered(query: AuditQuery): boolean {
  return (
    query.actor !== undefined ||
    query.action !== undefined ||
    query.resource !== undefined ||
    (query.q !== undefined && query.q !== '') ||
    query.range !== DEFAULT_RANGE
  );
}

export function AuditLogPage() {
  const [params, setParams] = useSearchParams();
  const { current } = useAuth();
  const workspaceId = current?.workspaceId ?? 'none';

  const query = readQuery(params);

  const workspace = useQuery({
    queryKey: workspaceKeys.details(workspaceId),
    queryFn: () => workspaceApi.details(),
  });
  const options = useQuery({
    queryKey: auditKeys.options(workspaceId),
    queryFn: () => auditApi.options(),
  });
  const events = useQuery({
    queryKey: auditKeys.list(workspaceId, query),
    queryFn: () => auditApi.list(query),
  });

  const timezone = workspace.data?.timezone ?? 'UTC';
  const planName = workspace.data?.planName;
  const retention = workspace.data?.analyticsRetentionMonths;

  const set = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value === undefined || value === '') next.delete(key);
    else next.set(key, value);
    // Any filter change goes back to the first page; page 4 of the old
    // result set is not page 4 of the new one.
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const clearFilters = () => setParams(new URLSearchParams(), { replace: true });

  const long = [
    'Every change made by a person, an API key or Relayd itself.',
    retention === undefined || planName === undefined
      ? null
      : `Retained ${retention} months on ${planName}.`,
    `Times in ${timezone}.`,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');

  const header = (full: boolean) => (
    <PageHeader
      title="Audit log"
      description={full ? long : 'Every change made by a person, an API key or Relayd itself.'}
      actions={
        full ? (
          <a href={auditCsvHref(query)} className="no-underline">
            <Button variant="secondary">Export CSV</Button>
          </a>
        ) : undefined
      }
    />
  );

  if (events.isPending) {
    return (
      <>
        {header(true)}
        <TableSkeleton rows={10} tabs={false} label="Loading the audit log" />
      </>
    );
  }

  if (events.isError) {
    return (
      <>
        {header(false)}
        <ErrorState
          title="We couldn't load the audit log"
          description="Nothing was lost; events are written before any action completes. Send support the request ID if it keeps happening."
          requestId={events.error instanceof ApiError ? events.error.requestId : undefined}
          actions={
            <a href="mailto:support@relayd.io" className="no-underline">
              <Button variant="secondary">Contact support</Button>
            </a>
          }
          onRetry={() => void events.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  const { events: rows, total } = events.data;

  if (rows.length === 0) {
    return (
      <>
        {header(false)}
        <EmptyState
          icon="audit"
          title="No events match these filters"
          description={
            retention === undefined || planName === undefined
              ? 'Try a wider date range or clear the resource filter.'
              : `Try a wider date range or clear the resource filter. Events are retained ${retention} months on ${planName}.`
          }
          action={
            isFiltered(query) ? <Button onClick={clearFilters}>Clear filters</Button> : undefined
          }
        />
      </>
    );
  }

  const page = query.page ?? 1;
  const first = (page - 1) * PAGE_SIZE + 1;
  const last = first + rows.length - 1;

  const columns: readonly Column<AuditEvent>[] = [
    {
      key: 'time',
      header: 'Time',
      width: '170px',
      cell: (event) => (
        <span className="whitespace-nowrap text-caption text-text-2 tabular-nums">
          {formatDateTime(event.occurredAt, timezone)}
        </span>
      ),
    },
    {
      key: 'actor',
      header: 'Actor',
      width: '18%',
      cell: (event) => (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar
            initials={event.actor.initials}
            name={event.actor.name}
            size={24}
            tone={event.actor.kind === 'user' ? 'brand' : 'system'}
          />
          <span className="truncate">{event.actor.name}</span>
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      width: '220px',
      cell: (event) => (
        <code className="rounded-badge bg-neutral-soft px-1.5 py-0.5 font-mono text-label text-text">
          {event.action}
        </code>
      ),
    },
    {
      key: 'resource',
      header: 'Resource',
      width: '180px',
      mono: true,
      cell: (event) => (
        <span className="block truncate text-text-2">{event.resource ?? '—'}</span>
      ),
    },
    {
      key: 'details',
      header: 'Details',
      width: '26%',
      cell: (event) => (
        <span className="block truncate text-caption text-text-2" title={event.details}>
          {event.details}
        </span>
      ),
    },
  ];

  return (
    <>
      {header(true)}

      <DataTable
        label="Audit log"
        columns={columns}
        rows={rows}
        rowKey={(event) => event.id}
        toolbar={
          <>
            <InlineSelect
              label="Filter by actor"
              variant="chip"
              prefix="Actor"
              value={query.actor ?? ''}
              onChange={(event) => set('actor', event.target.value)}
            >
              <option value="">Anyone</option>
              {(options.data?.actors ?? []).map((actor) => (
                <option key={actor.id} value={actor.id}>
                  {actor.name}
                </option>
              ))}
            </InlineSelect>

            <InlineSelect
              label="Filter by action"
              variant="chip"
              prefix="Action"
              value={query.action ?? ''}
              onChange={(event) => set('action', event.target.value)}
            >
              <option value="">All</option>
              {(options.data?.actions ?? []).map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </InlineSelect>

            {query.resource === undefined ? null : (
              <span className="inline-flex h-7 items-center gap-1.5 rounded-control border border-border bg-tint pr-1.5 pl-2.5 text-caption text-text-2">
                Resource <span className="font-mono font-medium text-text">{query.resource}</span>
                <button
                  type="button"
                  aria-label="Clear the resource filter"
                  onClick={() => set('resource', undefined)}
                  className="grid h-5 w-5 cursor-pointer place-items-center rounded-4 border-0 bg-transparent text-text-3 hover:text-text"
                >
                  <Icon name="x" size={12} strokeWidth={2.5} />
                </button>
              </span>
            )}

            <InlineSelect
              label="Filter by date"
              variant="chip"
              prefix="Date"
              value={query.range ?? DEFAULT_RANGE}
              onChange={(event) => set('range', event.target.value)}
            >
              {AUDIT_RANGES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </InlineSelect>

            <span className="flex-1" />

            <SearchInput
              label="Search details"
              size="sm"
              placeholder="Search details"
              defaultValue={query.q ?? ''}
              wrapperClassName="w-60"
              onChange={(event) => set('q', event.target.value)}
              onClear={() => set('q', undefined)}
            />
          </>
        }
        footer={
          <div className="flex items-center justify-between gap-3">
            <span className="text-caption text-text-2">
              {first}–{last} of <span className="font-medium text-text">{total.toLocaleString('en-US')}</span>{' '}
              events
            </span>
            <span className="inline-flex overflow-hidden rounded-badge border border-border">
              <button
                type="button"
                aria-label="Previous page"
                disabled={page <= 1}
                onClick={() => set('page', String(page - 1))}
                className="grid h-6.5 w-7 cursor-pointer place-items-center border-0 border-r border-border bg-transparent text-text disabled:cursor-not-allowed disabled:text-text-3"
              >
                ‹
              </button>
              <button
                type="button"
                aria-label="Next page"
                disabled={last >= total}
                onClick={() => set('page', String(page + 1))}
                className="grid h-6.5 w-7 cursor-pointer place-items-center border-0 bg-transparent text-text disabled:cursor-not-allowed disabled:text-text-3"
              >
                ›
              </button>
            </span>
          </div>
        }
      />
    </>
  );
}
