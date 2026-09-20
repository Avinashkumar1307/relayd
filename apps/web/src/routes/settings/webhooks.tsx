import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDestructive,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Modal,
  PageHeader,
  RevealOnce,
  StateBadge,
  Switch,
  TableSkeleton,
  type Column,
  type LinkProps,
} from '@relayd/ui';
import { ApiError } from '../../api/client.js';
import {
  platformKeys,
  webhookEndpointsApi,
  type CreatedWebhookEndpoint,
  type WebhookDelivery,
  type WebhookEndpoint,
} from '../../api/platform.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly, useWorkspaceRecord } from '../../auth/workspace-state.js';
import {
  CheckChip,
  CodeChip,
  ENDPOINT_STATES,
  GroupLabel,
  formatCount,
  formatDate,
  formatDayMonth,
  formatDayTime,
  formatDayTimeSeconds,
  formatInstant,
  formatLastDelivery,
  formatPercent,
  groupEvents,
  isAutoDisabled,
  isOff,
} from './platform-parts.js';

/**
 * J4a / J4b / J4c / J4e / J4f — /settings/webhooks and below.
 *
 * Outbound webhooks are the one part of the product a customer builds a
 * system on top of, so the screens are about one question: is it working,
 * and if not, what exactly did my server say. That is why the delivery log
 * shows the response code, the attempt number and the next retry rather
 * than a green tick, and why the auto-disable is explained in the words
 * that say how to recover it.
 *
 * Two states are deliberately kept apart. `disabled` is ours — fifty
 * consecutive failures stopped it — and reads "Auto-disabled" in warning.
 * `paused` is the customer's own switch and reads "Disabled" in neutral.
 * Only one of the two is something to fix, and a single grey badge for both
 * would hide which happened.
 */

const READ_ONLY_TITLE = 'Workspace is read-only';

/** J4a's 28px icon action. `Button`'s smallest is 34px. */
const ICON_BUTTON =
  'grid h-7 w-7 place-items-center rounded-badge border border-border bg-surface text-text-2 no-underline hover:bg-tint';

/** ICON_PATHS has no pencil; this is the path the J4a export draws. */
function PencilIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

/** Anything under this is a problem, and J4a prints it in danger. */
const HEALTHY_SUCCESS_RATE = 95;

/* ------------------------------------------------------------------ */
/* J4a — the list                                                      */
/* ------------------------------------------------------------------ */

