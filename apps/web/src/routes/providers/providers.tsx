import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  Badge,
  Button,
  ConfirmDestructive,
  EmptyState,
  ErrorState,
  Icon,
  Modal,
  PageHeader,
  Skeleton,
} from '@relayd/ui';
import {
  PROVIDER_INFO,
  providerApi,
  providerKeys,
  type Connection,
  type Sender,
} from '../../api/providers.js';
import { ApiError } from '../../api/client.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { IfPermitted } from '../../auth/guards.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import { CredentialFields } from './credential-fields.js';
import {
  BestEffortBadge,
  CONNECTION_STATES,
  ProviderTile,
  credentialsFrom,
  fmtNumber,
  formatDay,
  initialCredentialValues,
  quotaBarClass,
  quotaOf,
  webhookOf,
} from './provider-ui.js';

/**
 * E1a — Providers.
 *
 * One card per connection rather than a table row: a connection has a health
 * story (quota, throttle, webhook, last 24 hours) and a row of cells reads as
 * four unrelated facts. The card is also where the two things a customer
 * cannot discover anywhere else live — whether events are actually arriving,
 * and what Relayd is throttling them to.
 *
 * A provider secret is never shown after entry. The database stores a Secrets
 * Manager ARN, never the secret (CLAUDE.md section 11), so the only credential
 * affordance here is "Rotate credentials", which writes and never reads.
 */

const READ_ONLY_TITLE = 'Workspace is read-only';

export function ProvidersPage() {
  const navigate = useNavigate();
  const { currentWorkspaceId } = useAuth();
  const readOnly = useReadOnly();
  const workspaceId = currentWorkspaceId ?? 'none';

  // BACKEND PENDING: GET /providers serves no `quotaNote`, `webhook` or
  // `last24h` field. The route is real and every other column is served;
  // `quotaOf` and `webhookOf` derive a fallback from `quotaSnapshot` and
  // `hasWebhookSecret`, so this call needs no change when they arrive.
  const connections = useQuery({
    queryKey: providerKeys.connections(workspaceId),
    queryFn: providerApi.list,
  });

  // The card's "2 senders" line. Counted here rather than asked for, because
  // /senders is a list the sender page needs anyway and the cache is shared.
  const senders = useQuery({
    queryKey: providerKeys.senders(workspaceId),
    queryFn: () => providerApi.listSenders(),
  });

  const connect = (
    <IfPermitted permission="provider:write">
      <Button
        onClick={() => void navigate('/providers/connect')}
        disabled={readOnly}
        title={readOnly ? READ_ONLY_TITLE : undefined}
      >
        <Icon name="plus" size={15} strokeWidth={2.25} />
        Connect provider
      </Button>
    </IfPermitted>
  );

  return (
    <>
      <PageHeader
        title="Providers"
        description="Your own email provider accounts. Relayd sends through them and never carries delivery reputation itself."
        actions={connect}
      />

      {connections.isPending ? (
        <ConnectionsSkeleton />
      ) : connections.isError ? (
        <ErrorState
          size="table"
          className="py-18"
          title="We couldn't load provider connections"
          description="Sending continues through the saved connections. Send support the request ID if it keeps happening."
          requestId={requestIdOf(connections.error)}
          actions={
            <Button variant="secondary" onClick={() => void navigate('/support')}>
              Contact support
            </Button>
          }
          onRetry={() => void connections.refetch()}
          retryLabel="Retry"
        />
      ) : connections.data.length === 0 ? (
        <EmptyState
          icon="plug"
          title="No provider connected"
          description="Relayd sends through your Amazon SES, SendGrid or SMTP account. Connect one to verify a sender and start sending."
          action={connect}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {connections.data.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              senders={senders.data ?? []}
              workspaceId={workspaceId}
            />
          ))}
        </div>
      )}
    </>
  );
}

function requestIdOf(error: unknown): string | undefined {
  return error instanceof ApiError ? error.requestId : undefined;
}

// ------------------------------------------------------------------- card

