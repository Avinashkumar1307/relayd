import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import {
  Badge,
  Button,
  ConfirmDestructive,
  CopyButton,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Modal,
  PageHeader,
  Select,
  TableSkeleton,
  type Column,
} from '@relayd/ui';
import { ApiError } from '../../api/client.js';
import {
  apiKeysApi,
  platformKeys,
  type ApiKey,
  type ApiKeyEnvironment,
  type IssuedApiKey,
} from '../../api/platform.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly, useWorkspaceRecord } from '../../auth/workspace-state.js';
import {
  CheckChip,
  CodeChip,
  formatAgo,
  formatDate,
  formatDateTime,
  groupScopes,
} from './platform-parts.js';

/**
 * J3a / J3b / J3c / J3e / J3f — /settings/api and /settings/api/new.
 *
 * The page exists to do one thing well: hand over a credential exactly once,
 * in a way the person cannot miss and cannot half-copy. Everything else here
 * is in service of that.
 *
 * Three details are not decoration.
 *
 * A revoked key stays in the list, greyed, with the date and who did it,
 * because the question after a leak is "was it revoked, and when", and a
 * list that hides them answers with silence.
 *
 * The create dialog has no billing scopes and says so in words (J3b's lock
 * row). CLAUDE.md section 11: `billing:write` is owner-only and can never be
 * attached to a key. A gap where a row would be is a thing an integrator
 * reads as an oversight and asks support about; a sentence is an answer.
 *
 * And the reveal is its own page, not a dialog, because a dialog is
 * something a person dismisses by reflex and this is the only time the
 * secret exists outside our hash.
 */

const BASE_URL = 'https://api.relayd.io/v1';
const DOCS_URL = 'https://docs.relayd.io/api';
const READ_ONLY_TITLE = 'Workspace is read-only';

/** J3a's 28px in-row action — smaller than `Button`'s 34px `md`. */
const ROW_BUTTON =
  'inline-flex h-7 cursor-pointer items-center rounded-badge border border-border bg-surface px-2 text-caption font-medium disabled:cursor-not-allowed disabled:text-text-3';

/* ------------------------------------------------------------------ */
/* J3a — the list                                                      */
/* ------------------------------------------------------------------ */

