import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Modal,
  TONES,
  TableSkeleton,
  SearchInput,
} from '@relayd/ui';
import type { Column } from '@relayd/ui';
import { audienceApi } from '../../api/audience.js';
import {
  REMOVABLE_REASONS,
  SUPPRESSION_REASONS,
  audienceExtraApi,
  audienceExtraKeys,
  formatCount,
  formatDay,
} from '../../api/audience-extra.js';
import type { SuppressionReason, SuppressionRow } from '../../api/audience-extra.js';
import { IfPermitted } from '../../auth/guards.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import { FilterChip, Pager } from './parts.js';
import { requestId, sentence } from './contacts.js';

/**
 * Suppressions (D7, D7e, D7f).
 *
 * The page is a table and two explanatory cards, and the cards are not
 * decoration: suppression is the one list in the product a user is tempted
 * to edit their way out of, so the rules — what gets added automatically,
 * what an import cannot undo, which entries an Admin may lift — are on the
 * screen beside the rows rather than in a help article.
 *
 * Only a manual or an invalid entry offers Remove. A hard bounce is evidence
 * from a mailbox provider and a complaint is a legal record; deleting either
 * to send again is how a workspace loses its sending reputation, and ours
 * with it.
 */

const EMPTY_DESCRIPTION =
  'Addresses that are never sent to, even when they appear in a list or segment.';

const REASON_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  ...(Object.keys(SUPPRESSION_REASONS) as SuppressionReason[]).map((reason) => ({
    value: reason,
    label: SUPPRESSION_REASONS[reason].label,
  })),
];

