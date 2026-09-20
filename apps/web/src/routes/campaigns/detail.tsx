import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  CAMPAIGN_STATES,
  Card,
  CardHeader,
  DataTable,
  DetailSkeleton,
  ErrorState,
  Icon,
  RECIPIENT_STATES,
  SearchInput,
  SegmentedBar,
  Stat,
  StateBadge,
  fmtCount,
  stateStyle,
} from '@relayd/ui';
import type { Column } from '@relayd/ui';
import {
  RECIPIENT_FILTERS,
  campaignKeys,
  campaignsApi,
  clickRate,
  pollIntervalFor,
  type CampaignProgress,
  type CampaignStatus,
  type Recipient,
} from '../../api/campaigns.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import {
  Chip,
  DangerOutlineButton,
  FilterChip,
  LinkButton,
  Timeline,
  bounceTotal,
  requestId,
  sentence,
} from './parts.js';
import type { TimelineRow } from './parts.js';

/**
 * G3 — the campaign detail page, for every state.
 *
 * One page, four frames: sending with working filter chips (G3a), held by
 * billing (G3b), auto-paused for complaint rate (G3c) and dark (G3d, which is
 * the same markup — the tokens carry the theme and nothing here special-cases
 * it). G3m is the same page at 390px.
 *
 * What the frames insist on, and what this keeps:
 *
 *   Progress is drawn from `campaign_counters` through `/progress`, polled at
 *   `pollIntervalFor(status)` and stopped dead once the campaign is terminal.
 *   Nothing here counts recipients (CLAUDE.md section 12).
 *
 *   Click rate carries a "Headline" chip and open rate carries "approx." with
 *   "privacy proxies inflate this" underneath — every time, not only when it
 *   looks wrong.
 *
 *   Delivery uncertain is a hatched segment, a legend entry and its own filter
 *   chip. It is never added to bounces.
 */

/** `Cancel` and `Delete` are danger; the first control is primary for these. */
const PRIMARY_FIRST: ReadonlySet<CampaignStatus> = new Set([
  'draft',
  'scheduled',
  'paused',
  'held',
  'completed_with_errors',
  'failed',
]);

interface Control {
  key: string;
  label: string;
  kind: 'primary' | 'secondary' | 'danger';
}

/**
 * The header controls, from the design's `ACTIONS` map with "View analytics"
 * removed — the Analytics button is always present, and two ways to reach the
 * same page from one row is two things to read rather than one.
 */
function controlsFor(status: CampaignStatus): Control[] {
  const labels =
    status === 'draft'
      ? ['Continue editing', 'Duplicate', 'Delete']
      : status === 'scheduled'
        ? ['Edit schedule', 'Unschedule', 'Duplicate']
        : status === 'sending'
          ? ['Pause', 'Cancel', 'Clone']
          : status === 'validating' || status === 'queueing'
            ? ['Cancel']
            : status === 'paused'
              ? ['Resume', 'Cancel', 'Clone']
              : status === 'held'
                ? ['Update payment method', 'Cancel', 'Duplicate']
                : status === 'completed_with_errors'
                  ? ['Retry failed', 'Duplicate']
                  : status === 'failed'
                    ? ['Retry', 'Duplicate']
                    : ['Duplicate'];

  return labels.map((label, index) => ({
    key: label,
    label,
    kind: /Cancel|Delete|Unschedule/u.test(label)
      ? 'danger'
      : index === 0 && PRIMARY_FIRST.has(status)
        ? 'primary'
        : 'secondary',
  }));
}