export function ApiKeysPage() {
  const { current } = useAuth();
  const workspaceId = current?.workspaceId ?? 'none';
  const readOnly = useReadOnly();
  const navigate = useNavigate();

  const keys = useQuery({
    queryKey: platformKeys.apiKeys(workspaceId),
    queryFn: () => apiKeysApi.list(),
  });

  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const rows = keys.data ?? [];

  const columns: readonly Column<ApiKey>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{row.name}</div>
          <div className="truncate text-caption text-text-2">{subtitleFor(row)}</div>
        </div>
      ),
    },
    {
      key: 'key',
      header: 'Key',
      width: '190px',
      cell: (row) => (
        <span className="inline-flex h-6 items-center rounded-badge border border-border bg-tint px-2 font-mono text-caption">
          {row.keyPrefix}…
        </span>
      ),
    },
    {
      key: 'scopes',
      header: 'Scopes',
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.scopes.map((scope) => (
            <CodeChip key={scope}>{scope}</CodeChip>
          ))}
        </div>
      ),
    },
    {
      key: 'lastUsed',
      header: 'Last used',
      width: '130px',
      cell: (row) => <span className="whitespace-nowrap text-text-2">{formatAgo(row.lastUsedAt)}</span>,
    },
    {
      key: 'created',
      header: 'Created',
      width: '170px',
      cell: (row) => (
        <span className="whitespace-nowrap text-text-2">{formatDate(row.createdAt)}</span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      width: '110px',
      align: 'right',
      cell: (row) =>
        row.revokedAt !== null ? (
          <Badge tone="neutral">Revoked</Badge>
        ) : (
          <button
            type="button"
            onClick={() => setRevoking(row)}
            disabled={readOnly}
            title={readOnly ? READ_ONLY_TITLE : undefined}
            className={`${ROW_BUTTON} text-danger-text`}
          >
            Revoke
          </button>
        ),
    },
  ];

  const header = (withBaseUrl: boolean) => (
    <PageHeader
      title="API keys"
      description={
        withBaseUrl ? (
          <>
            Keys are scoped per workspace and shown once at creation. Base URL{' '}
            <span className="font-mono text-caption">{BASE_URL}</span> ·{' '}
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-brand no-underline"
            >
              Docs
            </a>
          </>
        ) : (
          'Keys are scoped per workspace and shown once at creation.'
        )
      }
      actions={
        <Button
          onClick={() => setCreating(true)}
          disabled={readOnly}
          title={readOnly ? READ_ONLY_TITLE : undefined}
        >
          {withBaseUrl ? (
            <span className="inline-flex items-center gap-1.5">
              <Icon name="plus" size={15} strokeWidth={2} />
              Create key
            </span>
          ) : (
            'Create key'
          )}
        </Button>
      }
    />
  );

  const dialog = creating ? (
    <CreateKeyDialog
      workspaceId={workspaceId}
      onClose={() => setCreating(false)}
      onIssued={(issued) => {
        setCreating(false);
        void navigate('/settings/api/new', { state: { issued } });
      }}
    />
  ) : null;

  if (keys.isPending) {
    return (
      <>
        {header(true)}
        <TableSkeleton rows={4} tabs={false} label="Loading API keys" />
      </>
    );
  }

  if (keys.isError) {
    return (
      <>
        {header(false)}
        <ErrorState
          title="We couldn't load API keys"
          description="The request failed. Existing keys keep working; only this list is affected. Send support the request ID if it keeps happening."
          requestId={keys.error instanceof ApiError ? keys.error.requestId : undefined}
          actions={
            <a href="mailto:support@relayd.io" className="no-underline">
              <Button variant="secondary">Contact support</Button>
            </a>
          }
          onRetry={() => void keys.refetch()}
          retryLabel="Retry"
        />
        {dialog}
      </>
    );
  }

  if (rows.length === 0) {
    return (
      <>
        {header(false)}
        <EmptyState
          icon="api"
          title="No API keys yet"
          description="Create a key to read contacts, manage campaigns or pull reports from your own systems. Billing is never available through the API."
          action={
            <Button
              onClick={() => setCreating(true)}
              disabled={readOnly}
              title={readOnly ? READ_ONLY_TITLE : undefined}
            >
              Create key
            </Button>
          }
        />
        {dialog}
      </>
    );
  }

  return (
    <>
      {header(true)}

      {/* Mobile: one card per key. A six-column table at 390px is a table
          nobody reads, and the scopes are the half that matters. */}
      <ul className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => (
          <li
            key={row.id}
            className={`rounded-card border border-border bg-surface p-3.5 ${row.revokedAt === null ? '' : 'text-text-2'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-body font-medium text-text">{row.name}</div>
                <div className="text-caption text-text-2">{subtitleFor(row)}</div>
              </div>
              {row.revokedAt === null ? null : (
                <span className="flex-none">
                  <Badge tone="neutral">Revoked</Badge>
                </span>
              )}
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex h-6 items-center rounded-badge border border-border bg-tint px-2 font-mono text-caption">
                {row.keyPrefix}…
              </span>
              {row.scopes.map((scope) => (
                <CodeChip key={scope}>{scope}</CodeChip>
              ))}
            </div>

            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-caption text-text-2">
              <span>
                Last used {formatAgo(row.lastUsedAt)} · Created {formatDate(row.createdAt)}
              </span>
              {row.revokedAt === null ? (
                <button
                  type="button"
                  onClick={() => setRevoking(row)}
                  disabled={readOnly}
                  title={readOnly ? READ_ONLY_TITLE : undefined}
                  className={`${ROW_BUTTON} text-danger-text`}
                >
                  Revoke
                </button>
              ) : null}
            </div>
          </li>
        ))}
        <li className="text-caption text-text-2">
          Keys inherit the workspace&apos;s role limits: no key can launch a campaign unless it
          holds <CodeChip>campaigns:launch</CodeChip>, and no key can touch billing.
        </li>
      </ul>

      <div className="hidden md:block">
        <DataTable
          label="API keys"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          rowMuted={(row) => row.revokedAt !== null}
          footer={
            <span className="text-caption text-text-2">
              Keys inherit the workspace&apos;s role limits: no key can launch a campaign unless it
              holds <CodeChip>campaigns:launch</CodeChip>, and no key can touch billing.
            </span>
          }
        />
      </div>
      {dialog}
      <RevokeDialog
        workspaceId={workspaceId}
        apiKey={revoking}
        onClose={() => setRevoking(null)}
      />
    </>
  );
}

/** "HubSpot · created by Omar Haddad", or the revoked line once it is. */
function subtitleFor(row: ApiKey): string {
  if (row.revokedAt !== null) {
    const by = row.revokedByName ?? null;
    return `Revoked ${formatDate(row.revokedAt)}${by === null ? '' : ` by ${by}`}`;
  }

  const parts: string[] = [];
  if (row.integration !== null && row.integration !== undefined && row.integration !== '') {
    parts.push(row.integration);
  }
  if (row.createdByName !== null && row.createdByName !== undefined) {
    parts.push(`created by ${row.createdByName}`);
  }
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ */
/* Revoking                                                            */
/* ------------------------------------------------------------------ */

function RevokeDialog({
  workspaceId,
  apiKey,
  onClose,
}: {
  workspaceId: string;
  apiKey: ApiKey | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const revoke = useMutation({
    mutationFn: (id: string) => apiKeysApi.revoke(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: platformKeys.apiKeys(workspaceId) });
      onClose();
    },
  });

  if (apiKey === null) return null;

  return (
    <ConfirmDestructive
      open
      onClose={onClose}
      onConfirm={() => revoke.mutate(apiKey.id)}
      title="Revoke this key?"
      confirmLabel="Revoke key"
      pending={revoke.isPending}
    >
      <p>
        Anything using <strong>{apiKey.name}</strong> stops working immediately, and the next
        request with it gets a 401. This cannot be undone — a replacement is a new key with a new
        secret.
      </p>
      <p className="mt-2">
        The row stays in this list, marked revoked, so the change is on the record.
      </p>
    </ConfirmDestructive>
  );
}

/* ------------------------------------------------------------------ */
/* J3b — the create dialog                                             */
/* ------------------------------------------------------------------ */

const EXPIRY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Never' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];

function CreateKeyDialog({
  workspaceId,
  onClose,
  onIssued,
}: {
  workspaceId: string;
  onClose: () => void;
  onIssued: (issued: IssuedApiKey) => void;
}) {
  const queryClient = useQueryClient();
  const scopes = useQuery({
    queryKey: platformKeys.apiKeyScopes(workspaceId),
    queryFn: () => apiKeysApi.scopes(),
  });

  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<ApiKeyEnvironment>('live');
  const [expiresIn, setExpiresIn] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  const create = useMutation({
    mutationFn: () =>
      apiKeysApi.create({
        name: name.trim(),
        scopes: selected,
        // BACKEND PENDING: POST /api-keys { environment }
        environment,
        ...(expiresIn === '' ? {} : { expiresInDays: Number(expiresIn) }),
      }),
    onSuccess: async (issued) => {
      await queryClient.invalidateQueries({ queryKey: platformKeys.apiKeys(workspaceId) });
      onIssued(issued);
    },
  });

  const groups = groupScopes(scopes.data?.scopes ?? []);

  const toggle = (scope: string, next: boolean) =>
    setSelected((current) =>
      next ? [...current, scope] : current.filter((held) => held !== scope),
    );

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title="Create API key"
      description="Grant the smallest set of scopes the integration needs."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={name.trim() === '' || selected.length === 0}
            pending={create.isPending}
          >
            Create key
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-ui">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_160px]">
          <Field
            label="Name"
            placeholder="CRM sync (HubSpot)"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Select
            label="Environment"
            value={environment}
            onChange={(event) => setEnvironment(event.target.value as ApiKeyEnvironment)}
          >
            <option value="live">Live</option>
            <option value="test">Test</option>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="font-medium">
            Scopes <span className="font-normal text-text-2">· {selected.length} selected</span>
          </span>

          <div className="overflow-hidden rounded-control border border-border">
            {scopes.isPending ? (
              <p className="px-3.5 py-2.5 text-caption text-text-2">Loading scopes…</p>
            ) : scopes.isError ? (
              <p role="alert" className="px-3.5 py-2.5 text-caption text-danger-text">
                We couldn&apos;t load the scopes you can grant. Close this and try again.
              </p>
            ) : (
              groups.map((group) => (
                <div
                  key={group.label}
                  className="grid grid-cols-1 items-center gap-3 border-b border-border px-3.5 py-2.5 sm:grid-cols-[150px_1fr]"
                >
                  <span className="font-medium">{group.label}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {group.scopes.map((scope) => (
                      <CheckChip
                        key={scope}
                        value={scope}
                        checked={selected.includes(scope)}
                        onChange={(next) => toggle(scope, next)}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}

            {/*
              J3b's lock row. The absence of billing scopes is deliberate
              (CLAUDE.md section 11) and therefore has to be said: a gap
              where a row would be reads as an oversight.
            */}
            <div className="flex items-center gap-2 bg-tint px-3.5 py-2.5 text-caption text-text-2">
              <span className="flex-none">
                <Icon name="lock" size={14} strokeWidth={2} />
              </span>
              There are no billing scopes. Plans, payment and cancellation can only be changed by
              the Owner in the app.
            </div>
          </div>
        </div>

        <div className="max-w-60">
          <Select
            // Not `labelAside`: that slot is pushed to the right of the row,
            // and J3b sets "· optional" straight after the word.
            label={
              <>
                Expires <span className="font-normal text-text-2">· optional</span>
              </>
            }
            value={expiresIn}
            onChange={(event) => setExpiresIn(event.target.value)}
          >
            {EXPIRY_OPTIONS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>

        {create.isError ? (
          <p role="alert" className="text-ui text-danger-text">
            {create.error instanceof ApiError ? create.error.message : 'That did not work.'}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* J3c — the reveal, once                                              */
/* ------------------------------------------------------------------ */

interface NewKeyState {
  issued?: IssuedApiKey;
}

/**
 * The one-time reveal.
 *
 * The secret arrives in router state and nothing else: there is no query for
 * it, because there is nothing stored that could answer one. Reaching this
 * URL any other way — a refresh, a bookmark, a second tab — goes back to the
 * list rather than rendering a page that promises a key it cannot produce.
 */
export function NewApiKeyPage() {
  const location = useLocation();
  const issued = (location.state as NewKeyState | null)?.issued;
  const { user } = useAuth();
  const timeZone = useWorkspaceRecord().data?.timezone ?? null;
  const [stored, setStored] = useState(false);

  if (issued === undefined) return <Navigate to="/settings/api" replace />;

  const prefix = issued.keyPrefix;
  const environment = issued.environment === 'test' ? 'Test' : 'Live';
  const expiry =
    issued.expiresAt === null ? 'never expires' : `expires ${formatDate(issued.expiresAt)}`;
  const creator = user?.name ?? 'you';

  return (
    <div className="mx-auto w-full max-w-180 pt-6">
      <div className="flex flex-col gap-4.5 rounded-card border border-border bg-surface p-7">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 flex-none place-items-center rounded-10 bg-success-soft text-success-text">
            <Icon name="check" size={20} strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <h1 className="m-0 text-section font-semibold leading-heading tracking-heading">
              Key created: {issued.name}
            </h1>
            <div className="mt-0.5 text-ui text-text-2">
              {environment} · {issued.scopes.join(', ')} · {expiry} · created by {creator},{' '}
              {formatDateTime(issued.createdAt, timeZone)}
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2.5 rounded-control bg-warning-soft px-3.5 py-3 text-ui text-warning-text">
          <span className="mt-0.5 flex-none">
            <Icon name="alert" size={15} strokeWidth={2} />
          </span>
          <span>
            <span className="font-semibold">This is the only time the full key is shown.</span> Copy
            it into your secret manager now. After you leave this page only the prefix{' '}
            <span className="font-mono text-caption">{prefix}</span> remains visible to anyone,
            including you.
          </span>
        </div>

        <div>
          <div className="mb-1.5 text-ui font-medium">Secret key</div>
          <div className="flex h-11 items-center gap-2 rounded-control border border-brand bg-surface pr-1.5 pl-3.5 font-mono text-body ring-[3px] ring-brand-soft">
            <code className="flex-1 truncate font-mono">{issued.keyShownOnce}</code>
            <CopyButton text={issued.keyShownOnce} ariaLabel="Copy secret key" />
          </div>
        </div>

        <pre className="m-0 overflow-x-auto rounded-control border border-border bg-tint px-3.5 py-3 font-mono text-caption leading-[1.7] text-text">
          <span className="text-text-3"># Try it</span>
          {'\n'}curl {BASE_URL}/contacts?limit=1 \{'\n'}  -H &quot;Authorization: Bearer {prefix}…&quot;
        </pre>

        <label className="flex cursor-pointer items-center gap-2.5 text-ui select-none">
          <input
            type="checkbox"
            checked={stored}
            onChange={(event) => setStored(event.target.checked)}
            className="sr-only"
          />
          <span
            aria-hidden="true"
            className={[
              'grid h-[18px] w-[18px] flex-none place-items-center rounded-4 border',
              stored ? 'border-brand bg-brand text-on-brand' : 'border-border bg-surface',
            ].join(' ')}
          >
            {stored ? (
              <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : null}
          </span>
          I&apos;ve stored this key somewhere safe
        </label>

        <div className="flex justify-end border-t border-border pt-4.5">
          {stored ? (
            <Link to="/settings/api" className="no-underline">
              <Button>Done — back to API keys</Button>
            </Link>
          ) : (
            <Button disabled title="Confirm you have stored the key first">
              Done — back to API keys
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