export function WebhooksPage() {
  const { current } = useAuth();
  const workspaceId = current?.workspaceId ?? 'none';
  const readOnly = useReadOnly();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const timeZone = useWorkspaceRecord().data?.timezone ?? null;

  const endpoints = useQuery({
    queryKey: platformKeys.webhooks(workspaceId),
    queryFn: () => webhookEndpointsApi.list(),
  });

  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<CreatedWebhookEndpoint | null>(null);

  const rows = endpoints.data ?? [];
  const editing = id === undefined ? null : (rows.find((row) => row.id === id) ?? null);
  const autoDisabled = rows.filter(isAutoDisabled);

  const columns: readonly Column<WebhookEndpoint>[] = [
    {
      key: 'endpoint',
      header: 'Endpoint',
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-caption">{row.url}</div>
          {row.description === null ? null : (
            <div className="truncate text-caption text-text-2">{row.description}</div>
          )}
        </div>
      ),
    },
    {
      key: 'events',
      header: 'Events',
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.events.map((event) => (
            <CodeChip key={event}>{event}</CodeChip>
          ))}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '150px',
      cell: (row) => <StateBadge states={ENDPOINT_STATES} state={row.status} />,
    },
    {
      key: 'success',
      header: 'Success · 7d',
      width: '130px',
      align: 'right',
      cell: (row) => {
        const rate = row.successRate7d ?? null;
        const bad = rate !== null && rate < HEALTHY_SUCCESS_RATE;
        return (
          <span className={bad ? 'font-medium text-danger-text' : 'text-text'}>
            {formatPercent(rate)}
          </span>
        );
      },
    },
    {
      key: 'last',
      header: 'Last delivery',
      width: '140px',
      cell: (row) => (
        <span className="whitespace-nowrap text-text-2">
          {formatLastDelivery(row.lastDeliveryAt, timeZone)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '104px',
      align: 'right',
      cell: (row) => (
        <span className="inline-flex justify-end gap-1.5">
          <Link
            to={`/settings/webhooks/${row.id}/deliveries`}
            title="Delivery log"
            aria-label={`Delivery log for ${row.url}`}
            className={ICON_BUTTON}
          >
            <Icon name="lists" size={14} strokeWidth={2} />
          </Link>
          <Link
            to={`/settings/webhooks/${row.id}`}
            title="Edit"
            aria-label={`Edit ${row.url}`}
            className={ICON_BUTTON}
          >
            <PencilIcon />
          </Link>
        </span>
      ),
    },
  ];

  const header = (full: boolean) => (
    <PageHeader
      title="Webhooks"
      description={
        full
          ? 'Outbound endpoints for delivery, engagement and campaign events. Signed with HMAC-SHA256; retried 6 times over 24 hours.'
          : 'Outbound endpoints for delivery, engagement and campaign events.'
      }
      actions={
        <Button
          onClick={() => setCreating(true)}
          disabled={readOnly}
          title={readOnly ? READ_ONLY_TITLE : undefined}
        >
          {full ? (
            <span className="inline-flex items-center gap-1.5">
              <Icon name="plus" size={15} strokeWidth={2} />
              Add endpoint
            </span>
          ) : (
            'Add endpoint'
          )}
        </Button>
      }
    />
  );

  const overlays = (
    <>
      {creating ? (
        <AddEndpointDialog
          workspaceId={workspaceId}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setSecret(created);
          }}
        />
      ) : null}

      {secret === null ? null : (
        <NewSecretDialog endpoint={secret} onClose={() => setSecret(null)} />
      )}

      {editing === null ? null : (
        <EditEndpointDrawer
          key={editing.id}
          workspaceId={workspaceId}
          endpoint={editing}
          onClose={() => void navigate('/settings/webhooks')}
        />
      )}
    </>
  );

  if (endpoints.isPending) {
    return (
      <>
        {header(true)}
        <TableSkeleton rows={4} tabs={false} label="Loading webhook endpoints" />
      </>
    );
  }

  if (endpoints.isError) {
    return (
      <>
        {header(false)}
        <ErrorState
          title="We couldn't load webhooks"
          description="Event delivery is unaffected; only this page failed to load. Send support the request ID if it keeps happening."
          requestId={endpoints.error instanceof ApiError ? endpoints.error.requestId : undefined}
          actions={
            <a href="mailto:support@relayd.io" className="no-underline">
              <Button variant="secondary">Contact support</Button>
            </a>
          }
          onRetry={() => void endpoints.refetch()}
          retryLabel="Retry"
        />
        {overlays}
      </>
    );
  }

  if (rows.length === 0) {
    return (
      <>
        {header(false)}
        <EmptyState
          icon="webhooks"
          title="No endpoints yet"
          description="Add an HTTPS endpoint to receive signed events as they happen: deliveries, bounces, complaints, clicks and campaign state changes."
          action={
            <Button
              onClick={() => setCreating(true)}
              disabled={readOnly}
              title={readOnly ? READ_ONLY_TITLE : undefined}
            >
              Add endpoint
            </Button>
          }
        />
        {overlays}
      </>
    );
  }

  return (
    <>
      {header(true)}
      {autoDisabled.length === 0 ? null : (
        <div className="mb-4">
          <AutoDisabledBanner endpoints={autoDisabled} timeZone={timeZone} />
        </div>
      )}
      {/* Mobile: one card per endpoint. The URL is the identifier and it is
          long, so it gets the whole first line rather than a 1.6fr column. */}
      <ul className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => (
          <li key={row.id} className="rounded-card border border-border bg-surface p-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-caption break-all text-text">{row.url}</div>
                {row.description === null ? null : (
                  <div className="text-caption text-text-2">{row.description}</div>
                )}
              </div>
              <span className="flex-none">
                <StateBadge states={ENDPOINT_STATES} state={row.status} />
              </span>
            </div>

            <div className="mt-2.5 flex flex-wrap gap-1">
              {row.events.map((event) => (
                <CodeChip key={event}>{event}</CodeChip>
              ))}
            </div>

            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-caption text-text-2">
              <span>
                {formatPercent(row.successRate7d)} success · 7d ·{' '}
                {formatLastDelivery(row.lastDeliveryAt, timeZone)}
              </span>
              <span className="flex gap-1.5">
                <Link
                  to={`/settings/webhooks/${row.id}/deliveries`}
                  className={ICON_BUTTON}
                  title="Delivery log"
                  aria-label={`Delivery log for ${row.url}`}
                >
                  <Icon name="lists" size={14} strokeWidth={2} />
                </Link>
                <Link
                  to={`/settings/webhooks/${row.id}`}
                  className={ICON_BUTTON}
                  title="Edit"
                  aria-label={`Edit ${row.url}`}
                >
                  <PencilIcon />
                </Link>
              </span>
            </div>
          </li>
        ))}
      </ul>

      <div className="hidden md:block">
        <DataTable
          label="Webhook endpoints"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          rowMuted={(row) => row.status === 'paused'}
        />
      </div>
      {overlays}
    </>
  );
}

