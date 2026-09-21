import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  TableSkeleton,
  fmtCount,
} from '@relayd/ui';
import type { Column } from '@relayd/ui';
import { poolKeys, poolsApi, type Pool } from '../../api/pools.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import { IfPermitted } from '../../auth/guards.js';
import { LinkButton } from '../system/link-button.js';
import { usedByLabel } from './headroom.js';
import { Guardrail, HeadroomBar, SenderChip, StrategyPill, requestId, sentence } from './parts.js';

/**
 * H1 — Sending pools.
 *
 * "Groups of verified senders a campaign can send through. A pool spreads
 * load or fails over; it never raises a provider's limits." The second
 * sentence of the page's own description is the thing the table is arranged
 * to prove: the headroom column shows the connections counted once, and the
 * note under it names how many connections those members actually are.
 *
 * The three states below are H1a, H1e and H1f. The error state's wording is
 * the frame's and it matters: a pool list that fails to load does not stop a
 * send, and a customer looking at a red card in the middle of a campaign
 * needs to be told that in the first sentence.
 */

const DESCRIPTION =
  "Groups of verified senders a campaign can send through. A pool spreads load or fails over; it never raises a provider's limits.";

const SHARED_QUOTA_NOTE =
  'Senders that share a provider connection share one quota. Combined headroom counts each connection once.';

export function PoolsPage() {
  const { currentWorkspaceId, can } = useAuth();
  const readOnly = useReadOnly();

  const pools = useQuery({
    queryKey: poolKeys.list(currentWorkspaceId),
    queryFn: () => poolsApi.list(),
  });

  const rows = pools.data ?? [];

  const writable = can('provider:write') && !readOnly;
  const writeReason = readOnly
    ? 'Workspace is read-only'
    : 'Only Owners and Admins can change sending pools';

  /**
   * A role without `provider:write` does not see this at all; a workspace in
   * read-only keeps it, disabled, saying why (K2 — the data stays visible and
   * every write action is disabled with its reason).
   */
  const createButton = (withIcon: boolean) => (
    <IfPermitted permission="provider:write">
      {writable ? (
        <LinkButton to="/pools/new" variant="primary">
          {withIcon ? <Icon name="plus" size={15} strokeWidth={2.25} /> : null}
          Create pool
        </LinkButton>
      ) : (
        <Button disabled title={writeReason}>
          {withIcon ? <Icon name="plus" size={15} strokeWidth={2.25} /> : null}
          Create pool
        </Button>
      )}
    </IfPermitted>
  );

  /**
   * Always a link, for every role. The drawer is the only place a pool's
   * members and its real headroom can be read, and reading is `provider:read`
   * — which everybody has. The save is what `provider:write` gates, and the
   * drawer disables it with its reason.
   */
  const editLink = (pool: Pool) => (
    <Link
      to={`/pools/${pool.id}`}
      className="text-ui font-medium text-brand no-underline hover:text-brand-hover"
    >
      Edit
    </Link>
  );

  const columns: Column<Pool>[] = [
    {
      key: 'pool',
      header: 'Pool',
      width: '17%',
      cell: (pool) => (
        <>
          <div className="truncate font-medium">{pool.name}</div>
          <div className="truncate font-mono text-label text-text-3">{pool.id}</div>
        </>
      ),
    },
    {
      key: 'members',
      header: 'Members',
      width: '22%',
      cell: (pool) => (
        <div className="flex flex-wrap gap-1">
          {(pool.members ?? []).map((member) => (
            <SenderChip
              key={member.senderAccountId}
              monogram={member.monogram}
              email={member.email}
            />
          ))}
          {(pool.members ?? []).length === 0 ? <span className="text-text-2">—</span> : null}
        </div>
      ),
    },
    {
      key: 'strategy',
      header: 'Strategy',
      width: '140px',
      cell: (pool) => <StrategyPill strategy={pool.strategy} />,
    },
    {
      key: 'rate',
      header: 'Combined /s',
      align: 'right',
      width: '120px',
      // BACKEND PENDING: GET /pools serves no `combinedPerSecond` field.
      cell: (pool) => (pool.combinedPerSecond === undefined ? '—' : fmtCount(pool.combinedPerSecond)),
    },
    {
      key: 'headroom',
      header: 'Combined headroom today',
      width: '18%',
      // BACKEND PENDING: GET /pools serves no `headroom` field. The
      // per-connection numbers behind it are on GET /pools/senders.
      cell: (pool) =>
        pool.headroom === undefined ? (
          <span className="text-text-2">—</span>
        ) : (
          <HeadroomBar
            remaining={pool.headroom.remaining}
            total={pool.headroom.total}
            note={pool.headroom.note}
          />
        ),
    },
    {
      key: 'usedBy',
      header: 'Used by',
      width: '170px',
      // BACKEND PENDING: GET /pools serves no `usedBy` field.
      cell: (pool) => (
        <span className="block truncate text-caption text-text-2">{usedByLabel(pool.usedBy)}</span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: '90px',
      cell: editLink,
    },
  ];

  const header = (
    <PageHeader title="Sending pools" description={DESCRIPTION} actions={createButton(true)} />
  );

  if (pools.isError) {
    return (
      <>
        {header}
        <ErrorState
          title="We couldn't load sending pools"
          description={`${sentence(pools.error)} Campaigns already using a pool keep sending. Send support the request ID if it keeps happening.`}
          {...requestId(pools.error)}
          actions={<Button variant="secondary">Contact support</Button>}
          onRetry={() => void pools.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  if (pools.isPending) {
    return (
      <>
        {header}
        <TableSkeleton rows={4} tabs={false} label="Loading sending pools" />
      </>
    );
  }

  if (rows.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          icon="pools"
          title="No pools yet"
          description="A pool groups two or more verified senders so a campaign can spread load across connections or fail over. Single-sender campaigns do not need one."
          action={createButton(false)}
        />
      </>
    );
  }

  return (
    <>
      {header}

      {/* Mobile (390px): one card per pool. Seven columns do not fit, and a
          table that scrolls sideways hides the headroom — the one number
          this page exists to show. */}
      <ul className="flex list-none flex-col gap-3 p-0 md:hidden">
        {rows.map((pool) => (
          <li key={pool.id} className="rounded-card border border-border bg-surface p-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-medium">{pool.name}</div>
                <div className="truncate font-mono text-label text-text-3">{pool.id}</div>
              </div>
              <span className="flex-none">
                <StrategyPill strategy={pool.strategy} />
              </span>
            </div>

            <div className="mt-2.5 flex flex-wrap gap-1">
              {(pool.members ?? []).map((member) => (
                <SenderChip
                  key={member.senderAccountId}
                  monogram={member.monogram}
                  email={member.email}
                />
              ))}
            </div>

            {pool.headroom === undefined ? null : (
              <div className="mt-2.5">
                <HeadroomBar
                  remaining={pool.headroom.remaining}
                  total={pool.headroom.total}
                  note={pool.headroom.note}
                />
              </div>
            )}

            <div className="mt-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-caption text-text-2">
              <span className="min-w-0">
                {pool.combinedPerSecond === undefined ? '—' : `${pool.combinedPerSecond} /s`} ·{' '}
                {usedByLabel(pool.usedBy)}
              </span>
              {editLink(pool)}
            </div>
          </li>
        ))}
      </ul>

      <div className="hidden md:block">
        <DataTable
          label="Sending pools"
          columns={columns}
          rows={rows}
          rowKey={(pool) => pool.id}
          footer={<Guardrail>{SHARED_QUOTA_NOTE}</Guardrail>}
        />
      </div>
    </>
  );
}