function ConnectionCard({
  connection,
  senders,
  workspaceId,
}: {
  connection: Connection;
  senders: readonly Sender[];
  workspaceId: string;
}) {
  const info = PROVIDER_INFO[connection.providerType];
  const quota = quotaOf(connection);
  const webhook = webhookOf(connection);
  const state = CONNECTION_STATES[connection.status];
  const attached = senders.filter((sender) => sender.providerId === connection.id).length;

  const [rotating, setRotating] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  return (
    <article
      className={[
        'overflow-hidden rounded-card border bg-surface',
        connection.status === 'degraded' ? 'border-warning' : 'border-border',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-start gap-4 border-b border-border px-5 py-4.5">
        <ProviderTile type={connection.providerType} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-card font-semibold leading-heading">{info.label}</span>
            <span className="text-ui text-text-2">{connection.name}</span>
            <Badge tone={state.tone} pulse={state.pulse}>
              {state.label}
            </Badge>
            {info.bestEffort === true ? <BestEffortBadge /> : null}
          </div>

          <div className="mt-1 flex flex-wrap gap-3 text-ui text-text-2">
            <span>Verified {formatDay(connection.lastVerifiedAt)}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-caption">{connection.id}</span>
            <span aria-hidden="true">·</span>
            <span>{attached === 1 ? '1 sender' : `${attached} senders`}</span>
          </div>

          {connection.lastError === null ? null : (
            <p role="alert" className="mt-2 text-ui text-danger-text">
              {connection.lastError.message ?? 'The last check with the provider failed.'}
            </p>
          )}
        </div>

        <IfPermitted permission="provider:write">
          <CardActions
            connection={connection}
            onRotate={() => setRotating(true)}
            onDisconnect={() => setDisconnecting(true)}
          />
        </IfPermitted>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)]">
        <Cell>
          <div className="flex justify-between gap-2 text-caption text-text-2">
            <span>Daily quota</span>
            <span className="text-text tabular-nums">
              {quota.limit === null
                ? `${fmtNumber(quota.used)} sent`
                : `${fmtNumber(quota.used)} / ${fmtNumber(quota.limit)}`}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-2 bg-neutral-soft">
            <div
              className={`h-full rounded-2 ${quotaBarClass(quota.percent)}`}
              style={{ width: `${quota.percent}%` }}
            />
          </div>
          <div className="mt-1.5 text-caption text-text-2">{quota.note}</div>
        </Cell>

        <Cell>
          <div className="text-caption text-text-2">Per-second limit</div>
          <div className="mt-1 text-section font-semibold leading-heading tabular-nums">
            {connection.quotaSnapshot?.maxSendRate ?? '—'}
            <span className="text-ui font-normal text-text-2"> /s</span>
          </div>
          <div className="mt-1 text-caption text-text-2">Relayd throttles to this</div>
        </Cell>

        <Cell>
          <div className="text-caption text-text-2">Inbound webhook</div>
          <div className="mt-1.5 flex items-center gap-2">
            <Badge tone={webhook.state.tone} pulse={webhook.state.pulse}>
              {webhook.state.label}
            </Badge>
          </div>
          <div className="mt-1.5 text-caption text-text-2">{webhook.detail}</div>
        </Cell>

        <Cell last>
          <div className="text-caption text-text-2">Last 24 h</div>
          <div className="mt-1 text-section font-semibold leading-heading tabular-nums">
            {connection.last24h === undefined ? fmtNumber(quota.used) : fmtNumber(connection.last24h.accepted)}
          </div>
          <div className="mt-1 text-caption text-text-2">
            {connection.last24h?.note ?? 'accepted by the provider'}
          </div>
        </Cell>
      </div>

      <RotateDialog
        connection={connection}
        workspaceId={workspaceId}
        open={rotating}
        onClose={() => setRotating(false)}
      />

      <DisconnectDialog
        connection={connection}
        workspaceId={workspaceId}
        open={disconnecting}
        onClose={() => setDisconnecting(false)}
      />
    </article>
  );
}

