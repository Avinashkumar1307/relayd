import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Menu,
  Modal,
  Skeleton,
} from '@relayd/ui';
import type { Column } from '@relayd/ui';
import { audienceApi } from '../../api/audience.js';
import {
  audienceExtraApi,
  audienceExtraKeys,
  formatCount,
  formatDay,
} from '../../api/audience-extra.js';
import type { ListCard } from '../../api/audience-extra.js';
import { IfPermitted } from '../../auth/guards.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import { LinkButton, SegmentedToggle, Sparkline } from './parts.js';
import { requestId, sentence } from './contacts.js';

/**
 * Lists (D3, D3e, D3f).
 *
 * D3 draws cards, with a Cards/Table toggle in the header. Cards is the
 * default because a list is read for its size and its direction of travel —
 * the count, the 30-day move and the sparkline — and a row of six numbers
 * does not say that as quickly. The table is there for a workspace with
 * forty of them.
 *
 * An archived list stays visible at 65% opacity, as the frame draws it: a
 * list a campaign was sent to is part of that campaign's record, so hiding
 * it would hide the answer to "who received this".
 */

const EMPTY_DESCRIPTION = 'Static groups you add contacts to.';

export function ListsPage() {
  const queryClient = useQueryClient();
  const { currentWorkspaceId, can } = useAuth();
  const readOnly = useReadOnly();

  const [layout, setLayout] = useState<'cards' | 'table'>('cards');
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<ListCard | null>(null);
  const [archiving, setArchiving] = useState<ListCard | null>(null);

  const lists = useQuery({
    queryKey: audienceExtraKeys.lists(currentWorkspaceId),
    // BACKEND PENDING: GET /audience/lists (archived, footnote, growth30d, trend)
    queryFn: audienceExtraApi.listCards,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: audienceExtraKeys.lists(currentWorkspaceId) });
  };

  const create = useMutation({
    mutationFn: (input: { name: string; description?: string }) => audienceApi.createList(input),
    onSuccess: () => {
      invalidate();
      setCreating(false);
    },
  });

  const rename = useMutation({
    // BACKEND PENDING: PATCH /audience/lists/:id
    mutationFn: ({ id, name }: { id: string; name: string }) => audienceExtraApi.renameList(id, name),
    onSuccess: () => {
      invalidate();
      setRenaming(null);
    },
  });

  const archive = useMutation({
    // BACKEND PENDING: POST /audience/lists/:id/archive
    mutationFn: (id: string) => audienceExtraApi.archiveList(id),
    onSuccess: () => {
      invalidate();
      setArchiving(null);
    },
  });

  // BACKEND PENDING: POST /audience/exports
  const exportList = useMutation({
    mutationFn: (id: string) => audienceExtraApi.startExport({ resource: 'list', ids: [id] }),
  });

  const rows = lists.data ?? [];
  const archived = rows.filter((list) => list.archived).length;
  const canWrite = can('contact:write') && !readOnly;
  const writeTitle = readOnly ? 'Workspace is read-only' : undefined;

  const createButton = (
    <IfPermitted permission="contact:write">
      <Button onClick={() => setCreating(true)} disabled={readOnly} title={writeTitle}>
        <Icon name="plus" size={15} />
        Create list
      </Button>
    </IfPermitted>
  );

  if (lists.isError) {
    return (
      <>
        <Header description={EMPTY_DESCRIPTION} actions={createButton} />
        <ErrorState
          title="We couldn't load lists"
          description={`${sentence(lists.error)} Campaigns that use these lists are unaffected. Send support the request ID if it keeps happening.`}
          {...requestId(lists.error)}
          actions={<Button variant="secondary">Contact support</Button>}
          onRetry={() => void lists.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  if (lists.isPending) {
    return (
      <>
        <Header description={EMPTY_DESCRIPTION} actions={createButton} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-label="Loading lists">
          {[0, 1, 2, 3, 4, 5].map((key) => (
            <Card key={key}>
              <Skeleton width="55%" height={14} />
              <div className="mt-2">
                <Skeleton width="80%" height={12} />
              </div>
              <div className="mt-3.5">
                <Skeleton width={110} height={26} radius={6} />
              </div>
              <div className="mt-3 border-t border-border pt-2.5">
                <Skeleton width="70%" height={12} />
              </div>
            </Card>
          ))}
        </div>
      </>
    );
  }

  if (rows.length === 0) {
    return (
      <>
        <Header description={EMPTY_DESCRIPTION} actions={createButton} />
        <EmptyState
          icon="lists"
          title="No lists yet"
          description="Create a list to group contacts explicitly, or import a file and add everyone in it to a new list in one step."
          action={
            <Button onClick={() => setCreating(true)} disabled={!canWrite} title={writeTitle}>
              Create list
            </Button>
          }
        />
        <CreateListDialog
          open={creating}
          onClose={() => setCreating(false)}
          pending={create.isPending}
          onSubmit={(input) => create.mutate(input)}
        />
      </>
    );
  }

  const menuFor = (list: ListCard) => [
    {
      key: 'rename',
      label: 'Rename',
      onSelect: () => setRenaming(list),
      disabled: !canWrite || list.archived,
      reason: list.archived ? 'Archived · read-only' : writeTitle,
    },
    {
      key: 'add',
      label: 'Add contacts',
      onSelect: () => undefined,
      disabled: !canWrite || list.archived,
      reason: list.archived ? 'Archived · read-only' : writeTitle,
    },
    { key: 'export', label: 'Export CSV', onSelect: () => exportList.mutate(list.id) },
    {
      key: 'archive',
      label: 'Archive',
      tone: 'muted' as const,
      separatorBefore: true,
      onSelect: () => setArchiving(list),
      disabled: !canWrite || list.archived,
      reason: list.archived ? 'Already archived' : writeTitle,
    },
  ];

  const columns: readonly Column<ListCard>[] = [
    { key: 'name', header: 'List', width: '26%', cell: (list) => <span className="font-medium">{list.name}</span> },
    {
      key: 'description',
      header: 'Description',
      cell: (list) => <span className="block truncate text-text-2">{list.description ?? '—'}</span>,
    },
    {
      key: 'members',
      header: 'Contacts',
      align: 'right',
      width: '120px',
      cell: (list) => formatCount(list.memberCount),
    },
    {
      key: 'growth',
      header: '30d',
      align: 'right',
      width: '90px',
      cell: (list) => <Growth value={list.growth30d} />,
    },
    { key: 'created', header: 'Created', width: '130px', cell: (list) => formatDay(list.createdAt) },
    {
      key: 'footnote',
      header: 'Usage',
      width: '190px',
      cell: (list) => <span className="block truncate text-text-2">{list.footnote}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '60px',
      cell: (list) => <Menu items={menuFor(list)} label={`Actions for ${list.name}`} width={180} />,
    },
  ];

  return (
    <>
      <Header
        description={`Static groups you add contacts to. Segments are rule-based; lists are explicit. ${rows.length} lists · ${archived} archived`}
        actions={
          <>
            <SegmentedToggle
              label="Layout"
              value={layout}
              options={[
                { value: 'cards', label: 'Cards' },
                { value: 'table', label: 'Table' },
              ]}
              onChange={setLayout}
              className="hidden md:inline-flex"
            />
            {createButton}
          </>
        }
      />

      {/* The table layout is a desktop choice: seven columns do not fit at
          390px, so a phone always gets the cards whichever half is lit. */}
      <div
        className={`grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 ${layout === 'table' ? 'md:hidden' : ''}`}
      >
        {rows.map((list) => (
          <ListTile key={list.id} list={list} menu={menuFor(list)} />
        ))}
      </div>

      {layout === 'table' ? (
        <DataTable
          className="hidden md:block"
          label="Lists"
          columns={columns}
          rows={rows}
          rowKey={(list) => list.id}
          rowMuted={(list) => list.archived}
        />
      ) : null}

      <CreateListDialog
        open={creating}
        onClose={() => setCreating(false)}
        pending={create.isPending}
        onSubmit={(input) => create.mutate(input)}
      />

      <RenameDialog
        open={renaming !== null}
        title="Rename list"
        current={renaming?.name ?? ''}
        pending={rename.isPending}
        onClose={() => setRenaming(null)}
        onSubmit={(name) => {
          if (renaming !== null) rename.mutate({ id: renaming.id, name });
        }}
      />

      <Modal
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        title="Archive this list?"
        description="An archived list is read-only. Campaigns already sent to it keep their record, and it stops appearing when a new campaign chooses an audience."
        footer={
          <>
            <Button variant="secondary" onClick={() => setArchiving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              pending={archive.isPending}
              onClick={() => {
                if (archiving !== null) archive.mutate(archiving.id);
              }}
            >
              Archive
            </Button>
          </>
        }
      >
        <p className="m-0 text-ui text-text-2">
          {archiving?.name} · {formatCount(archiving?.memberCount)} contacts.
        </p>
      </Modal>
    </>
  );
}

/* --------------------------------------------------------------- card -- */

function ListTile({ list, menu }: { list: ListCard; menu: Parameters<typeof Menu>[0]['items'] }) {
  return (
    <div
      className={`relative rounded-card border border-border bg-surface px-4.5 py-4 ${list.archived ? 'opacity-65' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-semibold">{list.name}</div>
          <div className="truncate text-caption text-text-2">
            {list.archived ? 'Archived · read-only' : (list.description ?? '—')}
          </div>
        </div>
        <Menu items={menu} label={`Actions for ${list.name}`} width={180} />
      </div>

      <div className="mt-3.5 flex items-end justify-between gap-3">
        <div>
          <div className="text-title font-semibold leading-heading tracking-heading tabular-nums">
            {formatCount(list.memberCount)}
          </div>
          <div className="text-caption text-text-2">
            contacts · <Growth value={list.growth30d} /> 30d
          </div>
        </div>
        <Sparkline points={list.trend} label={`${list.name} trend, 30 days`} />
      </div>

      <div className="mt-3 flex justify-between border-t border-border pt-2.5 text-caption text-text-2">
        <span>Created {formatDay(list.createdAt)}</span>
        <span>{list.footnote}</span>
      </div>
    </div>
  );
}

/** "+4.2%" in success, "−0.4%" in danger, "0%" plain — D3's three cases. */
function Growth({ value }: { value: number | null }) {
  if (value === null) return <span>—</span>;
  if (value === 0) return <span>0%</span>;

  const sign = value > 0 ? '+' : '−';
  return (
    <span className={`font-medium ${value > 0 ? 'text-success-text' : 'text-danger-text'}`}>
      {sign}
      {Math.abs(value)}%
    </span>
  );
}

/* ------------------------------------------------------------ header -- */

function Header({ description, actions }: { description: string; actions: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="m-0 text-title font-semibold leading-heading tracking-heading">Lists</h1>
        <p className="mt-1 mb-0 text-body text-text-2">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

/* ----------------------------------------------------------- dialogs -- */

function CreateListDialog({
  open,
  onClose,
  pending,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  pending: boolean;
  onSubmit: (input: { name: string; description?: string }) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create list"
      description="A list is explicit: you add contacts to it. A segment picks them by rule."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            pending={pending}
            disabled={name === ''}
            onClick={() => onSubmit({ name, ...(description === '' ? {} : { description }) })}
          >
            Create list
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" value={name} onChange={(event) => setName(event.target.value)} />
        <Field
          label="Description"
          labelAside={<span className="text-text-3">· optional</span>}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
    </Modal>
  );
}

export function RenameDialog({
  open,
  title,
  current,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  current: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(current);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button pending={pending} disabled={name === ''} onClick={() => onSubmit(name)}>
            Rename
          </Button>
        </>
      }
    >
      <Field
        label="Name"
        defaultValue={current}
        key={current}
        onChange={(event) => setName(event.target.value)}
      />
    </Modal>
  );
}

export { LinkButton };
