import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  CAMPAIGN_STATES,
  ConfirmDestructive,
  DataTable,
  EmptyState,
  ErrorState,
  Icon,
  Menu,
  SearchInput,
  SegmentedBar,
  StateBadge,
  TableSkeleton,
  Tabs,
  fmtCount,
} from '@relayd/ui';
import type { Column, MenuItem } from '@relayd/ui';
import {
  CAMPAIGN_TABS,
  actionsFor,
  campaignKeys,
  campaignsApi,
  clickRate,
  isDestructiveAction,
  type Campaign,
  type CampaignStatus,
} from '../../api/campaigns.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import { IfPermitted } from '../../auth/guards.js';
import {
  LinkButton,
  SegmentKeyLegend,
  bounceTotal,
  countOrDash,
  requestId,
  sentence,
} from './parts.js';

/**
 * G1 — Campaigns.
 *
 * "Every send, with its state and what happens next." The table is the page:
 * one row per campaign, its segmented bar drawn from `campaign_counters` and
 * never from a `COUNT(*)` (CLAUDE.md section 12), and a per-state action menu
 * taken verbatim from the design's `ACTIONS` map.
 *
 * Three rules the frames encode and this page keeps:
 *
 *   Click rate is the headline number. Open rate does not appear in the list
 *   at all, because a column of numbers inflated 30-60% by privacy proxies is
 *   a column people sort by.
 *
 *   Delivery uncertain is its own hatched segment and its own legend entry.
 *   It is never folded into failures — "we could not send" and "we do not
 *   know whether we sent" are different things to tell a customer (D3).
 *
 *   The menu offers only what the state allows. Showing Pause on a paused
 *   campaign produces a 409 the customer reads as the product being broken.
 */

const DESCRIPTION = 'Every send, with its state and what happens next.';
const LIVE_SUFFIX = ' Numbers update live while a campaign is sending.';

const LIVE_STATES: ReadonlySet<CampaignStatus> = new Set([
  'sending',
  'validating',
  'queueing',
  'pausing',
]);

