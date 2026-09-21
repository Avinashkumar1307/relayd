import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  BulkBar,
  Button,
  CONTACT_STATES,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Modal,
  RECIPIENT_STATES,
  Select,
  StateBadge,
  TONES,
  TableSkeleton,
  Tabs,
  stateStyle,
} from '@relayd/ui';
import type { Column } from '@relayd/ui';
import { ApiError } from '../../api/client.js';
import { audienceApi } from '../../api/audience.js';
import {
  audienceExtraApi,
  audienceExtraKeys,
  contactName,
  formatCount,
  formatDay,
} from '../../api/audience-extra.js';
import type { ContactFilters, ContactRow, SavedView } from '../../api/audience-extra.js';
import { IfPermitted } from '../../auth/guards.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import {
  AddTagChip,
  FieldPair,
  LinkButton,
  ListChip,
  Pager,
  RowsPerPage,
  SectionLabel,
  SuppressionStrip,
  TagChip,
  TagPill,
  TimelineRow,
} from './parts.js';

/**
 * Contacts (D1, D1e, D1f) and the contact drawer (D2a, D2b).
 *
 * D1 is the table-page pattern the rest of the app copies: a title with a
 * counted summary line, saved views as tabs, a bulk-action bar that
 * replaces the toolbar while rows are picked, and a footer that says
 * "1–8 of 48,213 contacts" with the page size beside it.
 *
 * ## Why the drawer is a route
 *
 * `/audience/contacts/:id` renders this same page with the drawer open, so
 * a contact is a link somebody can send, the back button closes the drawer,
 * and the table underneath keeps its filter, its page and its selection.
 * The frames draw exactly that: D2a and D2b are D1 with a panel over it.
 *
 * ## Paging is by cursor
 *
 * A keyset cursor can only move forwards from one it has been handed, so
 * going back means remembering where each page started. An offset would be
 * simpler and would silently skip and repeat rows as contacts are inserted
 * under the reader.
 */

const EMPTY_DESCRIPTION = 'People you can email, with their consent and engagement history.';

/** The tabs D1 draws before any saved view of the workspace's own. */
const BASE_VIEWS: readonly SavedView[] = [
  { key: 'all', label: 'All contacts' },
  { key: 'subscribed', label: 'Subscribed', status: 'subscribed' },
];

