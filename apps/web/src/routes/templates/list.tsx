import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Menu,
  Modal,
  Skeleton,
  Tabs,
} from '@relayd/ui';
import type { MenuItem } from '@relayd/ui';
import {
  STARTER_HTML,
  STARTER_SUBJECT,
  templateApi,
  templateKeys,
  type Template,
} from '../../api/templates.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import { IfPermitted } from '../../auth/guards.js';
import { InlineSelect, TemplateThumb, requestId, sentence } from './parts.js';

/**
 * F1 — Templates.
 *
 * "HTML templates with merge tags. Published versions are immutable so every
 * campaign keeps an exact record of what it sent." That sentence is the page:
 * a card carries the *newest* version's state, so a template whose v6 is
 * published and whose v7 is being written reads "Draft · 7 versions" — the
 * fact an author came here for. The published pointer is what a campaign
 * picks up and lives on the editor, where it can be explained.
 *
 * Three states from the frames: the grid (F1), the empty card (F1e) and the
 * error card with its request id (F1f).
 */

const DESCRIPTION =
  'HTML templates with merge tags. Published versions are immutable so every campaign keeps an exact record of what it sent.';

/** F1e and F1f drop the second clause: with nothing on screen it is noise. */
const SHORT_DESCRIPTION = 'HTML templates with merge tags.';

const SORTS = [
  { value: 'edited', label: 'Last edited' },
  { value: 'name', label: 'Name' },
  { value: 'created', label: 'Recently created' },
] as const;

type Sort = (typeof SORTS)[number]['value'];

const DEFAULT_ACCENT = '#141B3D';

function isArchived(template: Template): boolean {
  return template.archived === true;
}

function versionsLabel(template: Template): string {
  const count = template.versionCount ?? 0;
  return count === 1 ? '1 version' : `${count} versions`;
}

