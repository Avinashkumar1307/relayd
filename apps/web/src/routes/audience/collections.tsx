import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { audienceApi, audienceKeys, type Suppression } from '../../api/audience.js';
import { IfPermitted } from '../../auth/guards.js';
import { Badge, Button, Cell, EmptyState, LoadError, Loading, Page, Table, formatDate } from '../../components/ui.js';

/**
 * Lists, tags and suppressions.
 *
 * Three pages in one file because they are the same page three times — a
 * table, an inline create form, a delete. Splitting them would triple the
 * boilerplate without separating anything that changes independently.
 */

export function ListsPage() {
  const queryClient = useQueryClient();
  const lists = useQuery({ queryKey: audienceKeys.lists, queryFn: audienceApi.listLists });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: audienceKeys.lists });
  };

  const create = useMutation({ mutationFn: audienceApi.createList, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: audienceApi.deleteList, onSuccess: invalidate });

  return (
    <Page
      title="Lists"
      description="Named groups a campaign can be sent to."
      action={
        <IfPermitted permission="contact:write">
          <InlineCreate
            label="New list"
            fields={[
              { name: 'name', label: 'Name', required: true },
              { name: 'description', label: 'Description' },
            ]}
            pending={create.isPending}
            error={create.error}
            onSubmit={(values) => {
              const name = values['name'] ?? '';
              const description = values['description'] ?? '';
              if (name === '') return;
              create.mutate({ name, ...(description === '' ? {} : { description }) });
            }}
          />
        </IfPermitted>
      }
    >
      {lists.isPending ? (
        <Loading />
      ) : lists.isError ? (
        <LoadError error={lists.error} onRetry={() => void lists.refetch()} />
      ) : lists.data.length === 0 ? (
        <EmptyState title="No lists yet">A list is how a campaign chooses its audience.</EmptyState>
      ) : (
        <Table columns={['Name', 'Description', 'Contacts', 'Created', '']} caption="Lists">
          {lists.data.map((list) => (
            <tr key={list.id}>
              <Cell>{list.name}</Cell>
              <Cell muted={list.description === null}>{list.description ?? '—'}</Cell>
              <Cell>{list.memberCount.toLocaleString()}</Cell>
              <Cell muted>{formatDate(list.createdAt)}</Cell>
              <Cell>
                <IfPermitted permission="contact:write">
                  <div className="flex justify-end">
                    <Button variant="danger" onClick={() => remove.mutate(list.id)}>
                      Delete
                    </Button>
                  </div>
                </IfPermitted>
              </Cell>
            </tr>
          ))}
        </Table>
      )}
    </Page>
  );
}

export function TagsPage() {
  const queryClient = useQueryClient();
  const tags = useQuery({ queryKey: audienceKeys.tags, queryFn: audienceApi.listTags });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: audienceKeys.tags });
  };

  const create = useMutation({ mutationFn: audienceApi.createTag, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: audienceApi.deleteTag, onSuccess: invalidate });

  return (
    <Page
      title="Tags"
      description="Labels you can filter and segment by."
      action={
        <IfPermitted permission="contact:write">
          <InlineCreate
            label="New tag"
            fields={[
              { name: 'name', label: 'Name', required: true },
              { name: 'color', label: 'Colour', type: 'color', defaultValue: '#3b82f6' },
            ]}
            pending={create.isPending}
            error={create.error}
            onSubmit={(values) => {
              const name = values['name'] ?? '';
              const color = values['color'] ?? '';
              if (name === '') return;
              create.mutate({ name, ...(color === '' ? {} : { color }) });
            }}
          />
        </IfPermitted>
      }
    >
      {tags.isPending ? (
        <Loading />
      ) : tags.isError ? (
        <LoadError error={tags.error} onRetry={() => void tags.refetch()} />
      ) : tags.data.length === 0 ? (
        <EmptyState title="No tags yet" />
      ) : (
        <Table columns={['Tag', 'Created', '']} caption="Tags">
          {tags.data.map((tag) => (
            <tr key={tag.id}>
              <Cell>
                <span className="inline-flex items-center gap-2">
                  {/*
                    The colour is validated as a hex value by the API schema,
                    so it cannot become arbitrary CSS. It is still applied as
                    a background rather than interpolated into a class name,
                    which Tailwind would not generate anyway.
                  */}
                  <span
                    aria-hidden="true"
                    className="inline-block h-3 w-3 rounded-full border border-slate-300"
                    style={{ backgroundColor: tag.color ?? 'transparent' }}
                  />
                  {tag.name}
                </span>
              </Cell>
              <Cell muted>{formatDate(tag.createdAt)}</Cell>
              <Cell>
                <IfPermitted permission="contact:write">
                  <div className="flex justify-end">
                    <Button variant="danger" onClick={() => remove.mutate(tag.id)}>
                      Delete
                    </Button>
                  </div>
                </IfPermitted>
              </Cell>
            </tr>
          ))}
        </Table>
      )}
    </Page>
  );
}