export function ContactsPage() {
  const { id: openContactId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currentWorkspaceId, can } = useAuth();
  const readOnly = useReadOnly();

  const [view, setView] = useState('all');
  const [limit, setLimit] = useState(50);
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState<
    'add' | 'tag' | 'untag' | 'list' | 'suppress' | 'save-view' | null
  >(null);

  const cursor = cursors[cursors.length - 1];
  const base = BASE_VIEWS.find((candidate) => candidate.key === view);

  const filters: ContactFilters = {
    limit,
    ...(cursor === undefined ? {} : { cursor }),
    ...(base?.status === undefined ? {} : { status: base.status }),
    ...(base === undefined ? { view } : {}),
  };

  const savedViews = useQuery({
    queryKey: audienceExtraKeys.savedViews(currentWorkspaceId),
    queryFn: audienceExtraApi.savedViews,
  });

  const contacts = useQuery({
    queryKey: audienceExtraKeys.contacts(currentWorkspaceId, filters),
    queryFn: () => audienceExtraApi.listContacts(filters),
  });

  const stats = useQuery({
    queryKey: audienceExtraKeys.stats(currentWorkspaceId, filters),
    queryFn: () => audienceExtraApi.stats(filters),
  });

  const tags = useQuery({
    queryKey: audienceExtraKeys.tags(currentWorkspaceId),
    queryFn: audienceExtraApi.listTags,
  });

  const lists = useQuery({
    queryKey: audienceExtraKeys.lists(currentWorkspaceId),
    queryFn: audienceExtraApi.listCards,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: [currentWorkspaceId, 'audience'] });
  };

  const addContact = useMutation({
    mutationFn: (input: { email: string; firstName?: string; lastName?: string }) =>
      audienceApi.createContact(input),
    onSuccess: () => {
      invalidate();
      setDialog(null);
    },
  });

  const bulkTag = useMutation({
    mutationFn: ({ tagId, remove }: { tagId: string; remove: boolean }) =>
      remove
        ? audienceExtraApi.untagContacts(selected, tagId)
        : audienceExtraApi.tagContacts(selected, tagId),
    onSuccess: () => {
      invalidate();
      setDialog(null);
      setSelected([]);
    },
  });

  const bulkList = useMutation({
    mutationFn: (listId: string) => audienceExtraApi.addToList(listId, selected),
    onSuccess: () => {
      invalidate();
      setDialog(null);
      setSelected([]);
    },
  });

  const bulkSuppress = useMutation({
    mutationFn: async () => {
      const rows = contacts.data?.data ?? [];
      for (const contactId of selected) {
        const row = rows.find((candidate) => candidate.id === contactId);
        if (row !== undefined) {
          await audienceApi.createSuppression({ email: row.email, reason: 'manual' });
        }
      }
    },
    onSuccess: () => {
      invalidate();
      setDialog(null);
      setSelected([]);
    },
  });

  const startExport = useMutation({
    mutationFn: (ids: string[]) =>
      audienceExtraApi.startExport({ resource: 'contacts', ...(ids.length === 0 ? {} : { ids }) }),
  });

  /**
   * "+ Save view" stores the current filter as a tab.
   *
   * It used to post to `/exports` with `resource: 'saved-view'`, which is
   * not one of the five resources that endpoint accepts — every click was
   * a 400 and no view was ever saved.
   */
  const saveView = useMutation({
    mutationFn: (label: string) =>
      audienceExtraApi.createSavedView({
        label,
        filters: {
          ...(filters.status === undefined ? {} : { status: filters.status }),
          ...(filters.q === undefined || filters.q === '' ? {} : { q: filters.q }),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: audienceExtraKeys.savedViews(currentWorkspaceId),
      });
      setDialog(null);
    },
  });

  const changeView = (next: string): void => {
    // A cursor names a position in the old result set and means nothing in
    // the new one, so a view change starts again at the first page.
    setCursors([]);
    setSelected([]);
    setView(next);
  };

  const rows = contacts.data?.data ?? [];
  const nextCursor = contacts.data?.nextCursor;
  const total = stats.data?.matching ?? rows.length;
  const start = cursors.length * limit + 1;
  const end = start + rows.length - 1;

  const writeTitle = readOnly ? 'Workspace is read-only' : undefined;
  const canWrite = can('contact:write') && !readOnly;

  const summary =
    stats.data === undefined
      ? EMPTY_DESCRIPTION
      : `${formatCount(stats.data.contacts)} contacts · ${formatCount(stats.data.subscribed)} subscribed · ${formatCount(stats.data.suppressed)} suppressed and never sent to`;

  /* ----------------------------------------------------------- states -- */

  if (contacts.isError) {
    return (
      <>
        <Header description={EMPTY_DESCRIPTION} actions={<ImportLink />} />
        <ErrorState
          title="We couldn't load contacts"
          description={`${sentence(contacts.error)} Your data is safe and sending is unaffected. Send support the request ID if it keeps happening.`}
          {...requestId(contacts.error)}
          actions={<Button variant="secondary">Contact support</Button>}
          onRetry={() => void contacts.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  if (contacts.isPending) {
    return (
      <>
        <Header description={summary} actions={<ImportLink />} />
        <TableSkeleton rows={8} tabs label="Loading contacts" />
      </>
    );
  }

  if (rows.length === 0 && view === 'all' && (stats.data?.contacts ?? 0) === 0) {
    return (
      <>
        <Header description={EMPTY_DESCRIPTION} actions={<ImportLink />} />
        <EmptyState
          icon="imports"
          title="No contacts yet"
          description="Import a CSV or XLSX to build your audience. You will map columns and confirm consent before anything is saved."
          action={<LinkButton to="/audience/imports">Import contacts</LinkButton>}
        />
      </>
    );
  }

  /* ------------------------------------------------------------ table -- */

  const columns: readonly Column<ContactRow>[] = [
    {
      key: 'email',
      header: 'Email',
      width: '21%',
      cell: (row) => (
        <Link
          to={`/audience/contacts/${row.id}`}
          className="block truncate font-medium text-inherit no-underline"
        >
          {row.email}
        </Link>
      ),
    },
    { key: 'name', header: 'Name', width: '14%', cell: (row) => <span className="block truncate">{contactName(row)}</span> },
    {
      key: 'status',
      header: 'Status',
      width: '132px',
      cell: (row) => <StateBadge states={CONTACT_STATES} state={row.status} />,
    },
    {
      key: 'tags',
      header: 'Tags',
      width: '15%',
      cell: (row) => (
        <span className="flex gap-1 overflow-hidden">
          {row.tags.map((tag) => (
            <TagPill key={tag.id} tag={tag} />
          ))}
        </span>
      ),
    },
    {
      key: 'lists',
      header: 'Lists',
      width: '14%',
      cell: (row) => (
        <span className="block truncate text-text-2">{row.lists.length === 0 ? '—' : row.lists.join(', ')}</span>
      ),
    },
    {
      key: 'lastEngaged',
      header: 'Last engaged',
      width: '124px',
      cell: (row) => <span className="whitespace-nowrap text-text-2">{row.lastEngaged}</span>,
    },
    {
      key: 'createdAt',
      header: 'Created',
      width: '110px',
      sortable: true,
      cell: (row) => <span className="whitespace-nowrap text-text-2">{formatDay(row.createdAt)}</span>,
    },
  ];

  const viewItems = [...BASE_VIEWS, ...(savedViews.data ?? [])].map((item) => ({
    key: item.key,
    label: item.label,
  }));

  return (
    <>
      <Header
        description={summary}
        actions={
          <>
            <IfPermitted permission="contact:export">
              <Button
                variant="secondary"
                onClick={() => startExport.mutate([])}
                pending={startExport.isPending}
              >
                Export
              </Button>
            </IfPermitted>
            <IfPermitted permission="contact:write">
              <Button variant="secondary" onClick={() => setDialog('add')} disabled={readOnly} title={writeTitle}>
                Add contact
              </Button>
            </IfPermitted>
            <ImportLink />
          </>
        }
      />

      {/* Phone: the same rows as a stack. Seven columns cannot be read at
          390px, and a table that scrolls sideways hides the status of every
          row you are not looking at. */}
      <div className="md:hidden">
        <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
          {viewItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => changeView(item.key)}
              className={[
                'inline-flex h-8 flex-none cursor-pointer items-center rounded-full border px-3 text-ui font-medium',
                item.key === view ? 'border-brand bg-brand-soft text-brand' : 'border-border bg-surface text-text-2',
              ].join(' ')}
            >
              {item.label}
            </button>
          ))}
        </div>

        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {rows.map((row) => (
            <li key={row.id} className="rounded-card border border-border bg-surface p-3.5">
              <div className="flex items-start justify-between gap-3">
                <Link
                  to={`/audience/contacts/${row.id}`}
                  className="min-w-0 flex-1 text-body font-medium text-wrap text-text no-underline"
                >
                  {row.email}
                </Link>
                <span className="flex-none">
                  <StateBadge states={CONTACT_STATES} state={row.status} />
                </span>
              </div>
              <div className="mt-1 text-ui text-text-2">{contactName(row)}</div>
              {row.tags.length === 0 ? null : (
                <div className="mt-2 flex flex-wrap gap-1">
                  {row.tags.map((tag) => (
                    <TagPill key={tag.id} tag={tag} />
                  ))}
                </div>
              )}
              <div className="mt-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-caption text-text-2">
                <span className="min-w-0">{row.lists.length === 0 ? 'No lists' : row.lists.join(', ')}</span>
                <span className="min-w-0">Last engaged {row.lastEngaged}</span>
              </div>
            </li>
          ))}
        </ul>

        <p className="mt-3 mb-0 text-caption text-text-2">
          {start}–{end} of <span className="font-medium text-text">{formatCount(total)}</span> contacts
        </p>
      </div>

      <DataTable
          className="hidden md:block"
          label="Contacts"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          selectedKeys={selected}
          onSelectionChange={setSelected}
          selectionLabel={(row) => `Select ${row.email}`}
          rowMuted={(row) => row.status !== 'subscribed'}
          sort={{ key: 'createdAt', direction: 'desc' }}
          onSortChange={() => undefined}
          toolbar={
            // D1 puts "+ Save view" immediately after the last tab rather
            // than at the far end of the strip: it reads as one more view,
            // the one you have not saved yet.
            <div className="-mx-4 -my-3 flex w-[calc(100%+2rem)] flex-wrap items-center overflow-x-auto">
              <Tabs
                variant="card"
                label="Saved views"
                items={viewItems}
                value={view}
                onChange={changeView}
                className="border-b-0 pr-0"
              />
              <IfPermitted permission="contact:write">
                <button
                  type="button"
                  onClick={() => setDialog('save-view')}
                  className="h-11 cursor-pointer whitespace-nowrap border-0 bg-transparent px-2.5 text-ui font-medium text-brand"
                >
                  + Save view
                </button>
              </IfPermitted>
            </div>
          }
          bulkBar={
            selected.length === 0 ? undefined : (
              <BulkBar
                count={selected.length}
                onClear={() => setSelected([])}
                actions={[
                  { key: 'tag', label: 'Add tag', onClick: () => setDialog('tag'), disabled: !canWrite, title: writeTitle },
                  { key: 'untag', label: 'Remove tag', onClick: () => setDialog('untag'), disabled: !canWrite, title: writeTitle },
                  { key: 'list', label: 'Add to list', onClick: () => setDialog('list'), disabled: !canWrite, title: writeTitle },
                  { key: 'export', label: 'Export selected', onClick: () => startExport.mutate(selected) },
                  { key: 'suppress', label: 'Suppress', onClick: () => setDialog('suppress'), danger: true, disabled: !canWrite, title: writeTitle },
                ]}
              />
            )
          }
          empty={
            <div className="p-6">
              <EmptyState
                size="table"
                icon="contacts"
                title="No contacts match this view"
                description="Change the view or clear the filter to see the rest of the audience."
                action={<Button variant="secondary" onClick={() => changeView('all')}>All contacts</Button>}
              />
            </div>
          }
          footer={
            <>
              <span>
                {start}–{end} of <span className="font-medium text-text">{formatCount(total)}</span> contacts
              </span>
              <span className="flex items-center gap-2">
                <RowsPerPage
                  value={limit}
                  onChange={(next) => {
                    setCursors([]);
                    setLimit(next);
                  }}
                />
                <Pager
                  canGoBack={cursors.length > 0}
                  canGoForward={nextCursor !== undefined}
                  onPrevious={() => setCursors((stack) => stack.slice(0, -1))}
                  onNext={() => {
                    if (nextCursor !== undefined) setCursors((stack) => [...stack, nextCursor]);
                  }}
                />
              </span>
            </>
          }
        />

      <AddContactDialog
        open={dialog === 'add'}
        onClose={() => setDialog(null)}
        pending={addContact.isPending}
        error={addContact.error}
        onSubmit={(input) => addContact.mutate(input)}
      />

      <PickDialog
        open={dialog === 'tag' || dialog === 'untag'}
        onClose={() => setDialog(null)}
        title={dialog === 'untag' ? 'Remove tag' : 'Add tag'}
        description={`${selected.length} selected ${selected.length === 1 ? 'contact' : 'contacts'}.`}
        label="Tag"
        confirmLabel={dialog === 'untag' ? 'Remove tag' : 'Add tag'}
        pending={bulkTag.isPending}
        options={(tags.data ?? []).map((tag) => ({ value: tag.id, label: tag.name }))}
        onConfirm={(tagId) => bulkTag.mutate({ tagId, remove: dialog === 'untag' })}
      />

      <PickDialog
        open={dialog === 'list'}
        onClose={() => setDialog(null)}
        title="Add to list"
        description={`${selected.length} selected ${selected.length === 1 ? 'contact' : 'contacts'}.`}
        label="List"
        confirmLabel="Add to list"
        pending={bulkList.isPending}
        options={(lists.data ?? []).filter((list) => !list.archived).map((list) => ({ value: list.id, label: list.name }))}
        onConfirm={(listId) => bulkList.mutate(listId)}
      />

      <SaveViewDialog
        open={dialog === 'save-view'}
        onClose={() => setDialog(null)}
        pending={saveView.isPending}
        error={saveView.error}
        onSubmit={(label) => saveView.mutate(label)}
      />

      <Modal
        open={dialog === 'suppress'}
        onClose={() => setDialog(null)}
        title="Suppress these contacts?"
        description="Suppressed contacts are removed from every send at launch, and the count is shown in the campaign's pre-flight."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => bulkSuppress.mutate()} pending={bulkSuppress.isPending}>
              Suppress
            </Button>
          </>
        }
      >
        <p className="m-0 text-ui text-text-2">
          {selected.length} {selected.length === 1 ? 'address' : 'addresses'} will be added to suppressions with
          reason Manual. An Admin can remove a manual suppression later.
        </p>
      </Modal>

      {openContactId === undefined ? null : (
        <ContactDrawer id={openContactId} onClose={() => void navigate('/audience/contacts')} />
      )}
    </>
  );
}

