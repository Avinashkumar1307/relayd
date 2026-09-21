import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BulkBar,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Modal,
  RadioCard,
  RadioGroup,
  TableSkeleton,
} from '@relayd/ui';
import type { Column } from '@relayd/ui';
import { audienceApi } from '../../api/audience.js';
import { audienceExtraApi, audienceExtraKeys, formatCount, formatDay } from '../../api/audience-extra.js';
import type { TagRow } from '../../api/audience-extra.js';
import { IfPermitted } from '../../auth/guards.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import { Dot, LinkButton } from './parts.js';
import { requestId, sentence } from './contacts.js';

/**
 * Tags (D4, D4e, D4f).
 *
 * A tag is the cheapest thing in the product to create — one click on the
 * contacts table makes one — so a workspace accumulates near-duplicates
 * ("Dubai" and "dubai-leisure", which is exactly what D4 draws). Merge is
 * therefore the page's main verb, and it is a bulk action on a selection
 * rather than a field on a form: you pick the two you meant to be one, then
 * choose which name survives.
 *
 * The merge preview is server-side. The overlap between two tags — the 634
 * contacts D4 says had both — is a count over the join table, and a page
 * that guessed it by subtracting would be wrong by exactly the number that
 * matters.
 */

const EMPTY_DESCRIPTION = 'Free-form labels on contacts.';