const SUPPRESSION_TONE: Record<Suppression['reason'], 'neutral' | 'warn' | 'bad'> = {
  unsubscribe: 'neutral',
  hard_bounce: 'warn',
  complaint: 'bad',
  manual: 'neutral',
  invalid: 'warn',
};

export function SuppressionsPage() {
  const queryClient = useQueryClient();
  const suppressions = useQuery({
    queryKey: audienceKeys.suppressions,
    queryFn: audienceApi.listSuppressions,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: audienceKeys.suppressions });
  };

  const create = useMutation({ mutationFn: audienceApi.createSuppression, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: audienceApi.deleteSuppression, onSuccess: invalidate });

  return (
    <Page
      title="Suppressions"
      description="Addresses this workspace will never send to, whatever a list or import says."
      action={
        <IfPermitted permission="contact:write">
          <InlineCreate
            label="Suppress an address"
            fields={[
              { name: 'email', label: 'Email', type: 'email', required: true },
              { name: 'notes', label: 'Note' },
            ]}
            pending={create.isPending}
            error={create.error}
            onSubmit={(values) => {
              const email = values['email'] ?? '';
              const notes = values['notes'] ?? '';
              if (email === '') return;
              create.mutate({ email, reason: 'manual', ...(notes === '' ? {} : { notes }) });
            }}
          />
        </IfPermitted>
      }
    >
      {suppressions.isPending ? (
        <Loading />
      ) : suppressions.isError ? (
        <LoadError error={suppressions.error} onRetry={() => void suppressions.refetch()} />
      ) : suppressions.data.length === 0 ? (
        <EmptyState title="Nothing suppressed">
          Bounces and complaints land here automatically once you start sending.
        </EmptyState>
      ) : (
        <Table columns={['Email', 'Reason', 'Note', 'Added', '']} caption="Suppressions">
          {suppressions.data.map((entry) => (
            <tr key={entry.id}>
              <Cell>{entry.email}</Cell>
              <Cell>
                <Badge tone={SUPPRESSION_TONE[entry.reason]}>{entry.reason.replace('_', ' ')}</Badge>
              </Cell>
              <Cell muted={entry.notes === null}>{entry.notes ?? '—'}</Cell>
              <Cell muted>{formatDate(entry.createdAt)}</Cell>
              <Cell>
                <IfPermitted permission="contact:write">
                  <div className="flex justify-end">
                    {/*
                      Only a manual entry can be lifted here. A hard bounce or
                      a complaint is evidence from a mailbox provider, and
                      deleting it to send again is how a workspace loses its
                      sending reputation — and ours, by association.
                    */}
                    {entry.reason === 'manual' ? (
                      <Button variant="danger" onClick={() => remove.mutate(entry.id)}>
                        Remove
                      </Button>
                    ) : (
                      <span className="text-xs text-slate-500">Permanent</span>
                    )}
                  </div>
                </IfPermitted>
              </Cell>
            </tr>
          ))}
        </Table>
      )}
    </Page>
  );
}

interface CreateField {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
}

/**
 * A disclosure that turns into a small form.
 *
 * Inline rather than a modal: a dialog needs focus trapping, an escape
 * handler and a return-focus target to be usable with a keyboard, and three
 * fields do not earn that.
 */
function InlineCreate({
  label,
  fields,
  pending,
  error,
  onSubmit,
}: {
  label: string;
  fields: readonly CreateField[];
  pending: boolean;
  error: unknown;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!open) return <Button onClick={() => setOpen(true)}>{label}</Button>;

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const values: Record<string, string> = {};
        for (const field of fields) values[field.name] = String(data.get(field.name) ?? '').trim();
        onSubmit(values);
      }}
    >
      {fields.map((field) => (
        <div key={field.name}>
          <label htmlFor={`create-${field.name}`} className="block text-xs text-slate-600">
            {field.label}
          </label>
          <input
            id={`create-${field.name}`}
            name={field.name}
            type={field.type ?? 'text'}
            required={field.required === true}
            defaultValue={field.defaultValue}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </div>
      ))}

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
      <Button variant="secondary" onClick={() => setOpen(false)}>
        Cancel
      </Button>

      {error !== null && error !== undefined && (
        <p role="alert" className="w-full text-xs text-red-600">
          {error instanceof Error ? error.message : 'That did not save.'}
        </p>
      )}
    </form>
  );
}