export function CampaignsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currentWorkspaceId, can } = useAuth();
  const readOnly = useReadOnly();

  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState<Campaign | null>(null);

  const campaigns = useQuery({
    queryKey: campaignKeys.list(currentWorkspaceId, { search }),
    queryFn: () => campaignsApi.list(search === '' ? {} : { search }),
    // The list is a dashboard people leave open; a sending campaign's bar has
    // to move. The interval is the slow one — the detail page is where a send
    // is watched second by second.
    refetchInterval: 15_000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: campaignKeys.scoped(currentWorkspaceId) });
    void queryClient.invalidateQueries({ queryKey: campaignKeys.all });
  };

  const lifecycle = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'pause' | 'resume' | 'cancel' }) =>
      action === 'pause'
        ? campaignsApi.pause(id)
        : action === 'resume'
          ? campaignsApi.resume(id)
          : campaignsApi.cancel(id),
    onSuccess: invalidate,
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => campaignsApi.clone(id),
    onSuccess: (created) => {
      invalidate();
      navigate(`/campaigns/${created.id}/edit/details`);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => campaignsApi.remove(id),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
    },
  });

  const retry = useMutation({
    mutationFn: (id: string) => campaignsApi.retryFailed(id),
    onSuccess: invalidate,
  });

  const rows = campaigns.data?.items ?? [];
  const live = rows.some((row) => LIVE_STATES.has(row.status));

  const visible = useMemo(() => {
    const states = CAMPAIGN_TABS.find((entry) => entry.key === tab)?.states ?? null;
    return states === null ? rows : rows.filter((row) => states.includes(row.status));
  }, [rows, tab]);

  const canWrite = can('campaign:write') && !readOnly;
  const canLaunchAction = can('campaign:launch') && !readOnly;
  const writeReason = readOnly
    ? 'Workspace is read-only'
    : 'Your role cannot change campaigns';
  const launchReason = readOnly
    ? 'Workspace is read-only'
    : 'Only Owners and Admins can start or stop a send';

  /**
   * The design's per-state menu, wired.
   *
   * The labels are the design's and are not paraphrased. Where an action is
   * not available to this role the item stays visible and disabled with its
   * reason in the tooltip — docs/09: a missing permission says why.
   */
  const menuFor = (campaign: Campaign): MenuItem[] =>
    actionsFor(campaign.status).map((label): MenuItem => {
      const danger = isDestructiveAction(label);
      const base = {
        key: label,
        label,
        ...(danger ? { tone: 'danger' as const } : {}),
      };

      switch (label) {
        case 'Edit':
        case 'Edit schedule':
          return {
            ...base,
            disabled: !canWrite,
            reason: canWrite ? undefined : writeReason,
            onSelect: () =>
              navigate(`/campaigns/${campaign.id}/edit/${label === 'Edit' ? 'details' : 'schedule'}`),
          };
        case 'Duplicate':
        case 'Clone':
          return {
            ...base,
            disabled: !canWrite,
            reason: canWrite ? undefined : writeReason,
            onSelect: () => duplicate.mutate(campaign.id),
          };
        case 'Delete':
          return {
            ...base,
            disabled: !canWrite,
            reason: canWrite ? undefined : writeReason,
            onSelect: () => setDeleting(campaign),
          };
        case 'Pause':
          return {
            ...base,
            disabled: !canLaunchAction,
            reason: canLaunchAction ? undefined : launchReason,
            onSelect: () => lifecycle.mutate({ id: campaign.id, action: 'pause' }),
          };
        case 'Resume':
          return {
            ...base,
            disabled: !canLaunchAction,
            reason: canLaunchAction ? undefined : launchReason,
            onSelect: () => lifecycle.mutate({ id: campaign.id, action: 'resume' }),
          };
        case 'Cancel':
          return {
            ...base,
            disabled: !canLaunchAction,
            reason: canLaunchAction ? undefined : launchReason,
            onSelect: () => lifecycle.mutate({ id: campaign.id, action: 'cancel' }),
          };
        case 'Unschedule':
          return {
            ...base,
            disabled: !canLaunchAction,
            reason: canLaunchAction ? undefined : launchReason,
            onSelect: () => lifecycle.mutate({ id: campaign.id, action: 'cancel' }),
          };
        case 'Retry failed':
        case 'Retry':
          return {
            ...base,
            disabled: !canLaunchAction,
            reason: canLaunchAction ? undefined : launchReason,
            onSelect: () => retry.mutate(campaign.id),
          };
        case 'View analytics':
          return { ...base, onSelect: () => navigate(`/campaigns/${campaign.id}/analytics`) };
        case 'Update payment method':
          return { ...base, onSelect: () => navigate('/billing') };
        case 'Archive':
          // BACKEND PENDING: POST /campaigns/:id/archive
          return { ...base, tone: 'muted', disabled: true, reason: 'Archiving is not available yet' };
        default:
          return base;
      }
    });

  const columns: Column<Campaign>[] = [
    {
      key: 'name',
      header: 'Campaign',
      cell: (row) => (
        <>
          <Link
            to={`/campaigns/${row.id}`}
            className="block truncate font-medium text-text no-underline hover:text-brand"
          >
            {row.name}
          </Link>
          <span className="block truncate text-caption text-text-2">
            {row.note ?? row.id}
          </span>
        </>
      ),
    },
    {
      key: 'state',
      header: 'State',
      width: '168px',
      cell: (row) => <StateBadge states={CAMPAIGN_STATES} state={row.status} />,
    },
    {
      key: 'progress',
      header: 'Progress',
      width: '130px',
      cell: (row) => (
        <div className="w-[106px]">
          <SegmentedBar
            size="sm"
            legend={false}
            note={false}
            counts={row.counts ?? {}}
            total={row.recipientCount}
          />
        </div>
      ),
    },
    {
      key: 'recipients',
      header: 'Recipients',
      align: 'right',
      width: '96px',
      cell: (row) => (row.recipientCount > 0 ? fmtCount(row.recipientCount) : '—'),
    },
    {
      key: 'sent',
      header: 'Sent',
      align: 'right',
      width: '90px',
      cell: (row) => {
        const outstanding = (row.counts?.pending ?? 0) + (row.counts?.sending ?? 0);
        const sent = row.recipientCount - outstanding;
        return row.recipientCount > 0 && sent > 0 ? fmtCount(sent) : '—';
      },
    },
    {
      key: 'clicks',
      header: 'Clicks',
      align: 'right',
      width: '84px',
      cell: (row) => clickRate(row.clicks, row.counts?.delivered),
    },
    {
      key: 'bounces',
      header: 'Bounces',
      align: 'right',
      width: '90px',
      cell: (row) => (
        <span className="text-text-2">
          {row.recipientCount > 0 ? fmtCount(bounceTotal(row.counts)) : '—'}
        </span>
      ),
    },
    {
      key: 'when',
      header: 'Scheduled / sent',
      width: '150px',
      cell: (row) => (
        <span className="block truncate text-caption text-text-2">{row.whenLabel ?? '—'}</span>
      ),
    },
    {
      key: 'sender',
      header: 'Sender',
      width: '160px',
      cell: (row) => (
        <span className="block truncate text-caption text-text-2">{row.senderLabel ?? '—'}</span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      width: '44px',
      cell: (row) => <Menu items={menuFor(row)} label={`Actions for ${row.name}`} />,
    },
  ];

  const createButton = (
    <IfPermitted permission="campaign:write">
      {readOnly ? (
        <Button disabled title="Workspace is read-only">
          <Icon name="plus" size={15} strokeWidth={2.25} />
          Create campaign
        </Button>
      ) : (
        <LinkButton to="/campaigns/new">
          <Icon name="plus" size={15} strokeWidth={2.25} />
          Create campaign
        </LinkButton>
      )}
    </IfPermitted>
  );

  const header = (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="m-0 text-title font-semibold leading-heading tracking-heading">Campaigns</h1>
        <p className="mt-1 mb-0 text-body text-text-2">
          {DESCRIPTION}
          {live ? LIVE_SUFFIX : ''}
        </p>
      </div>
      <div className="flex flex-none items-center gap-2">{createButton}</div>
    </div>
  );

  if (campaigns.isError) {
    return (
      <>
        {header}
        <ErrorState
          title="We couldn't load campaigns"
          description={`${sentence(campaigns.error)} Sending and scheduled launches are unaffected; only this list failed to load. Send support the request ID if it keeps happening.`}
          {...requestId(campaigns.error)}
          actions={<Button variant="secondary">Contact support</Button>}
          onRetry={() => void campaigns.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  if (campaigns.isPending) {
    return (
      <>
        {header}
        <TableSkeleton rows={8} label="Loading campaigns" />
      </>
    );
  }

  if (rows.length === 0 && search === '') {
    return (
      <>
        {header}
        <EmptyState
          icon="campaigns"
          title="No campaigns yet"
          description="Create your first campaign: pick an audience, a verified sender and a published template, then review the pre-flight checks before launch."
          action={createButton}
        />
      </>
    );
  }

  const tabItems = CAMPAIGN_TABS.map((entry) => ({
    key: entry.key,
    label: entry.label,
    count: entry.states === null ? rows.length : rows.filter((row) => entry.states?.includes(row.status)).length,
  }));

  return (
    <>
      {header}

      {/* Mobile (G1m): pill tabs and one card per campaign. A ten-column
          table at 390px is a table nobody reads. */}
      <div className="md:hidden">
        <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
          {tabItems.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={item.key === tab}
              onClick={() => setTab(item.key)}
              className={[
                'inline-flex h-8 flex-none cursor-pointer items-center gap-1.5 rounded-full border px-3 text-ui font-medium',
                item.key === tab
                  ? 'border-brand bg-brand-soft text-brand'
                  : 'border-border bg-surface text-text-2',
              ].join(' ')}
            >
              {item.label}
              <span className="tabular-nums">{item.count}</span>
            </button>
          ))}
        </div>

        <ul className="flex flex-col gap-3">
          {visible.map((row) => (
            <li key={row.id} className="rounded-card border border-border bg-surface p-3.5">
              <div className="flex items-start justify-between gap-3">
                <Link
                  to={`/campaigns/${row.id}`}
                  className="min-w-0 flex-1 text-body font-medium text-wrap text-text no-underline"
                >
                  {row.name}
                </Link>
                <span className="flex-none">
                  <StateBadge states={CAMPAIGN_STATES} state={row.status} />
                </span>
              </div>
              <div className="mt-2.5">
                <SegmentedBar
                  size="sm"
                  legend={false}
                  note={false}
                  counts={row.counts ?? {}}
                  total={row.recipientCount}
                />
              </div>
              <div className="mt-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-caption text-text-2">
                <span className="min-w-0">
                  {countOrDash(row.recipientCount > 0 ? row.recipientCount : null)} recipients ·{' '}
                  {clickRate(row.clicks, row.counts?.delivered)} clicks
                </span>
                <span className="min-w-0">{row.whenLabel ?? '—'}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Desktop (G1): the table. */}
      <div className="hidden md:block">
        <DataTable
          label="Campaigns"
          columns={columns}
          rows={visible}
          rowKey={(row) => row.id}
          toolbar={
            <Tabs
              variant="card"
              label="Campaign states"
              items={tabItems}
              value={tab}
              onChange={setTab}
              className="-mx-4 -my-3 w-[calc(100%+2rem)] border-b-0"
              actions={
                <SearchInput
                  label="Search campaigns"
                  placeholder="Search campaigns"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onClear={() => setSearch('')}
                  className="my-2"
                />
              }
            />
          }
          empty={
            <div className="p-6">
              <EmptyState
                size="table"
                icon="campaigns"
                title="No campaigns in this view"
                description="Change the tab or clear the search to see the rest."
                action={
                  <Button variant="secondary" onClick={() => setTab('all')}>
                    All campaigns
                  </Button>
                }
              />
            </div>
          }
          footer={
            <>
              <span className="flex-none">
                {visible.length} of {rows.length} campaigns
              </span>
              <SegmentKeyLegend />
            </>
          }
        />
      </div>

      <ConfirmDestructive
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting !== null) remove.mutate(deleting.id);
        }}
        title="Delete this campaign?"
        confirmLabel="Delete campaign"
        pending={remove.isPending}
      >
        <p className="m-0 text-ui text-text-2">
          {deleting?.name} is a draft, so nothing has been sent. Deleting it removes the draft and
          its audience selection. This cannot be undone.
        </p>
      </ConfirmDestructive>
    </>
  );
}