export function CampaignDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currentWorkspaceId, can } = useAuth();
  const readOnly = useReadOnly();

  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const campaign = useQuery({
    queryKey: campaignKeys.one(currentWorkspaceId, id),
    queryFn: () => campaignsApi.get(id),
    enabled: id !== '',
  });

  const status = campaign.data?.campaign.status;

  const progress = useQuery({
    queryKey: campaignKeys.progress(currentWorkspaceId, id),
    queryFn: () => campaignsApi.progress(id),
    enabled: id !== '' && status !== undefined,
    // Never a fixed interval: a completed campaign never changes again, and a
    // dashboard left open overnight on one should cost nothing.
    refetchInterval: status === undefined ? false : pollIntervalFor(status),
  });

  const recipientState = RECIPIENT_FILTERS.find((entry) => entry.key === filter)?.states ?? null;
  const singleState = recipientState?.length === 1 ? recipientState[0] : undefined;

  const recipients = useQuery({
    queryKey: campaignKeys.recipients(currentWorkspaceId, id, { filter, search }),
    // BACKEND PENDING: GET /campaigns/:id/recipients?state=a,b — the schema
    // takes one state, and three of G3's five chips name a set of them. The
    // single-state chips filter server-side; the rest narrow the page here,
    // which is honest for one page and wrong for pagination.
    queryFn: () =>
      campaignsApi.recipients(id, {
        ...(singleState === undefined ? {} : { state: singleState }),
        ...(search === '' ? {} : { search }),
      }),
    enabled: id !== '',
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: campaignKeys.scoped(currentWorkspaceId) });
    void queryClient.invalidateQueries({ queryKey: campaignKeys.all });
  };

  const timeline = useQuery({
    queryKey: campaignKeys.timeline(currentWorkspaceId, id),
    // BACKEND PENDING: GET /campaigns/:id/timeline
    queryFn: () => campaignsApi.timeline(id),
    enabled: id !== '',
    retry: false,
  });

  const lifecycle = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'cancel') =>
      action === 'pause'
        ? campaignsApi.pause(id)
        : action === 'resume'
          ? campaignsApi.resume(id)
          : campaignsApi.cancel(id),
    onSuccess: invalidate,
  });

  const duplicate = useMutation({
    mutationFn: () => campaignsApi.clone(id),
    onSuccess: (created) => {
      invalidate();
      navigate(`/campaigns/${created.id}/edit/details`);
    },
  });

  const retry = useMutation({
    mutationFn: () => campaignsApi.retryFailed(id),
    onSuccess: invalidate,
  });

  if (campaign.isError) {
    return (
      <>
        <BackLink />
        <ErrorState
          title="We couldn't load this campaign"
          description={`${sentence(campaign.error)} Sending is unaffected; only this page failed to load. Send support the request ID if it keeps happening.`}
          {...requestId(campaign.error)}
          actions={<Button variant="secondary">Contact support</Button>}
          onRetry={() => void campaign.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  if (campaign.isPending || campaign.data === undefined) {
    return (
      <>
        <BackLink />
        <DetailSkeleton />
      </>
    );
  }

  const row = campaign.data.campaign;
  const counters: CampaignProgress | null = progress.data ?? campaign.data.counters;
  const counts = counters?.counts ?? row.counts ?? {};
  const total = counters?.total ?? row.recipientCount;

  const outstanding = (counts.pending ?? 0) + (counts.queued ?? 0) + (counts.sending ?? 0);
  const processed = Math.max(0, total - outstanding);
  const percent = total > 0 ? Math.round((processed / total) * 100) : 0;
  const delivered = counts.delivered ?? 0;

  const canAct = can('campaign:launch') && !readOnly;
  const canWrite = can('campaign:write') && !readOnly;
  const actReason = readOnly
    ? 'Workspace is read-only'
    : 'Only Owners and Admins can start or stop a send';
  const writeReason = readOnly ? 'Workspace is read-only' : 'Your role cannot change campaigns';

  const run = (control: Control): void => {
    switch (control.label) {
      case 'Pause':
        lifecycle.mutate('pause');
        return;
      case 'Resume':
        lifecycle.mutate('resume');
        return;
      case 'Cancel':
      case 'Unschedule':
        lifecycle.mutate('cancel');
        return;
      case 'Retry failed':
      case 'Retry':
        retry.mutate();
        return;
      case 'Duplicate':
      case 'Clone':
        duplicate.mutate();
        return;
      case 'Continue editing':
        navigate(`/campaigns/${row.id}/edit/details`);
        return;
      case 'Edit schedule':
        navigate(`/campaigns/${row.id}/edit/schedule`);
        return;
      case 'Update payment method':
        navigate('/billing');
        return;
      case 'Delete':
        navigate('/campaigns');
        return;
      default:
    }
  };

  const gated = (control: Control): { disabled: boolean; title?: string } => {
    const needsLaunch = ['Pause', 'Resume', 'Cancel', 'Unschedule', 'Retry', 'Retry failed'].includes(
      control.label,
    );
    const needsWrite = ['Continue editing', 'Edit schedule', 'Duplicate', 'Clone', 'Delete'].includes(
      control.label,
    );

    if (needsLaunch && !canAct) return { disabled: true, title: actReason };
    if (needsWrite && !canWrite) return { disabled: true, title: writeReason };
    return { disabled: false };
  };

  const filterCounts: Record<string, number> = {
    all: total,
    delivered,
    pending: outstanding,
    bounced: (counts.soft ?? 0) + (counts.hard ?? 0) + (counts.complaint ?? 0) + (counts.failed ?? 0),
    uncertain: counts.uncertain ?? counters?.deliveryUncertain ?? 0,
  };

  const visibleRecipients = (recipients.data?.items ?? []).filter((item) =>
    recipientState === null || singleState !== undefined ? true : recipientState.includes(item.state),
  );

  const events: TimelineRow[] = (timeline.data ?? []).map((event) => ({
    id: event.id,
    title: event.title,
    time: event.time,
    detail: event.detail,
    tone: event.tone,
  }));

  return (
    <>
      {/* -------------------------------------------------------- header -- */}
      <div className="mb-4 flex flex-col items-start justify-between gap-4 md:flex-row">
        <div className="min-w-0 flex-1">
          <BackLink />
          <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
            <h1 className="m-0 min-w-0 text-title font-semibold leading-heading tracking-heading">
              {row.name}
            </h1>
            <StateBadge states={CAMPAIGN_STATES} state={row.status} />
          </div>
          <p className="mt-1 mb-0 text-ui text-text-2">
            {row.metaLabel ?? row.id}
          </p>
        </div>

        <div className="flex flex-none flex-wrap items-center gap-2 md:pt-1">
          <LinkButton to={`/campaigns/${row.id}/analytics`} variant="secondary">
            Analytics
          </LinkButton>
          {controlsFor(row.status).map((control) => {
            const { disabled, title } = gated(control);

            if (control.kind === 'danger') {
              return (
                <DangerOutlineButton
                  key={control.key}
                  onClick={() => run(control)}
                  disabled={disabled}
                  title={title}
                >
                  {control.label}
                </DangerOutlineButton>
              );
            }

            return (
              <Button
                key={control.key}
                variant={control.kind}
                disabled={disabled}
                title={title}
                onClick={() => run(control)}
              >
                {control.label}
              </Button>
            );
          })}
        </div>
      </div>

      {/* ----------------------------------------------- hold / auto-pause -- */}
      {row.hold === null || row.hold === undefined ? null : (
        <div
          role={row.hold.tone === 'danger' ? 'alert' : 'status'}
          className={[
            'mb-4 flex flex-wrap items-center gap-3 rounded-control border px-4 py-3 text-ui',
            row.hold.tone === 'danger'
              ? 'border-danger bg-danger-soft'
              : 'border-warning bg-warning-soft',
          ].join(' ')}
        >
          <span
            className={`flex-none ${row.hold.tone === 'danger' ? 'text-danger-text' : 'text-warning-text'}`}
          >
            <Icon name={row.hold.icon} size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="font-semibold">{row.hold.title}</span>{' '}
            <span className="text-text-2">{row.hold.body}</span>
          </span>
          <Link
            to={row.hold.actionHref}
            className="flex-none text-ui font-medium text-brand no-underline"
          >
            {row.hold.actionLabel}
          </Link>
        </div>
      )}

      {/* ------------------------------------------------------ progress -- */}
      <Card className="mb-4">
        <SegmentedBar
          counts={counts}
          total={total}
          label="Progress"
          labelAside={
            <>
              <span className="font-medium text-text tabular-nums">{fmtCount(processed)}</span> of{' '}
              {fmtCount(total)} processed · {percent}%
            </>
          }
        />
      </Card>

      {/* --------------------------------------------------------- stats -- */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Recipients"
          value={fmtCount(total)}
          delta={<span className="block truncate">after {fmtCount(counters?.suppressed ?? 0)} suppressions</span>}
        />
        <Stat
          label="Delivered"
          value={fmtCount(delivered)}
          delta={
            <span className="block truncate">
              {delivered > 0 && total > 0
                ? `${((delivered / total) * 100).toFixed(1)}% of recipients`
                : 'not started'}
            </span>
          }
        />
        <Stat
          label="Click rate"
          aside={
            <Chip tone="brand" size="xs">
              Headline
            </Chip>
          }
          value={clickRate(counters?.clicks ?? row.clicks, delivered)}
          delta={
            <span className="block truncate">
              {delivered > 0 ? `${fmtCount(counters?.clicks ?? row.clicks ?? 0)} unique clickers` : '—'}
            </span>
          }
        />
        <Stat
          label="Open rate"
          aside={<Chip size="xs">approx.</Chip>}
          value={
            counters?.openRate === null || counters?.openRate === undefined
              ? '—'
              : `~${counters.openRate.toFixed(1)}%`
          }
          delta={<span className="block truncate">privacy proxies inflate this</span>}
        />
        <Stat
          label="Bounces"
          value={fmtCount(bounceTotal(counts))}
          delta={
            <span className="block truncate">
              {delivered > 0
                ? `soft ${fmtCount(counts.soft ?? 0)} · hard ${fmtCount(counts.hard ?? 0)}`
                : '—'}
            </span>
          }
        />
        <Stat
          label="Complaints"
          value={fmtCount(counts.complaint ?? 0)}
          delta={
            <span className="block truncate">
              {delivered > 0
                ? `${(((counts.complaint ?? 0) / delivered) * 100).toFixed(2)}% · auto-pause at 0.3%`
                : 'auto-pause at 0.3%'}
            </span>
          }
        />
      </div>

      {/* --------------------------------------- recipients and timeline -- */}
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <RecipientsPanel
          total={total}
          filter={filter}
          onFilter={setFilter}
          filterCounts={filterCounts}
          search={search}
          onSearch={setSearch}
          rows={visibleRecipients}
          loading={recipients.isPending}
          error={recipients.error}
          onRetry={() => void recipients.refetch()}
        />

        <Card as="section">
          <CardHeader title="Event timeline" />
          <div className="mt-3">
            {events.length === 0 ? (
              <p className="m-0 text-ui text-text-2">
                Nothing has happened yet. Launch, pause and delivery events appear here as they
                occur.
              </p>
            ) : (
              <Timeline events={events} />
            )}
          </div>
        </Card>
      </div>
    </>
  );
}

function BackLink() {
  return (
    <Link to="/campaigns" className="text-ui font-medium text-brand no-underline">
      ← Campaigns
    </Link>
  );
}

function RecipientsPanel({
  total,
  filter,
  onFilter,
  filterCounts,
  search,
  onSearch,
  rows,
  loading,
  error,
  onRetry,
}: {
  total: number;
  filter: string;
  onFilter: (key: string) => void;
  filterCounts: Record<string, number>;
  search: string;
  onSearch: (value: string) => void;
  rows: readonly Recipient[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const columns: Column<Recipient>[] = useMemo(
    () => [
      {
        key: 'email',
        header: 'Email',
        cell: (row) => <span className="block truncate font-medium">{row.email}</span>,
      },
      {
        key: 'state',
        header: 'State',
        width: '150px',
        cell: (row) => <StateBadge states={RECIPIENT_STATES} state={row.state} />,
      },
      {
        key: 'messageId',
        header: 'Provider message ID',
        cell: (row) => (
          <span className="block truncate font-mono text-label text-text-2">
            {row.providerMessageId ?? '—'}
          </span>
        ),
      },
      {
        key: 'tries',
        header: 'Tries',
        align: 'right',
        width: '60px',
        cell: (row) => <span className="text-text-2">{row.attemptCount}</span>,
      },
      {
        key: 'last',
        header: 'Last event',
        width: '140px',
        cell: (row) => (
          <span className="block truncate text-caption text-text-2">{row.lastEvent ?? '—'}</span>
        ),
      },
      {
        key: 'sender',
        header: 'Sender used',
        width: '120px',
        cell: (row) => (
          <span className="block truncate text-caption text-text-2">{row.senderUsed ?? '—'}</span>
        ),
      },
    ],
    [],
  );

  if (error !== null && error !== undefined) {
    return (
      <ErrorState
        size="table"
        title="We couldn't load recipients"
        description={`${sentence(error)} The campaign itself is unaffected.`}
        {...requestId(error)}
        onRetry={onRetry}
        retryLabel="Retry"
      />
    );
  }

  const toolbar = (
    <div className="-mx-4 -my-3 flex w-[calc(100%+2rem)] flex-wrap items-center gap-2 px-4 py-2.5">
      <span className="mr-1.5 text-body font-semibold text-text">Recipients</span>
      {RECIPIENT_FILTERS.map((entry) => (
        <FilterChip
          key={entry.key}
          label={entry.label}
          count={fmtCount(filterCounts[entry.key] ?? 0)}
          active={entry.key === filter}
          onClick={() => onFilter(entry.key)}
        />
      ))}
      <span className="flex-1" />
      <SearchInput
        label="Search email"
        placeholder="Search email"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        onClear={() => onSearch('')}
      />
    </div>
  );

  return (
    <>
      {/* Mobile (G3m): email and state only. Six columns at 390px is a table
          nobody can read, and the message id is the one people copy, not scan. */}
      <div className="rounded-card border border-border bg-surface xl:hidden">
        <div className="border-b border-border px-4 py-3 text-body font-semibold">Recipients</div>
        <ul className="m-0 list-none p-0">
          {rows.slice(0, 6).map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 text-ui last:border-b-0"
            >
              <span className="min-w-0 truncate">{row.email}</span>
              <span className="flex-none">
                <StateBadge states={RECIPIENT_STATES} state={row.state} />
              </span>
            </li>
          ))}
        </ul>
        <div className="px-4 py-3 text-ui">
          <span className="text-text-2">
            Showing {rows.slice(0, 6).length} of {fmtCount(total)} · updates live
          </span>
        </div>
      </div>

      <div className="hidden xl:block">
        <DataTable
          label="Recipients"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          toolbar={toolbar}
          loading={loading ? <TableRowsLoading /> : undefined}
          empty={
            <div className="px-6 py-14 text-center text-ui text-text-2">
              No recipients in this view.
            </div>
          }
          footer={
            <>
              <span>
                Showing {rows.length} of {fmtCount(total)} · updates live
              </span>
              <Pager />
            </>
          }
        />
      </div>
    </>
  );
}

/** The frames' 26px prev/next pair. Disabled until paging is wired. */
function Pager() {
  return (
    <span className="inline-flex overflow-hidden rounded-badge border border-border">
      <span
        aria-hidden="true"
        className="grid h-6.5 w-7 place-items-center border-r border-border text-text-3"
      >
        ‹
      </span>
      <span aria-hidden="true" className="grid h-6.5 w-7 place-items-center text-text">
        ›
      </span>
    </span>
  );
}

function TableRowsLoading() {
  return (
    <div role="status" aria-label="Loading recipients" className="px-4 py-8 text-center text-ui text-text-2">
      Loading recipients…
    </div>
  );
}

/** Exported for the tests: the label a state resolves to in the recipient table. */
export function recipientStateLabel(state: string): string {
  return stateStyle(RECIPIENT_STATES, state).label;
}