export function TagsPage() {
  const queryClient = useQueryClient();
  const { currentWorkspaceId, can } = useAuth();
  const readOnly = useReadOnly();

  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<TagRow | null>(null);
  const [merging, setMerging] = useState<TagRow[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  const tags = useQuery({
    queryKey: audienceExtraKeys.tags(currentWorkspaceId),
    queryFn: audienceExtraApi.listTags,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: [currentWorkspaceId, 'audience'] });
  };

  const create = useMutation({
    mutationFn: (input: { name: string; color?: string }) => audienceApi.createTag(input),
    onSuccess: () => {
      invalidate();
      setCreating(false);
    },
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => audienceExtraApi.renameTag(id, name),
    onSuccess: () => {
      invalidate();
      setRenaming(null);
    },
  });

  const merge = useMutation({
    mutationFn: (input: { keepId: string; mergeIds: string[] }) => audienceExtraApi.mergeTags(input),
    onSuccess: () => {
      invalidate();
      setMerging(null);
      setSelected([]);
    },
  });

  const remove = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await audienceApi.deleteTag(id);
    },
    onSuccess: () => {
      invalidate();
      setDeleting(false);
      setSelected([]);
    },
  });

  const rows = tags.data ?? [];
  const canWrite = can('contact:write') && !readOnly;
  const writeTitle = readOnly ? 'Workspace is read-only' : undefined;
  const picked = rows.filter((tag) => selected.includes(tag.id));

  const newTagButton = (
    <IfPermitted permission="contact:write">
      <Button onClick={() => setCreating(true)} disabled={readOnly} title={writeTitle}>
        <Icon name="plus" size={15} />
        New tag
      </Button>
    </IfPermitted>
  );

  /* ----------------------------------------------------------- states -- */

  if (tags.isError) {
    return (
      <>
        <Header description={EMPTY_DESCRIPTION} actions={newTagButton} />
        <ErrorState
          title="We couldn't load tags"
          description={`${sentence(tags.error)} Tags on contacts are intact. Send support the request ID if it keeps happening.`}
          {...requestId(tags.error)}
          actions={<Button variant="secondary">Contact support</Button>}
          onRetry={() => void tags.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  if (tags.isPending) {
    return (
      <>
        <Header description={EMPTY_DESCRIPTION} actions={newTagButton} />
        <div className="max-w-250">
          <TableSkeleton rows={9} tabs={false} label="Loading tags" />
        </div>
      </>
    );
  }

  if (rows.length === 0) {
    return (
      <>
        <Header description={EMPTY_DESCRIPTION} actions={newTagButton} />
        <EmptyState
          icon="tags"
          title="No tags yet"
          description="Tags are created when you add them to a contact, in bulk from the contacts table, or during an import."
          action={<LinkButton to="/audience/contacts">Go to contacts</LinkButton>}
        />
        <CreateTagDialog
          open={creating}
          onClose={() => setCreating(false)}
          pending={create.isPending}
          onSubmit={(input) => create.mutate(input)}
        />
      </>
    );
  }

  /* ------------------------------------------------------------ table -- */

  const columns: readonly Column<TagRow>[] = [
    {
      key: 'name',
      header: 'Tag',
      cell: (tag) => (
        <span className="flex min-w-0 items-center gap-2">
          <Dot color={tag.color} size={10} />
          <span className="truncate font-medium">{tag.name}</span>
        </span>
      ),
    },
    {
      key: 'contacts',
      header: 'Contacts',
      align: 'right',
      width: '140px',
      cell: (tag) => formatCount(tag.contactCount),
    },
    {
      key: 'segments',
      header: 'Used by segments',
      cell: (tag) => (
        <span className="block truncate text-text-2">
          {tag.segments.length === 0 ? '—' : tag.segments.join(', ')}
        </span>
      ),
    },
    { key: 'created', header: 'Created', width: '150px', cell: (tag) => <span className="text-text-2">{formatDay(tag.createdAt)}</span> },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      width: '150px',
      cell: (tag) => (
        <span className="flex justify-end gap-1.5">
          <RowButton
            label="Rename"
            name={tag.name}
            disabled={!canWrite}
            title={writeTitle}
            onClick={() => setRenaming(tag)}
          />
          <RowButton
            label="Merge…"
            name={tag.name}
            disabled={!canWrite}
            title={writeTitle}
            onClick={() => setMerging([tag, ...rows.filter((other) => other.id !== tag.id).slice(0, 1)])}
          />
        </span>
      ),
    },
  ];

  return (
    <>
      <Header
        description={`Free-form labels on contacts. Merge duplicates to keep segments clean. ${rows.length} tags`}
        actions={newTagButton}
      />

      {/* Phone: the same rows as a stack, with the actions under each. */}
      <ul className="m-0 flex list-none flex-col gap-3 p-0 md:hidden">
        {rows.map((tag) => (
          <li key={tag.id} className="rounded-card border border-border bg-surface p-3.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <Dot color={tag.color} size={10} />
                <span className="truncate font-medium">{tag.name}</span>
              </span>
              <span className="flex-none tabular-nums">{formatCount(tag.contactCount)}</span>
            </div>
            <div className="mt-1 text-caption text-text-2">
              {tag.segments.length === 0 ? 'Not used by a segment' : tag.segments.join(', ')}
            </div>
            <div className="mt-2.5 flex gap-1.5">
              <RowButton
                label="Rename"
                name={tag.name}
                disabled={!canWrite}
                title={writeTitle}
                onClick={() => setRenaming(tag)}
              />
              <RowButton
                label="Merge…"
                name={tag.name}
                disabled={!canWrite}
                title={writeTitle}
                onClick={() => setMerging([tag, ...rows.filter((other) => other.id !== tag.id).slice(0, 1)])}
              />
            </div>
          </li>
        ))}
      </ul>

      <div className="hidden max-w-250 md:block">
        <DataTable
          label="Tags"
          columns={columns}
          rows={rows}
          rowKey={(tag) => tag.id}
          selectedKeys={selected}
          onSelectionChange={setSelected}
          selectionLabel={(tag) => `Select ${tag.name}`}
          bulkBar={
            selected.length === 0 ? undefined : (
              <BulkBar
                count={selected.length}
                onClear={() => setSelected([])}
                actions={[
                  {
                    key: 'merge',
                    label: 'Merge tags',
                    onClick: () => setMerging(picked),
                    disabled: !canWrite || selected.length < 2,
                    title: !canWrite
                      ? writeTitle
                      : selected.length < 2
                        ? 'Pick two or more tags to merge'
                        : undefined,
                  },
                  {
                    key: 'delete',
                    label: 'Delete',
                    danger: true,
                    onClick: () => setDeleting(true),
                    disabled: !canWrite,
                    title: writeTitle,
                  },
                ]}
              />
            )
          }
        />
      </div>

      <CreateTagDialog
        open={creating}
        onClose={() => setCreating(false)}
        pending={create.isPending}
        onSubmit={(input) => create.mutate(input)}
      />

      <RenameTagDialog
        tag={renaming}
        pending={rename.isPending}
        onClose={() => setRenaming(null)}
        onSubmit={(name) => {
          if (renaming !== null) rename.mutate({ id: renaming.id, name });
        }}
      />

      <MergeDialog
        tags={merging}
        pending={merge.isPending}
        onClose={() => setMerging(null)}
        onConfirm={(keepId, mergeIds) => merge.mutate({ keepId, mergeIds })}
      />

      <Modal
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete ${selected.length} ${selected.length === 1 ? 'tag' : 'tags'}?`}
        description="The tag is removed from every contact that carries it. Segments that reference it keep working but stop matching on it."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button variant="danger" pending={remove.isPending} onClick={() => remove.mutate(selected)}>
              Delete
            </Button>
          </>
        }
      >
        <p className="m-0 text-ui text-text-2">{picked.map((tag) => tag.name).join(', ')}</p>
      </Modal>
    </>
  );
}

/* -------------------------------------------------------------- header -- */

function Header({ description, actions }: { description: string; actions: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="m-0 text-title font-semibold leading-heading tracking-heading">Tags</h1>
        <p className="mt-1 mb-0 text-body text-text-2">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

/* -------------------------------------------------------------- pieces -- */

/** D4's 28px row button. The accessible name carries the tag it acts on. */
function RowButton({
  label,
  name,
  disabled,
  title,
  onClick,
}: {
  label: string;
  name: string;
  disabled: boolean;
  title?: string | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={`${label.replace('…', '')} ${name}`}
      className={[
        'inline-flex h-7 items-center rounded-badge border border-border bg-surface px-2 text-caption font-medium',
        disabled ? 'cursor-not-allowed text-text-3' : 'cursor-pointer text-text hover:bg-tint',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

/* ------------------------------------------------------------- dialogs -- */

function CreateTagDialog({
  open,
  onClose,
  pending,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  pending: boolean;
  onSubmit: (input: { name: string; color?: string }) => void;
}) {
  const [name, setName] = useState('');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New tag"
      description="A label you can filter contacts by and build a segment from."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button pending={pending} disabled={name === ''} onClick={() => onSubmit({ name })}>
            Create tag
          </Button>
        </>
      }
    >
      <Field label="Name" value={name} onChange={(event) => setName(event.target.value)} />
    </Modal>
  );
}

function RenameTagDialog({
  tag,
  pending,
  onClose,
  onSubmit,
}: {
  tag: TagRow | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState('');

  return (
    <Modal
      open={tag !== null}
      onClose={onClose}
      title="Rename tag"
      description="Every contact and segment that uses this tag follows the new name."
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
        key={tag?.id ?? 'none'}
        label="Name"
        defaultValue={tag?.name ?? ''}
        onChange={(event) => setName(event.target.value)}
      />
    </Modal>
  );
}

/**
 * D4's merge dialog.
 *
 * "Keep" is a radio rather than a "merge A into B" pair of selects because
 * the question is only ever which one name survives: every other tag in the
 * selection is deleted and its contacts inherit the winner.
 */
function MergeDialog({
  tags,
  pending,
  onClose,
  onConfirm,
}: {
  tags: TagRow[] | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: (keepId: string, mergeIds: string[]) => void;
}) {
  const { currentWorkspaceId } = useAuth();
  const [keepId, setKeepId] = useState<string | null>(null);

  const list = tags ?? [];
  const ids = list.map((tag) => tag.id);
  const keep = list.find((tag) => tag.id === (keepId ?? list[0]?.id));

  const preview = useQuery({
    queryKey: audienceExtraKeys.mergePreview(currentWorkspaceId, ids),
    queryFn: () => audienceExtraApi.mergePreview(ids),
    enabled: list.length > 1,
  });

  const dropped = list.filter((tag) => tag.id !== keep?.id);

  return (
    <Modal
      open={tags !== null}
      onClose={onClose}
      title={`Merge ${list.length} tags`}
      description="Contacts keep one tag; segments that reference the merged tags are updated. This runs in the background and is logged."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            pending={pending}
            disabled={keep === undefined || dropped.length === 0}
            onClick={() => {
              if (keep !== undefined) onConfirm(keep.id, dropped.map((tag) => tag.id));
            }}
          >
            Merge into “{keep?.name ?? ''}”
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <RadioGroup label="Keep" value={keep?.id ?? ''} onChange={setKeepId}>
          {list.map((tag) => (
            <RadioCard
              key={tag.id}
              value={tag.id}
              density="compact"
              label={
                <span className="flex items-center gap-2.5">
                  <Dot color={tag.color} size={8} />
                  {tag.name}
                </span>
              }
              aside={
                <span className="ml-auto whitespace-nowrap font-normal text-text-2">
                  {formatCount(tag.contactCount)} contacts · {tag.segments.length} segments
                </span>
              }
            />
          ))}
        </RadioGroup>

        <p className="m-0 rounded-control bg-tint px-3 py-2.5 text-caption text-text-2">
          Result: <span className="font-medium text-text">{keep?.name ?? '—'}</span> on{' '}
          {formatCount(preview.data?.total)} contacts ({formatCount(preview.data?.overlap)} had both).{' '}
          <span className="font-medium text-text">{dropped.map((tag) => tag.name).join(', ')}</span>{' '}
          {dropped.length === 1 ? 'is' : 'are'} deleted.
        </p>
      </div>
    </Modal>
  );
}