/**
 * The strip over J4a when we have stopped sending somewhere.
 *
 * It names the host and the last response, because "an endpoint failed" is
 * not something anyone can act on, and it says the events are replayable so
 * nobody assumes they are gone and starts a backfill by hand.
 */
function AutoDisabledBanner({
  endpoints,
  timeZone,
}: {
  endpoints: readonly WebhookEndpoint[];
  timeZone: string | null;
}) {
  const first = endpoints[0] as WebhookEndpoint;
  const host = hostOf(first.url);
  const response = first.lastResponse ?? null;
  const since = first.disabledAt;

  return (
    <Banner
      tone="warning"
      icon="alert"
      title={`${endpoints.length} endpoint${endpoints.length === 1 ? ' was' : 's were'} auto-disabled`}
      body={
        <>
          after {first.consecutiveFailures} consecutive failures ({host}
          {response === null ? '' : `, last response ${statusLineCode(response)}`}). Events since{' '}
          {formatDayTime(since, timeZone).replace(',', '')} were not delivered and can be replayed
          for 7 days.
        </>
      }
      action={{ label: 'View delivery log', href: `/settings/webhooks/${first.id}/deliveries` }}
      Link={BannerLink}
    />
  );
}

function BannerLink({ href, children, className, title }: LinkProps) {
  return (
    <Link to={href} className={className} title={title}>
      {children}
    </Link>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "HTTP/1.1 503 Service Unavailable" → "503". */
function statusLineCode(response: string): string {
  return /\b(\d{3})\b/u.exec(response)?.[1] ?? response;
}

/* ------------------------------------------------------------------ */
/* Adding an endpoint, and its secret                                  */
/* ------------------------------------------------------------------ */

function AddEndpointDialog({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  onClose: () => void;
  onCreated: (created: CreatedWebhookEndpoint) => void;
}) {
  const queryClient = useQueryClient();
  const types = useQuery({
    queryKey: platformKeys.webhookEventTypes(workspaceId),
    queryFn: () => webhookEndpointsApi.eventTypes(),
  });

  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  const create = useMutation({
    mutationFn: () =>
      webhookEndpointsApi.create({
        url: url.trim(),
        events: selected,
        ...(description.trim() === '' ? {} : { description: description.trim() }),
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: platformKeys.webhooks(workspaceId) });
      onCreated(created);
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title="Add endpoint"
      description="We sign every request and retry it 6 times over 24 hours."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={url.trim() === '' || selected.length === 0}
            pending={create.isPending}
          >
            Add endpoint
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-ui">
        <Field
          label="Endpoint URL"
          placeholder="https://api.example.com/relayd/events"
          help="HTTPS only. Respond 2xx within 10 seconds."
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Field
          label="Description"
          placeholder="Production CRM · delivery + engagement sync"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <EventPicker
          eventTypes={types.data?.eventTypes ?? []}
          loading={types.isPending}
          selected={selected}
          onChange={setSelected}
        />
        {create.isError ? (
          <p role="alert" className="text-ui text-danger-text">
            {create.error instanceof ApiError ? create.error.message : 'That did not work.'}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** The signing secret, shown once. */
function NewSecretDialog({
  endpoint,
  onClose,
}: {
  endpoint: CreatedWebhookEndpoint;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title="Signing secret"
      description={endpoint.url}
      footer={
        <Button onClick={onClose}>I&apos;ve stored it</Button>
      }
    >
      <RevealOnce
        label="Signing secret"
        masked={endpoint.secretMasked ?? maskSecret(endpoint.secretShownOnce)}
        secret={endpoint.secretShownOnce}
        phase="revealed"
        size="lg"
        acknowledgeLabel="Hide"
        onAcknowledge={onClose}
        warning={
          <>
            <span className="font-semibold">This is the only time the secret is shown.</span> Verify
            the <span className="font-mono">Relayd-Signature</span> header with it: we sign{' '}
            <span className="font-mono">{'{timestamp}.{body}'}</span> with HMAC-SHA256 over the raw
            body.
          </>
        }
      />
    </Modal>
  );
}

function maskSecret(secret: string): string {
  return `${secret.slice(0, 11)}${'•'.repeat(22)}`;
}

/* ------------------------------------------------------------------ */
/* J4b — the edit drawer                                               */
/* ------------------------------------------------------------------ */

function EventPicker({
  eventTypes,
  loading,
  selected,
  onChange,
}: {
  eventTypes: readonly string[];
  loading: boolean;
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const groups = groupEvents(eventTypes);
  const everything = selected.includes('*');

  const toggle = (event: string, next: boolean) =>
    onChange(next ? [...selected, event] : selected.filter((held) => held !== event));

  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-medium">
        Events{' '}
        <span className="font-normal text-text-2">
          · {everything ? 'all' : selected.length} selected
        </span>
      </span>

      <div className="overflow-hidden rounded-control border border-border">
        {loading ? (
          <p className="px-3.5 py-2.5 text-caption text-text-2">Loading event types…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2.5">
              <CheckChip
                value="*"
                checked={everything}
                onChange={(next) => onChange(next ? ['*'] : [])}
                title="Everything, including events we add later"
              />
              <span className="text-caption text-text-2">
                Everything, including events we add later.
              </span>
            </div>
            {groups.map((group) => (
              <div key={group.label} className="flex flex-col gap-2 border-b border-border px-3.5 py-2.5 last:border-b-0">
                <GroupLabel>{group.label}</GroupLabel>
                <div className="flex flex-wrap gap-1.5">
                  {group.events.map((event) => (
                    <CheckChip
                      key={event}
                      value={event}
                      checked={!everything && selected.includes(event)}
                      disabled={everything}
                      onChange={(next) => toggle(event, next)}
                      {...(everything ? { title: 'This endpoint already receives every event' } : {})}
                    />
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function EditEndpointDrawer({
  workspaceId,
  endpoint,
  onClose,
}: {
  workspaceId: string;
  endpoint: WebhookEndpoint;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const readOnly = useReadOnly();
  const types = useQuery({
    queryKey: platformKeys.webhookEventTypes(workspaceId),
    queryFn: () => webhookEndpointsApi.eventTypes(),
  });

  const [url, setUrl] = useState(endpoint.url);
  const [description, setDescription] = useState(endpoint.description ?? '');
  const [events, setEvents] = useState<string[]>(endpoint.events);
  const [enabled, setEnabled] = useState(!isOff(endpoint));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [rotated, setRotated] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: platformKeys.webhooks(workspaceId) });

  const save = useMutation({
    mutationFn: () =>
      webhookEndpointsApi.update(endpoint.id, {
        url: url.trim(),
        events,
        description: description.trim() === '' ? null : description.trim(),
        status: enabled ? 'active' : 'paused',
      }),
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });

  const rotate = useMutation({
    mutationFn: () => webhookEndpointsApi.rotateSecret(endpoint.id),
    onSuccess: async (result) => {
      await invalidate();
      setRotated(result.secretShownOnce);
    },
  });

  const test = useMutation({
    // BACKEND PENDING: POST /webhook-endpoints/:id/test
    mutationFn: () => webhookEndpointsApi.sendTest(endpoint.id),
  });

  const remove = useMutation({
    mutationFn: () => webhookEndpointsApi.remove(endpoint.id),
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });

  const writeTitle = readOnly ? READ_ONLY_TITLE : undefined;

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        size="md"
        title="Edit endpoint"
        subtitle={<span className="font-mono">{endpoint.id}</span>}
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={readOnly}
              title={writeTitle}
              className="inline-flex h-[34px] cursor-pointer items-center rounded-control border border-transparent bg-transparent px-3 text-ui font-medium text-danger-text hover:bg-danger-soft disabled:cursor-not-allowed disabled:text-text-3"
            >
              Delete endpoint
            </button>
            <span className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => test.mutate()}
                pending={test.isPending}
                disabled={readOnly}
                title={writeTitle}
              >
                {test.isSuccess ? 'Test sent' : 'Send test event'}
              </Button>
              <Button
                onClick={() => save.mutate()}
                pending={save.isPending}
                disabled={readOnly || url.trim() === '' || events.length === 0}
                title={writeTitle}
              >
                Save
              </Button>
            </span>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field
            label="Endpoint URL"
            help="HTTPS only. Respond 2xx within 10 seconds."
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={readOnly}
          />
          <Field
            label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={readOnly}
          />

          <EventPicker
            eventTypes={types.data?.eventTypes ?? []}
            loading={types.isPending}
            selected={events}
            onChange={setEvents}
          />

          <RevealOnce
            label="Signing secret"
            masked={endpoint.secretMasked ?? 'whsec_••••••••••••••••••••••••'}
            {...(rotated === null ? {} : { secret: rotated })}
            phase={rotated === null ? 'masked' : 'revealed'}
            onAcknowledge={() => setRotated(null)}
            actions={
              <Button
                variant="secondary"
                onClick={() => rotate.mutate()}
                pending={rotate.isPending}
                disabled={readOnly}
                title={writeTitle}
              >
                Rotate
              </Button>
            }
            footnote={
              // One element, not three: RevealOnce lays the footnote out with
              // flex, so loose text nodes would each become a flex item and
              // wrap on their own.
              <span>
                Created {formatDate(endpoint.secretCreatedAt ?? endpoint.createdAt)}. Verify{' '}
                <span className="font-mono">Relayd-Signature</span> with HMAC-SHA256 over the raw
                body.
              </span>
            }
            warning={
              <>
                <span className="font-semibold">This is the only time the new secret is shown.</span>{' '}
                The previous one keeps working for 24 hours, so you can deploy without a gap.
              </>
            }
          />

          <div className="rounded-control border border-border px-3.5 py-3">
            <Switch
              label={
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">Endpoint enabled</span>
                  <span className="text-caption text-text-2">
                    Disabled endpoints keep their config; events are not queued.
                  </span>
                </span>
              }
              checked={enabled}
              onChange={setEnabled}
              disabled={readOnly}
              {...(writeTitle === undefined ? {} : { title: writeTitle })}
            />
          </div>

          {save.isError ? (
            <p role="alert" className="text-ui text-danger-text">
              {save.error instanceof ApiError ? save.error.message : 'That did not work.'}
            </p>
          ) : null}
        </div>
      </Drawer>

      <ConfirmDestructive
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        onConfirm={() => remove.mutate()}
        title="Delete this endpoint?"
        confirmLabel="Delete endpoint"
        pending={remove.isPending}
      >
        <p>
          We stop sending to <span className="font-mono">{endpoint.url}</span> immediately and its
          signing secret is destroyed. Undelivered events are dropped, not held.
        </p>
        <p className="mt-2">
          To stop delivery without losing the configuration, turn the endpoint off instead.
        </p>
      </ConfirmDestructive>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* J4c — the delivery log                                              */
/* ------------------------------------------------------------------ */

/** The schedule every event follows. Design copy, not a server value. */
const RETRY_SCHEDULE: readonly { attempt: string; when: string }[] = [
  { attempt: 'Attempt 1', when: 'immediately' },
  { attempt: 'Attempt 2', when: '+1 min' },
  { attempt: 'Attempt 3', when: '+5 min' },
  { attempt: 'Attempt 4', when: '+30 min' },
  { attempt: 'Attempt 5', when: '+2 h' },
  { attempt: 'Attempt 6', when: '+24 h' },
];

const STATUS_FILTERS: readonly { value: string; label: string }[] = [
  { value: 'delivered', label: 'Delivered' },
  { value: 'failed', label: 'Failed' },
  { value: 'pending', label: 'Pending' },
  { value: 'abandoned', label: 'Abandoned' },
];

export function WebhookDeliveriesPage() {
  const { current } = useAuth();
  const workspaceId = current?.workspaceId ?? 'none';
  const readOnly = useReadOnly();
  const { id = '' } = useParams<{ id: string }>();
  const workspace = useWorkspaceRecord();
  const queryClient = useQueryClient();

  const endpoints = useQuery({
    queryKey: platformKeys.webhooks(workspaceId),
    queryFn: () => webhookEndpointsApi.list(),
  });

  const endpoint = endpoints.data?.find((row) => row.id === id) ?? null;

  /**
   * A log opened because something broke opens on the failures. Somebody
   * who wanted the whole thing clears the chip; somebody debugging a 503
   * should not have to add a filter before they can see it.
   */
  const [status, setStatus] = useState<string | null>(null);
  const [statusTouched, setStatusTouched] = useState(false);
  const effectiveStatus =
    statusTouched || endpoint === null ? status : isOff(endpoint) ? 'failed' : null;

  const deliveries = useQuery({
    queryKey: platformKeys.webhookDeliveries(workspaceId, id, effectiveStatus ?? 'all'),
    queryFn: () =>
      // BACKEND PENDING: GET /webhook-endpoints/:id/deliveries?status=
      webhookEndpointsApi.deliveries(id, {
        limit: 50,
        ...(effectiveStatus === null ? {} : { status: effectiveStatus }),
      }),
    enabled: id !== '',
  });

  const replay = useMutation({
    // BACKEND PENDING: POST /webhook-endpoints/:id/replay
    mutationFn: () => webhookEndpointsApi.replay(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: platformKeys.webhooks(workspaceId) });
    },
  });

  const test = useMutation({
    // BACKEND PENDING: POST /webhook-endpoints/:id/test
    mutationFn: () => webhookEndpointsApi.sendTest(id),
  });

  const rows = deliveries.data?.deliveries ?? [];
  const total = deliveries.data?.total ?? null;
  const timeZone = workspace.data?.timezone ?? null;

  const columns: readonly Column<WebhookDelivery>[] = useMemo(
    () => [
      {
        key: 'time',
        header: 'Time',
        width: '150px',
        cell: (row) => (
          <span className="whitespace-nowrap">
            {formatDayTimeSeconds(row.deliveredAt ?? row.createdAt, timeZone)}
          </span>
        ),
      },
      {
        key: 'event',
        header: 'Event',
        cell: (row) => (
          <div className="min-w-0">
            <div className="truncate font-mono text-caption">{row.eventType}</div>
            <div className="truncate font-mono text-label text-text-3">{row.eventId}</div>
          </div>
        ),
      },
      {
        key: 'result',
        header: 'Result',
        width: '120px',
        cell: (row) => <ResultBadge delivery={row} />,
      },
      {
        key: 'attempt',
        header: 'Attempt',
        width: '80px',
        align: 'right',
        cell: (row) => <span className="text-text-2">{row.attempt}</span>,
      },
      {
        key: 'duration',
        header: 'Duration',
        width: '110px',
        align: 'right',
        cell: (row) => (
          <span className="whitespace-nowrap text-text-2">
            {row.durationMs === null ? '—' : `${formatCount(row.durationMs)} ms`}
          </span>
        ),
      },
      {
        key: 'next',
        header: 'Next retry',
        width: '120px',
        cell: (row) => (
          <span className="text-text-2">{row.nextRetryLabel ?? '—'}</span>
        ),
      },
    ],
    [timeZone],
  );

  const back = (
    <Link to="/settings/webhooks" className="text-ui font-medium text-brand no-underline">
      ← Webhooks
    </Link>
  );

  if (endpoints.isPending) {
    return (
      <>
        <PageHeader back={back} title="Delivery log" />
        <TableSkeleton rows={6} tabs={false} label="Loading deliveries" />
      </>
    );
  }

  if (endpoint === null) {
    return (
      <>
        <PageHeader back={back} title="Delivery log" />
        <ErrorState
          title="We couldn't load this endpoint"
          description="It may have been deleted. Go back to the list to see what is there now."
          requestId={endpoints.error instanceof ApiError ? endpoints.error.requestId : undefined}
          actions={
            <Link to="/settings/webhooks" className="no-underline">
              <Button variant="secondary">Back to webhooks</Button>
            </Link>
          }
          onRetry={() => void endpoints.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  const undelivered = endpoint.undeliveredCount ?? null;

  /** The filter strip, shared by the table's toolbar and the mobile list. */
  const toolbar = (
    <>
      {effectiveStatus === null ? null : (
        <span className="inline-flex h-7 items-center gap-1.5 rounded-badge border border-border bg-tint px-2 text-caption">
          Status <span className="font-medium">{labelFor(effectiveStatus)}</span>
          <button
            type="button"
            aria-label="Clear the status filter"
            onClick={() => {
              setStatusTouched(true);
              setStatus(null);
            }}
            className="cursor-pointer border-0 bg-transparent p-0 text-text-2"
          >
            <Icon name="x" size={12} strokeWidth={2} />
          </button>
        </span>
      )}
      <label className="inline-flex h-7 items-center rounded-badge border border-dashed border-border px-2 text-caption text-text-2">
        <span className="sr-only">Filter by status</span>
        <select
          value=""
          onChange={(event) => {
            setStatusTouched(true);
            setStatus(event.target.value === '' ? null : event.target.value);
          }}
          className="cursor-pointer appearance-none border-0 bg-transparent p-0 text-caption text-text-2 outline-none"
        >
          <option value="">+ Filter</option>
          {STATUS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <span className="ml-auto text-caption text-text-2">
        {rows.length === 0
          ? 'No deliveries'
          : `Showing 1–${rows.length}${total === null ? '' : ` of ${formatCount(total)}`} deliveries`}
      </span>
    </>
  );

  const emptyBlock = deliveries.isError ? (
    <ErrorState
      size="table"
      title="We couldn't load the delivery log"
      description="Event delivery is unaffected; only this list failed to load."
      requestId={deliveries.error instanceof ApiError ? deliveries.error.requestId : undefined}
      onRetry={() => void deliveries.refetch()}
      retryLabel="Retry"
    />
  ) : (
    <EmptyState
      size="table"
      icon="webhooks"
      title="Nothing delivered yet"
      description="Deliveries appear here as events happen. Send a test event to check the endpoint end to end."
    />
  );

  return (
    <>
      <PageHeader
        back={back}
        // 20/1.2/600 mono, not the 24px page title: J4c measures it smaller
        // because the URL is long and is the identifier, not a heading.
        title={<span className="font-mono text-section">{endpoint.url}</span>}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            {endpoint.description ?? 'No description'}
            <StateBadge states={ENDPOINT_STATES} state={endpoint.status} />
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => test.mutate()}
              pending={test.isPending}
              disabled={readOnly}
              title={readOnly ? READ_ONLY_TITLE : undefined}
            >
              {test.isSuccess ? 'Test sent' : 'Send test event'}
            </Button>
            {isOff(endpoint) ? (
              <Button
                onClick={() => replay.mutate()}
                pending={replay.isPending}
                disabled={readOnly}
                title={readOnly ? READ_ONLY_TITLE : undefined}
              >
                {undelivered === null
                  ? 'Re-enable'
                  : `Re-enable and replay ${formatCount(undelivered)} events`}
              </Button>
            ) : null}
          </div>
        }
      />

      {isAutoDisabled(endpoint) ? (
        <div className="mb-4">
          <Banner
            tone="warning"
            icon="alert"
            title={`Auto-disabled on ${formatInstant(endpoint.disabledAt, timeZone)}`}
            body={
              <>
                after {endpoint.consecutiveFailures} consecutive failures. Undelivered events are
                kept for 7 days
                {endpoint.replayableUntil === null || endpoint.replayableUntil === undefined
                  ? ''
                  : ` (until ${formatDayMonth(endpoint.replayableUntil, timeZone)})`}
                . Fix the endpoint, then re-enable to replay them in order.
              </>
            }
          />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
        {deliveries.isPending ? (
          <TableSkeleton rows={6} tabs={false} label="Loading deliveries" />
        ) : (
        <>
        {/* Mobile: the filter strip, then one card per delivery. Six columns
            at 390px is a table nobody reads. */}
        <div className="md:hidden">
          <div className="mb-3 flex flex-wrap items-center gap-2">{toolbar}</div>
          <ul className="flex flex-col gap-3">
            {rows.map((row) => (
              <li key={row.id} className="rounded-card border border-border bg-surface p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-caption text-text">{row.eventType}</div>
                    <div className="font-mono text-label text-text-3">{row.eventId}</div>
                  </div>
                  <span className="flex-none">
                    <ResultBadge delivery={row} />
                  </span>
                </div>
                <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-caption text-text-2">
                  <span>{formatDayTimeSeconds(row.deliveredAt ?? row.createdAt, timeZone)}</span>
                  <span>Attempt {row.attempt}</span>
                  <span>{row.durationMs === null ? '—' : `${formatCount(row.durationMs)} ms`}</span>
                  {row.nextRetryLabel === null || row.nextRetryLabel === undefined ? null : (
                    <span>Next retry: {row.nextRetryLabel}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {rows.length > 0 ? null : <div className="rounded-card border border-border bg-surface">{emptyBlock}</div>}
        </div>

        <div className="hidden md:block">
        <DataTable
          label="Deliveries"
          columns={columns}
          rows={rows}
          rowKey={(row) => String(row.id)}
          toolbar={toolbar}
          empty={emptyBlock}
        />
        </div>
        </>
        )}
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <div className="mb-3 text-card font-semibold leading-heading">Retry schedule</div>
            <div className="flex flex-col gap-2">
              {RETRY_SCHEDULE.map((row) => (
                <div key={row.attempt} className="flex items-center justify-between gap-3 text-ui">
                  <span className="text-text-2">{row.attempt}</span>
                  <span className="font-medium">{row.when}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 mb-0 text-caption text-text-2">
              After 6 failed attempts an event is marked failed. 50 consecutive failed events
              disable the endpoint. Any 2xx resets the counter.
            </p>
          </Card>

          {endpoint.lastResponse === null || endpoint.lastResponse === undefined ? null : (
            <Card>
              <div className="mb-3 text-card font-semibold leading-heading">Last response</div>
              <pre className="m-0 overflow-x-auto rounded-control border border-border bg-tint px-3 py-2.5 font-mono text-caption leading-[1.7] text-text">
                {endpoint.lastResponse}
              </pre>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function labelFor(value: string): string {
  return STATUS_FILTERS.find((option) => option.value === value)?.label ?? value;
}

/** J4c's Result column: the code the server actually returned, or why not. */
function ResultBadge({ delivery }: { delivery: WebhookDelivery }) {
  if (delivery.status === 'pending') return <Badge tone="neutral">Pending</Badge>;

  if (delivery.responseCode !== null) {
    return (
      <Badge tone={delivery.status === 'delivered' ? 'success' : 'danger'}>
        {delivery.responseCode}
      </Badge>
    );
  }

  return <Badge tone="danger">{delivery.error ?? 'Failed'}</Badge>;
}