export function SuppressionsPage() {
  const queryClient = useQueryClient();
  const { currentWorkspaceId, can } = useAuth();
  const readOnly = useReadOnly();

  const [reason, setReason] = useState('all');
  const [source, setSource] = useState('any');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SuppressionRow | null>(null);

  const filters = { reason, source, q: query };

  const suppressions = useQuery({
    queryKey: audienceExtraKeys.suppressions(currentWorkspaceId, filters),
    // BACKEND PENDING: GET /suppressions has no `addedBy` field (it needs a
    // `suppressions.created_by` column). Every other column is real.
    queryFn: () => audienceExtraApi.listSuppressions(filters),
  });

  const summary = useQuery({
    queryKey: audienceExtraKeys.suppressionSummary(currentWorkspaceId),
    queryFn: audienceExtraApi.suppressionSummary,
  });

  const sources = useQuery({
    queryKey: audienceExtraKeys.suppressionSources(currentWorkspaceId),
    queryFn: audienceExtraApi.suppressionSources,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: [currentWorkspaceId, 'audience'] });
  };

  const add = useMutation({
    mutationFn: (input: { email: string; notes?: string }) =>
      audienceApi.createSuppression({ ...input, reason: 'manual' }),
    onSuccess: () => {
      invalidate();
      setAdding(false);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => audienceApi.deleteSuppression(id),
    onSuccess: () => {
      invalidate();
      setRemoving(null);
    },
  });

  const startExport = useMutation({
    mutationFn: () => audienceExtraApi.startExport({ resource: 'suppressions' }),
  });

  const rows = suppressions.data ?? [];
  const canWrite = can('contact:write') && !readOnly;
  const writeTitle = readOnly ? 'Workspace is read-only' : undefined;
  const total = summary.data?.total ?? rows.length;

  const addButton = (
    <IfPermitted permission="contact:write">
      <Button onClick={() => setAdding(true)} disabled={readOnly} title={writeTitle}>
        <Icon name="plus" size={15} />
        Add manually
      </Button>
    </IfPermitted>
  );

  const importButton = (
    <IfPermitted permission="contact:write">
      <Button variant="secondary" disabled={!canWrite} title={writeTitle}>
        Import suppression list
      </Button>
    </IfPermitted>
  );

  /* ----------------------------------------------------------- states -- */

  if (suppressions.isError) {
    return (
      <>
        <Header description={EMPTY_DESCRIPTION} actions={addButton} />
        <ErrorState
          title="We couldn't load suppressions"
          description={`${sentence(suppressions.error)} Suppression is still enforced at send time; only this page failed to load. Send support the request ID if it keeps happening.`}
          {...requestId(suppressions.error)}
          actions={<Button variant="secondary">Contact support</Button>}
          onRetry={() => void suppressions.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  if (suppressions.isPending) {
    return (
      <>
        <Header description={EMPTY_DESCRIPTION} actions={addButton} />
        <TableSkeleton rows={8} tabs={false} label="Loading suppressions" />
      </>
    );
  }

  if (rows.length === 0 && reason === 'all' && source === 'any' && query === '') {
    return (
      <>
        <Header description={EMPTY_DESCRIPTION} actions={addButton} />
        <EmptyState
          icon="suppressions"
          title="No suppressions yet"
          description="Unsubscribes, hard bounces and complaints will be added here automatically from provider events. You can also add addresses manually or import a list."
          action={importButton}
        />
        <AddDialog
          open={adding}
          onClose={() => setAdding(false)}
          pending={add.isPending}
          onSubmit={(input) => add.mutate(input)}
        />
      </>
    );
  }

  /* ------------------------------------------------------------ table -- */

  const columns: readonly Column<SuppressionRow>[] = [
    {
      key: 'email',
      header: 'Email',
      cell: (row) => <span className="block truncate font-medium">{row.email}</span>,
    },
    {
      key: 'reason',
      header: 'Reason',
      width: '140px',
      cell: (row) => (
        <Badge tone={SUPPRESSION_REASONS[row.reason].tone}>{SUPPRESSION_REASONS[row.reason].label}</Badge>
      ),
    },
    {
      key: 'source',
      header: 'Source',
      cell: (row) => <span className="block truncate text-text-2">{row.source ?? '—'}</span>,
    },
    {
      key: 'date',
      header: 'Date',
      width: '120px',
      cell: (row) => <span className="whitespace-nowrap text-text-2">{formatDay(row.createdAt)}</span>,
    },
    {
      key: 'addedBy',
      header: 'Added by',
      width: '140px',
      cell: (row) => (
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-text-2">{row.addedBy ?? '—'}</span>
          {REMOVABLE_REASONS.includes(row.reason) ? (
            <IfPermitted permission="contact:write">
              <button
                type="button"
                onClick={() => setRemoving(row)}
                disabled={!canWrite}
                title={writeTitle}
                aria-label={`Remove ${row.email}`}
                className={[
                  'inline-flex h-7 flex-none items-center rounded-badge border border-border bg-surface px-2 text-caption font-medium',
                  canWrite ? 'cursor-pointer text-danger-text hover:bg-tint' : 'cursor-not-allowed text-text-3',
                ].join(' ')}
              >
                Remove
              </button>
            </IfPermitted>
          ) : null}
        </span>
      ),
    },
  ];

  const filterBar = (
    <>
      <FilterChip label="Reason" value={reason} options={REASON_OPTIONS} onChange={setReason} />
      <FilterChip label="Source" value={source} options={sources.data ?? DEFAULT_SOURCE_OPTIONS} onChange={setSource} />
      <span className="flex-1" />
      <SearchInput
        label="Search email"
        placeholder="Search email"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onClear={() => setQuery('')}
        className="w-60 max-w-full"
      />
    </>
  );

  return (
    <>
      <Header
        description={`${formatCount(total)} addresses that are never sent to, even when they appear in a list or segment.`}
        actions={
          <>
            <IfPermitted permission="contact:export">
              <Button variant="secondary" onClick={() => startExport.mutate()} pending={startExport.isPending}>
                Export
              </Button>
            </IfPermitted>
            {importButton}
            {addButton}
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Phone: the same rows as a stack. Five columns do not fit at 390px,
            and the reason is the one thing that must never be cut off. The
            filters come with them — a list you cannot narrow is a list you
            have to scroll 2,318 rows of. */}
        <div className="flex flex-wrap items-center gap-2 text-caption md:hidden">{filterBar}</div>

        <ul className="m-0 flex list-none flex-col gap-3 p-0 md:hidden">
          {rows.map((row) => (
            <li key={row.id} className="rounded-card border border-border bg-surface p-3.5">
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 flex-1 font-medium text-wrap">{row.email}</span>
                <span className="flex-none">
                  <Badge tone={SUPPRESSION_REASONS[row.reason].tone}>
                    {SUPPRESSION_REASONS[row.reason].label}
                  </Badge>
                </span>
              </div>
              <div className="mt-2 text-caption text-text-2">
                {row.source ?? 'No campaign'} · {formatDay(row.createdAt)} · {row.addedBy ?? '—'}
              </div>
            </li>
          ))}
        </ul>

        <DataTable
          className="hidden md:block"
          label="Suppressions"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          toolbar={filterBar}
          empty={
            <div className="p-6">
              <EmptyState
                size="table"
                icon="suppressions"
                title="No suppressions match these filters"
                description="Clear the reason, the source or the search to see the rest of the list."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setReason('all');
                      setSource('any');
                      setQuery('');
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            </div>
          }
          footer={
            <>
              <span>
                1–{rows.length} of <span className="font-medium text-text">{formatCount(total)}</span>
              </span>
              <Pager canGoBack={false} canGoForward={false} onPrevious={() => undefined} onNext={() => undefined} />
            </>
          }
        />

        <div className="flex flex-col gap-4">
          <Card>
            <h2 className="m-0 mb-2.5 text-body font-semibold">By reason</h2>
            <div className="flex flex-col gap-2 text-ui">
              {(summary.data?.byReason ?? []).map((entry) => (
                <div key={entry.reason} className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 flex-none rounded-full"
                    style={{ background: TONES[SUPPRESSION_REASONS[entry.reason].tone].dot }}
                  />
                  <span className="flex-1 text-text-2">{SUPPRESSION_REASONS[entry.reason].label}</span>
                  <span className="font-medium tabular-nums">{formatCount(entry.count)}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <h2 className="m-0 mb-2 text-body font-semibold">How suppression works</h2>
            <ul className="m-0 flex list-disc flex-col gap-1.5 pl-4.5 text-ui text-pretty text-text-2">
              <li>
                Suppressed contacts are removed from every send at launch, and the count is shown in the
                campaign&apos;s pre-flight.
              </li>
              <li>Unsubscribes, hard bounces and complaints are added automatically from provider events.</li>
              <li>Imports never reactivate a suppressed address.</li>
              <li>
                Manual and imported suppressions can be removed by an Admin; complaint and unsubscribe
                suppressions cannot.
              </li>
            </ul>
          </Card>
        </div>
      </div>

      <AddDialog
        open={adding}
        onClose={() => setAdding(false)}
        pending={add.isPending}
        onSubmit={(input) => add.mutate(input)}
      />

      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove this suppression?"
        description="The address becomes sendable again from the next campaign launch. The removal is written to the audit log."
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              pending={remove.isPending}
              onClick={() => {
                if (removing !== null) remove.mutate(removing.id);
              }}
            >
              Remove
            </Button>
          </>
        }
      >
        <p className="m-0 text-ui text-text-2">
          {removing?.email} · {removing === null ? '' : SUPPRESSION_REASONS[removing.reason].label} ·{' '}
          {formatDay(removing?.createdAt ?? null)}
        </p>
      </Modal>
    </>
  );
}

/**
 * What the Source chip falls back to before its query lands.
 *
 * The real options come from `GET /suppressions/sources`, which lists the
 * campaigns that have actually produced a suppression — a different query
 * from "campaigns", and the only one that cannot offer a filter matching
 * nothing. "Any campaign" is the option that always applies.
 */
const DEFAULT_SOURCE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'any', label: 'Any campaign' },
];

/* -------------------------------------------------------------- header -- */

function Header({ description, actions }: { description: string; actions: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="m-0 text-title font-semibold leading-heading tracking-heading">Suppressions</h1>
        <p className="mt-1 mb-0 text-body text-text-2">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

/* ------------------------------------------------------------- dialogs -- */

function AddDialog({
  open,
  onClose,
  pending,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  pending: boolean;
  onSubmit: (input: { email: string; notes?: string }) => void;
}) {
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add manually"
      description="The address is never sent to again, whatever a list, a segment or an import says."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            pending={pending}
            disabled={email === ''}
            onClick={() => onSubmit({ email, ...(notes === '' ? {} : { notes }) })}
          >
            Suppress
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Email address"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Field
          label="Note"
          labelAside={<span className="text-text-3">· optional</span>}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
    </Modal>
  );
}