/* ------------------------------------------------------------- header -- */

function Header({ description, actions }: { description: string; actions: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="m-0 text-title font-semibold leading-heading tracking-heading">Contacts</h1>
        <p className="mt-1 mb-0 text-body text-text-2">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

function ImportLink() {
  return (
    <LinkButton to="/audience/imports">
      <Icon name="imports" size={15} />
      Import
    </LinkButton>
  );
}

/* ------------------------------------------------------------ dialogs -- */

function AddContactDialog({
  open,
  onClose,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  pending: boolean;
  error: unknown;
  onSubmit: (input: { email: string; firstName?: string; lastName?: string }) => void;
}) {
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add contact"
      description="One address, with the consent you already hold for it. Use Import for a file."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSubmit({
                email,
                ...(firstName === '' ? {} : { firstName }),
                ...(lastName === '' ? {} : { lastName }),
              })
            }
            pending={pending}
            disabled={email === ''}
          >
            Add contact
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
          {...(error instanceof ApiError ? { error: error.fieldErrors()['email'] } : {})}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="First name" value={firstName} onChange={(event) => setFirstName(event.target.value)} />
          <Field label="Last name" value={lastName} onChange={(event) => setLastName(event.target.value)} />
        </div>
        {error instanceof ApiError && Object.keys(error.fieldErrors()).length === 0 ? (
          <p className="m-0 text-ui text-danger-text">{error.message}</p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * "+ Save view".
 *
 * The label is asked for rather than derived: the server turns it into the
 * view's key, and two tabs whose keys collide are a 409 the reader can only
 * understand if they chose the words themselves.
 */
function SaveViewDialog({
  open,
  onClose,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  pending: boolean;
  error: unknown;
  onSubmit: (label: string) => void;
}) {
  const [label, setLabel] = useState('');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save this view"
      description="The current filter becomes a tab on this page for everyone in the workspace."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit(label.trim())} pending={pending} disabled={label.trim() === ''}>
            Save view
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Name"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          {...(error instanceof ApiError ? { error: error.fieldErrors()['label'] } : {})}
        />
        {error instanceof ApiError && Object.keys(error.fieldErrors()).length === 0 ? (
          <p className="m-0 text-ui text-danger-text">{error.message}</p>
        ) : null}
      </div>
    </Modal>
  );
}

function PickDialog({
  open,
  onClose,
  title,
  description,
  label,
  confirmLabel,
  options,
  pending,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  label: string;
  confirmLabel: string;
  options: readonly { value: string; label: string }[];
  pending: boolean;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  const chosen = value === '' ? options[0]?.value : value;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (chosen !== undefined) onConfirm(chosen);
            }}
            pending={pending}
            disabled={chosen === undefined}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Select label={label} value={chosen ?? ''} onChange={(event) => setValue(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </Modal>
  );
}

/* ------------------------------------------------------------- drawer -- */

function ContactDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { currentWorkspaceId, can } = useAuth();
  const readOnly = useReadOnly();

  const contact = useQuery({
    queryKey: audienceExtraKeys.contact(currentWorkspaceId, id),
    queryFn: () => audienceExtraApi.getContact(id),
  });

  const row = contact.data;
  const writeTitle = readOnly ? 'Workspace is read-only' : undefined;
  const canWrite = can('contact:write') && !readOnly;

  if (row === undefined) {
    return (
      <Drawer open onClose={onClose} size="md" title={contact.isError ? 'Contact' : 'Loading contact'}>
        {contact.isError ? (
          <ErrorState
            size="table"
            title="We couldn't load this contact"
            description="The rest of the audience is unaffected. Send support the request ID if it keeps happening."
            {...requestId(contact.error)}
            onRetry={() => void contact.refetch()}
            retryLabel="Retry"
          />
        ) : null}
      </Drawer>
    );
  }

  const suppressed = row.suppression.suppressed;

  return (
    <Drawer
      open
      onClose={onClose}
      size="md"
      title={<span className="text-section font-semibold">{contactName(row)}</span>}
      subtitle={row.email}
      headerExtra={
        <>
          <StateBadge states={CONTACT_STATES} state={row.status} />
          {row.tags.map((tag) => (
            <TagChip key={tag.id} tag={tag} />
          ))}
          <AddTagChip onClick={() => undefined} disabled={!canWrite} {...(writeTitle === undefined ? {} : { title: writeTitle })} />
        </>
      }
      footer={
        <>
          {suppressed ? (
            <Button variant="secondary" disabled title="Complaint and unsubscribe suppressions cannot be removed">
              Suppressed · cannot remove
            </Button>
          ) : (
            <button
              type="button"
              disabled={!canWrite}
              title={writeTitle}
              className={[
                'inline-flex h-[34px] items-center rounded-control border border-border bg-surface px-3 text-ui font-medium text-danger-text',
                canWrite ? 'cursor-pointer hover:bg-tint' : 'cursor-not-allowed',
              ].join(' ')}
            >
              Suppress manually
            </button>
          )}
          <span className="flex gap-2">
            <Button variant="secondary">Export</Button>
            <Button variant="secondary" disabled={!canWrite} title={writeTitle}>
              Edit
            </Button>
          </span>
        </>
      }
    >
      <SuppressionStrip
        tone={suppressed ? 'danger' : 'neutral'}
        icon="suppressions"
        headline={row.suppression.headline}
        detail={row.suppression.detail}
      />

      <div className="flex flex-col gap-5">
        <section>
          <SectionLabel>Profile</SectionLabel>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            <FieldPair label="First name" value={row.firstName ?? '—'} />
            <FieldPair label="Last name" value={row.lastName ?? '—'} />
            <FieldPair label="Country" value={row.country ?? '—'} />
            <FieldPair label="Language" value={row.language ?? '—'} />
            <FieldPair label="Consent source" value={row.consentSource ?? '—'} />
            <FieldPair label="Consent recorded" value={row.consentRecorded ?? '—'} />
          </div>
        </section>

        <section>
          <SectionLabel>Custom attributes</SectionLabel>
          <div className="overflow-hidden rounded-control border border-border">
            {Object.entries(row.attributes).length === 0 ? (
              <div className="px-3 py-2 text-text-2">None recorded.</div>
            ) : (
              Object.entries(row.attributes).map(([key, value]) => (
                <div key={key} className="grid grid-cols-2 border-b border-border px-3 py-2 last:border-b-0">
                  <span className="font-mono text-caption text-text-2">{key}</span>
                  <span>{value === null || value === '' ? '—' : String(value)}</span>
                </div>
              ))
            )}
          </div>
        </section>

        <section>
          <SectionLabel>Lists</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {row.lists.length === 0 ? (
              <span className="text-text-2">Not on any list.</span>
            ) : (
              row.lists.map((list) => <ListChip key={list}>{list}</ListChip>)
            )}
          </div>
        </section>

        <section>
          <SectionLabel>Engagement timeline</SectionLabel>
          <div className="flex flex-col">
            {row.events.map((event, index) => {
              const style = stateStyle(RECIPIENT_STATES, event.state);
              return (
                <TimelineRow
                  key={event.id}
                  color={TONES[style.tone].dot}
                  when={event.when}
                  detail={event.detail}
                  last={index === row.events.length - 1}
                  badge={<Badge tone={style.tone}>{style.label}</Badge>}
                />
              );
            })}
          </div>
        </section>
      </div>
    </Drawer>
  );
}

/* -------------------------------------------------------------- utils -- */

/** The server's own first sentence, ending in a full stop. */
export function sentence(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return message.endsWith('.') ? message : `${message}.`;
}

export function requestId(error: unknown): { requestId?: string } {
  return error instanceof ApiError && error.requestId !== undefined ? { requestId: error.requestId } : {};
}
