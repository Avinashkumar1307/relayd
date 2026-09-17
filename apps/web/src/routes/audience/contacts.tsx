import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { audienceApi, audienceKeys, type Contact, type ContactStatus } from '../../api/audience.js';
import { IfPermitted } from '../../auth/guards.js';
import { Badge, Button, Cell, EmptyState, LoadError, Loading, Page, Table, formatDate } from '../../components/ui.js';

/**
 * Contacts.
 *
 * Pagination is by cursor and filtering happens on the server, both required
 * by BUILD-PLAN Phase 2. Neither is a preference: an audience can hold
 * hundreds of thousands of contacts, so the page that filters client-side is
 * the page that downloads all of them first.
 */

const STATUSES: readonly ContactStatus[] = [
  'subscribed',
  'unsubscribed',
  'bounced',
  'complained',
  'cleaned',
];

const STATUS_TONE: Record<ContactStatus, 'neutral' | 'good' | 'warn' | 'bad'> = {
  subscribed: 'good',
  unsubscribed: 'neutral',
  bounced: 'warn',
  complained: 'bad',
  cleaned: 'neutral',
};

export function ContactsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ContactStatus | ''>('');

  /**
   * A stack of cursors, not a page number.
   *
   * Keyset pagination can only move forwards from a cursor it has been given,
   * so going back means remembering where each page started. The alternative
   * is an offset, which skips and repeats rows as the audience changes under
   * the reader.
   */
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors[cursors.length - 1];

  const contacts = useQuery({
    queryKey: audienceKeys.contacts({
      ...(status === '' ? {} : { status }),
      ...(cursor === undefined ? {} : { cursor }),
    }),
    queryFn: () =>
      audienceApi.listContacts({
        limit: 50,
        ...(status === '' ? {} : { status }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['audience', 'contacts'] });
  };

  const updateStatus = useMutation({
    mutationFn: ({ id, next }: { id: string; next: ContactStatus }) =>
      audienceApi.updateContact(id, { status: next }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => audienceApi.deleteContact(id),
    onSuccess: invalidate,
  });

  const changeFilter = (next: ContactStatus | ''): void => {
    // Cursors describe a position in the old result set and mean nothing in
    // the new one, so a filter change starts again from the first page.
    setCursors([]);
    setStatus(next);
  };

  return (
    <Page
      title="Contacts"
      description="Everyone this workspace can send to."
      action={
        <IfPermitted permission="contact:write">
          <AddContactForm onAdded={invalidate} />
        </IfPermitted>
      }
    >
      <div className="flex items-center gap-2">
        <label htmlFor="status-filter" className="text-sm text-slate-600">
          Status
        </label>
        <select
          id="status-filter"
          value={status}
          onChange={(event) => changeFilter(event.target.value as ContactStatus | '')}
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
        >
          <option value="">All</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      {contacts.isPending ? (
        <Loading />
      ) : contacts.isError ? (
        <LoadError error={contacts.error} onRetry={() => void contacts.refetch()} />
      ) : contacts.data.data.length === 0 ? (
        <EmptyState title="No contacts yet">
          Add one above, or import a file from the Imports page.
        </EmptyState>
      ) : (
        <>
          <Table columns={['Email', 'Name', 'Status', 'Added', '']} caption="Contacts">
            {contacts.data.data.map((contact) => (
              <ContactRow
                key={contact.id}
                contact={contact}
                onStatusChange={(next) => updateStatus.mutate({ id: contact.id, next })}
                onDelete={() => remove.mutate(contact.id)}
              />
            ))}
          </Table>

          <div className="flex items-center justify-between">
            <Button
              variant="secondary"
              disabled={cursors.length === 0}
              onClick={() => setCursors((stack) => stack.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={contacts.data.nextCursor === undefined}
              onClick={() => {
                const next = contacts.data.nextCursor;
                if (next !== undefined) setCursors((stack) => [...stack, next]);
              }}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </Page>
  );
}

function ContactRow({
  contact,
  onStatusChange,
  onDelete,
}: {
  contact: Contact;
  onStatusChange: (next: ContactStatus) => void;
  onDelete: () => void;
}) {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ');

  return (
    <tr>
      <Cell>{contact.email}</Cell>
      <Cell muted={name === ''}>{name === '' ? '—' : name}</Cell>
      <Cell>
        <Badge tone={STATUS_TONE[contact.status]}>{contact.status}</Badge>
      </Cell>
      <Cell muted>{formatDate(contact.createdAt)}</Cell>
      <Cell>
        <IfPermitted permission="contact:write">
          <div className="flex justify-end gap-2">
            {contact.status === 'subscribed' ? (
              <Button variant="secondary" onClick={() => onStatusChange('unsubscribed')}>
                Unsubscribe
              </Button>
            ) : contact.status === 'unsubscribed' ? (
              <Button variant="secondary" onClick={() => onStatusChange('subscribed')}>
                Resubscribe
              </Button>
            ) : null}
            <Button variant="danger" onClick={onDelete}>
              Delete
            </Button>
          </div>
        </IfPermitted>
      </Cell>
    </tr>
  );
}

function AddContactForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);

  const create = useMutation({
    mutationFn: audienceApi.createContact,
    onSuccess: () => {
      setOpen(false);
      onAdded();
    },
  });

  if (!open) {
    return <Button onClick={() => setOpen(true)}>Add contact</Button>;
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const email = String(data.get('email') ?? '').trim();
        const firstName = String(data.get('firstName') ?? '').trim();
        if (email === '') return;

        create.mutate({ email, ...(firstName === '' ? {} : { firstName }) });
      }}
    >
      <div>
        <label htmlFor="new-contact-email" className="block text-xs text-slate-600">
          Email
        </label>
        <input
          id="new-contact-email"
          name="email"
          type="email"
          required
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
        />
      </div>
      <div>
        <label htmlFor="new-contact-first" className="block text-xs text-slate-600">
          First name
        </label>
        <input
          id="new-contact-first"
          name="firstName"
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
        />
      </div>
      <Button type="submit" disabled={create.isPending}>
        {create.isPending ? 'Saving…' : 'Save'}
      </Button>
      <Button variant="secondary" onClick={() => setOpen(false)}>
        Cancel
      </Button>

      {create.isError && (
        <p role="alert" className="w-full text-xs text-red-600">
          {create.error instanceof Error ? create.error.message : 'That did not save.'}
        </p>
      )}
      {create.isSuccess && create.data.suppressed && (
        <p role="status" className="w-full text-xs text-amber-700">
          Added, but this address is suppressed and will not be sent to.
        </p>
      )}
    </form>
  );
}