export function TemplatesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currentWorkspaceId, can } = useAuth();
  const readOnly = useReadOnly();

  const [tab, setTab] = useState('active');
  const [sort, setSort] = useState<Sort>('edited');
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const templates = useQuery({
    queryKey: templateKeys.list(currentWorkspaceId),
    queryFn: () => templateApi.list(),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: templateKeys.scoped(currentWorkspaceId) });
    void queryClient.invalidateQueries({ queryKey: templateKeys.all });
  };

  const create = useMutation({
    mutationFn: (templateName: string) =>
      templateApi.create({ name: templateName, subject: STARTER_SUBJECT, html: STARTER_HTML }),
    onSuccess: (result) => {
      invalidate();
      setNaming(false);
      setName('');
      navigate(`/templates/${result.template.id}`);
    },
  });

  const duplicate = useMutation({
    // BACKEND PENDING: POST /templates/:id/duplicate
    mutationFn: (id: string) => templateApi.duplicate(id),
    onSuccess: (created) => {
      invalidate();
      navigate(`/templates/${created.id}`);
    },
  });

  const archive = useMutation({
    // BACKEND PENDING: POST /templates/:id/archive, POST /templates/:id/unarchive
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      archived ? templateApi.unarchive(id) : templateApi.archive(id),
    onSuccess: invalidate,
  });

  const rows = templates.data ?? [];
  const active = rows.filter((row) => !isArchived(row));
  const archived = rows.filter(isArchived);

  const visible = useMemo(() => {
    const scope = tab === 'archived' ? archived : active;
    const sorted = [...scope];

    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'created') sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    else sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return sorted;
  }, [active, archived, sort, tab]);

  const canWrite = can('template:write') && !readOnly;
  const writeReason = readOnly
    ? 'Workspace is read-only'
    : 'Your role cannot change templates';

  const newButton = (
    <IfPermitted permission="template:write">
      <Button
        disabled={!canWrite}
        title={canWrite ? undefined : writeReason}
        onClick={() => setNaming(true)}
      >
        <Icon name="plus" size={15} strokeWidth={2.25} />
        New template
      </Button>
    </IfPermitted>
  );

  const menuFor = (template: Template): MenuItem[] => [
    { key: 'edit', label: 'Edit', onSelect: () => navigate(`/templates/${template.id}`) },
    {
      key: 'duplicate',
      label: 'Duplicate',
      disabled: !canWrite,
      reason: canWrite ? undefined : writeReason,
      onSelect: () => duplicate.mutate(template.id),
    },
    {
      key: 'test',
      label: 'Send test',
      disabled: template.currentVersionId === null,
      reason:
        template.currentVersionId === null ? 'Save a version before sending a test' : undefined,
      onSelect: () => navigate(`/templates/${template.id}?test=1`),
    },
    {
      key: 'archive',
      label: isArchived(template) ? 'Restore' : 'Archive',
      tone: 'muted',
      separatorBefore: true,
      disabled: !canWrite,
      reason: canWrite ? undefined : writeReason,
      onSelect: () => archive.mutate({ id: template.id, archived: isArchived(template) }),
    },
  ];

  /**
   * The header is written out rather than taken from `PageHeader` for one
   * reason: at 390px a sort control and a button cannot sit on the title's
   * row, and `PageHeader` holds its actions `flex-none`. Same geometry,
   * `flex-wrap` added. Reported under uiGaps.
   */
  const header = (description: string, actions: ReactNode) => (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="m-0 text-title font-semibold leading-heading tracking-heading">Templates</h1>
        <p className="mt-1 mb-0 text-body text-text-2">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );

  /* F1e / F1f draw the short header with no sort and no tabs. */
  const plainHeader = header(SHORT_DESCRIPTION, newButton);

  const dialog = (
    <Modal
      open={naming}
      onClose={() => setNaming(false)}
      title="New template"
      description="Name it now; the subject, the HTML and the plain-text version are written in the editor."
      footer={
        <>
          <Button variant="secondary" onClick={() => setNaming(false)}>
            Cancel
          </Button>
          <Button
            pending={create.isPending}
            disabled={name.trim() === ''}
            title={name.trim() === '' ? 'Give the template a name' : undefined}
            onClick={() => create.mutate(name.trim())}
          >
            Create template
          </Button>
        </>
      }
    >
      <Field
        label="Name"
        value={name}
        maxLength={120}
        placeholder="Autumn escapes"
        onChange={(event) => setName(event.target.value)}
        {...(create.isError ? { error: sentence(create.error) } : {})}
      />
    </Modal>
  );

  if (templates.isError) {
    return (
      <>
        {plainHeader}
        <ErrorState
          title="We couldn't load templates"
          description={`${sentence(templates.error)} Published versions used by campaigns are unaffected. Send support the request ID if it keeps happening.`}
          {...requestId(templates.error)}
          actions={<Button variant="secondary">Contact support</Button>}
          onRetry={() => void templates.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  if (templates.isPending) {
    return (
      <>
        {plainHeader}
        <div
          role="status"
          aria-busy="true"
          aria-live="polite"
          aria-label="Loading templates"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          <span className="sr-only">Loading templates</span>
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="overflow-hidden rounded-card border border-border bg-surface">
              <Skeleton height={168} radius={0} />
              <div className="flex flex-col gap-2 px-3.5 pt-3 pb-3.5">
                <Skeleton width="60%" height={13} />
                <Skeleton width="80%" height={12} />
                <Skeleton width={84} height={22} radius={6} />
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  if (rows.length === 0) {
    return (
      <>
        {plainHeader}
        <EmptyState
          icon="templates"
          title="No templates yet"
          description="Start from a blank HTML template or paste your own. Merge tags with fallbacks, an unsubscribe link and a plain-text version are checked before publishing."
          action={newButton}
        />
        {dialog}
      </>
    );
  }

  return (
    <>
      {header(
        DESCRIPTION,
        <>
          <InlineSelect
            inset
            label="Sort"
            value={sort}
            onChange={(next) => setSort(next as Sort)}
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </InlineSelect>
          {newButton}
        </>,
      )}

      <Tabs
        label="Template states"
        value={tab}
        onChange={setTab}
        items={[
          { key: 'active', label: 'Active', count: active.length },
          { key: 'archived', label: 'Archived', count: archived.length },
        ]}
      />

      {visible.length === 0 ? (
        <EmptyState
          icon="templates"
          title={tab === 'archived' ? 'Nothing archived' : 'No active templates'}
          description={
            tab === 'archived'
              ? 'Archived templates stay here, and the published versions campaigns already sent are unaffected.'
              : 'Every template is archived. Restore one, or start a new blank HTML template.'
          }
          {...(tab === 'archived' ? {} : { action: newButton })}
        />
      ) : (
        <ul className="grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((template) => (
            <li
              key={template.id}
              className="relative min-w-0 overflow-hidden rounded-card border border-border bg-surface"
            >
              <Link to={`/templates/${template.id}`} tabIndex={-1} aria-hidden="true" className="block no-underline">
                <TemplateThumb accent={template.accent ?? DEFAULT_ACCENT} hero={template.hero !== false} />
              </Link>

              <div className="px-3.5 pt-3 pb-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      to={`/templates/${template.id}`}
                      className="block truncate text-ui font-semibold text-text no-underline hover:text-brand"
                    >
                      {template.name}
                    </Link>
                    <div className="mt-0.5 truncate text-caption text-text-2">
                      {template.editedLabel ?? template.id}
                    </div>
                  </div>
                  <Menu items={menuFor(template)} width={170} label={`Actions for ${template.name}`} />
                </div>

                <div className="mt-2.5 flex items-center justify-between gap-2 text-caption text-text-2">
                  {template.state === 'published' ? (
                    <Badge tone="success">Published</Badge>
                  ) : (
                    <Badge tone="neutral">Draft</Badge>
                  )}
                  <span className="tabular-nums">{versionsLabel(template)}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {dialog}
    </>
  );
}