function CardActions({
  connection,
  onRotate,
  onDisconnect,
}: {
  connection: Connection;
  onRotate: () => void;
  onDisconnect: () => void;
}) {
  const readOnly = useReadOnly();
  const title = readOnly ? READ_ONLY_TITLE : undefined;

  return (
    <div className="flex flex-none flex-wrap gap-2">
      <Button
        variant="secondary"
        className="h-8 px-2.5 text-caption"
        disabled={readOnly}
        title={title}
        onClick={onRotate}
      >
        Rotate credentials
      </Button>
      <Button
        variant="secondary"
        className="h-8 px-2.5 text-caption text-danger-text"
        disabled={readOnly}
        title={title ?? `Disconnect ${connection.name}`}
        onClick={onDisconnect}
      >
        Disconnect
      </Button>
    </div>
  );
}

function Cell({ children, last = false }: { children: ReactNode; last?: boolean }) {
  return (
    <div
      className={[
        'px-5 py-3.5',
        'border-b border-border last:border-b-0',
        last ? 'lg:border-b-0' : 'lg:border-r lg:border-b-0',
      ].join(' ')}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

/**
 * Rotate credentials.
 *
 * The old secret is never shown, so this is an entry form, not an edit form.
 * The provider is fixed: rotating is replacing the key behind a connection,
 * and changing the provider would be a different connection with a different
 * ingest token.
 */
function RotateDialog({
  connection,
  workspaceId,
  open,
  onClose,
}: {
  connection: Connection;
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState(() => initialCredentialValues(connection.providerType));
  const credentials = credentialsFrom(connection.providerType, values);

  const rotate = useMutation({
    mutationFn: () => {
      if (credentials === null) throw new Error('Incomplete credentials');
      return providerApi.rotate(connection.id, credentials);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerKeys.connections(workspaceId) });
      setValues(initialCredentialValues(connection.providerType));
      onClose();
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`Rotate credentials for ${PROVIDER_INFO[connection.providerType].label}`}
      description="We verify the new credentials with a dry-run call before saving them. The old ones stop working the moment the new ones are accepted."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => rotate.mutate()}
            disabled={credentials === null}
            pending={rotate.isPending}
          >
            Verify and save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <CredentialFields
          type={connection.providerType}
          values={values}
          disabled={rotate.isPending}
          onChange={(name, value) => setValues((previous) => ({ ...previous, [name]: value }))}
        />
        {rotate.isError ? (
          <p role="alert" className="text-ui text-danger-text">
            {rotate.error instanceof ApiError
              ? rotate.error.message
              : 'The provider rejected these credentials.'}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function DisconnectDialog({
  connection,
  workspaceId,
  open,
  onClose,
}: {
  connection: Connection;
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const disconnect = useMutation({
    mutationFn: () => providerApi.disconnect(connection.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerKeys.connections(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: providerKeys.senders(workspaceId) });
      onClose();
    },
  });

  return (
    <ConfirmDestructive
      open={open}
      onClose={onClose}
      onConfirm={() => disconnect.mutate()}
      pending={disconnect.isPending}
      title={`Disconnect ${PROVIDER_INFO[connection.providerType].label} · ${connection.name}?`}
      confirmLabel="Disconnect"
      confirmPhrase={connection.name}
    >
      Senders on this connection stop working and its inbound webhook URL is
      revoked. Campaigns already sending through it will fail. Reconnecting
      mints a new URL, so you will have to update the provider console again.
    </ConfirmDestructive>
  );
}

// --------------------------------------------------------------- skeleton

function ConnectionsSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading providers" className="flex flex-col gap-4">
      <span className="sr-only">Loading providers</span>
      {[0, 1, 2].map((index) => (
        <div key={index} className="overflow-hidden rounded-card border border-border bg-surface">
          <div className="flex items-start gap-4 border-b border-border px-5 py-4.5">
            <Skeleton width={44} height={44} radius={10} />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton width={220} height={16} />
              <Skeleton width={300} height={12} />
            </div>
            <Skeleton width={230} height={32} radius={8} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-4">
            {[0, 1, 2, 3].map((cell) => (
              <div key={cell} className="flex flex-col gap-2 px-5 py-3.5">
                <Skeleton width={96} height={12} />
                <Skeleton width="70%" height={20} />
                <Skeleton width="55%" height={12} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
