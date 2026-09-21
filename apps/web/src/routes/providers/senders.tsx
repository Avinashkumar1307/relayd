import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import {
  Badge,
  Button,
  ConfirmDestructive,
  CopyButton,
  DataTable,
  Drawer,
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
import {
  PROVIDER_INFO,
  providerApi,
  providerKeys,
  type Connection,
  type DnsRecord,
  type Sender,
  type SenderIdentity,
} from '../../api/providers.js';
import { ApiError } from '../../api/client.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { IfPermitted } from '../../auth/guards.js';
import { useReadOnly, useWorkspaceRecord } from '../../auth/workspace-state.js';
import { instantLabel } from '../analytics/format.js';
import {
  BestEffortBadge,
  ProviderTile,
  RECORD_STATES,
  SENDER_STATES,
  VERIFICATION_STATES,
  fmtNumber,
  formatDay,
  quotaBarClass,
  quotaOf,
  verificationNote,
} from './provider-ui.js';

/**
 * E2a / E2b — senders.
 *
 * A sender is a From address plus the DNS that lets it be trusted, and the
 * two facts a campaign author cannot get anywhere else are on this page:
 * whether the identity behind the address still passes, and how much of the
 * connection's daily quota is already spoken for. Both decide whether a
 * campaign can launch, and both change without anyone touching Relayd.
 */

const READ_ONLY_TITLE = 'Workspace is read-only';

/**
 * E2a's footer, verbatim.
 *
 * The single most common misreading of this screen is that a sender has a
 * quota; it does not, the connection under it does, so the sentence goes
 * under the table and under the mobile list both.
 */
const SHARED_QUOTA_NOTE =
  "Senders on the same connection share that connection's daily quota. Add a second connection, not a second sender, to get more headroom.";

interface Row {
  sender: Sender;
  connection: Connection | undefined;
  identity: SenderIdentity | undefined;
}

export function SendersPage() {
  const navigate = useNavigate();
  const { senderId } = useParams<{ senderId: string }>();
  const { currentWorkspaceId } = useAuth();
  const readOnly = useReadOnly();
  const workspaceId = currentWorkspaceId ?? 'none';

  const [testFor, setTestFor] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);

  const connections = useQuery({
    queryKey: providerKeys.connections(workspaceId),
    queryFn: providerApi.list,
  });

  const senders = useQuery({
    queryKey: providerKeys.senders(workspaceId),
    queryFn: () => providerApi.listSenders(),
  });

  const connectionIds = (connections.data ?? []).map((connection) => connection.id);

  const identities = useQuery({
    queryKey: providerKeys.allIdentities(workspaceId, connectionIds),
    queryFn: async () => {
      const lists = await Promise.all(connectionIds.map((id) => providerApi.listIdentities(id)));
      return lists.flat();
    },
    enabled: connectionIds.length > 0,
  });

  const byConnection = new Map((connections.data ?? []).map((row) => [row.id, row]));
  const byIdentity = new Map((identities.data ?? []).map((row) => [row.id, row]));

  const rows: Row[] = (senders.data ?? []).map((sender) => ({
    sender,
    connection: byConnection.get(sender.providerId),
    identity: byIdentity.get(sender.identityId),
  }));

  // E2b is a route, not a piece of local state, so the records survive a
  // reload and the URL can be handed to whoever administers the domain.
  const dnsFor = senderId === undefined ? null : (rows.find((row) => row.sender.id === senderId) ?? null);

  const addSender = (
    <IfPermitted permission="provider:write">
      <Button
        onClick={() => setAdding(true)}
        disabled={readOnly || (connections.data ?? []).length === 0}
        title={
          readOnly
            ? READ_ONLY_TITLE
            : (connections.data ?? []).length === 0
              ? 'Connect a provider first'
              : undefined
        }
      >
        <Icon name="plus" size={15} strokeWidth={2.25} />
        Add sender
      </Button>
    </IfPermitted>
  );

  const columns: readonly Column<Row>[] = [
    {
      key: 'from',
      header: 'From',
      width: '22%',
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{row.sender.fromName}</div>
          <div className="truncate text-caption text-text-2">{row.sender.fromEmail}</div>
        </div>
      ),
    },
    {
      key: 'replyTo',
      header: 'Reply-to',
      width: '18%',
      cell: (row) => (
        <div className="truncate text-text-2">{row.sender.replyTo ?? row.sender.fromEmail}</div>
      ),
    },
    {
      key: 'connection',
      header: 'Provider connection',
      width: '18%',
      cell: (row) =>
        row.connection === undefined ? (
          <span className="text-text-2">—</span>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <ProviderTile type={row.connection.providerType} size={24} />
            <span className="truncate">
              {PROVIDER_INFO[row.connection.providerType].label} · {row.connection.name}
            </span>
          </div>
        ),
    },
    {
      key: 'verification',
      header: 'Verification',
      width: '12%',
      cell: (row) => {
        const state = verificationStyle(row.identity);
        return (
          <Badge tone={state.tone} pulse={state.pulse}>
            {state.label}
          </Badge>
        );
      },
    },
    {
      key: 'quota',
      header: 'Daily quota used',
      width: '16%',
      cell: (row) => <QuotaCell row={row} />,
    },
    {
      key: 'actions',
      header: '',
      width: '14%',
      align: 'right',
      cell: (row) => (
        // Side by side, as E2a draws them. The frame's 130px column wraps the
        // second label onto two lines; a little more width keeps both buttons
        // one line tall, which is the same row at 60px and easier to hit.
        <div className="flex justify-end gap-1.5">
          <Button
            variant="secondary"
            className="h-7 px-2 text-caption"
            onClick={() => void navigate(`/senders/${row.sender.id}`)}
          >
            DNS
          </Button>
          <Button
            variant="secondary"
            className="h-7 px-2 text-caption"
            disabled={!isVerified(row.identity) || readOnly}
            title={
              readOnly
                ? READ_ONLY_TITLE
                : isVerified(row.identity)
                  ? 'Send a test email to yourself'
                  : 'Available once verified'
            }
            onClick={() => setTestFor(row)}
          >
            Send test
          </Button>
        </div>
      ),
    },
  ];

  const loading = senders.isPending || connections.isPending;

  return (
    <>
      <PageHeader
        title="Senders"
        description="From identities and their DNS authentication. Only verified senders can be used in a campaign."
        actions={addSender}
      />

      {loading ? (
        <TableSkeleton rows={5} tabs={false} label="Loading senders" />
      ) : senders.isError || connections.isError ? (
        <ErrorState
          size="table"
          className="py-18"
          title="We couldn't load senders"
          description="Verified senders keep working in campaigns. Send support the request ID if it keeps happening."
          requestId={requestIdOf(senders.error ?? connections.error)}
          actions={
            <Button variant="secondary" onClick={() => void navigate('/support')}>
              Contact support
            </Button>
          }
          onRetry={() => {
            void senders.refetch();
            void connections.refetch();
          }}
          retryLabel="Retry"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="senders"
          title="No senders yet"
          description="Add a from address on a connected provider. We generate the SPF, DKIM and DMARC records and verify them for you."
          action={addSender}
        />
      ) : (
        <>
          {/* Mobile (390px): one card per sender. Six columns do not fit, and
              a table that scrolls sideways puts the verification badge — the
              one thing that decides whether this address can send — off the
              right edge. */}
          <ul className="flex list-none flex-col gap-3 p-0 md:hidden">
            {rows.map((row) => (
              <li key={row.sender.id} className="rounded-card border border-border bg-surface p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{row.sender.fromName}</div>
                    <div className="truncate text-caption text-text-2">{row.sender.fromEmail}</div>
                  </div>
                  <span className="flex-none">
                    <Badge
                      tone={verificationStyle(row.identity).tone}
                      pulse={verificationStyle(row.identity).pulse}
                    >
                      {verificationStyle(row.identity).label}
                    </Badge>
                  </span>
                </div>

                {row.connection === undefined ? null : (
                  <div className="mt-2.5 flex min-w-0 items-center gap-1.5 text-caption text-text-2">
                    <ProviderTile type={row.connection.providerType} size={24} />
                    <span className="truncate">
                      {PROVIDER_INFO[row.connection.providerType].label} · {row.connection.name}
                    </span>
                  </div>
                )}

                <div className="mt-1 truncate text-caption text-text-2">
                  reply-to {row.sender.replyTo ?? row.sender.fromEmail}
                </div>

                <div className="mt-2.5">
                  <QuotaCell row={row} />
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Button
                    variant="secondary"
                    className="h-7 px-2 text-caption"
                    onClick={() => void navigate(`/senders/${row.sender.id}`)}
                  >
                    DNS
                  </Button>
                  <Button
                    variant="secondary"
                    className="h-7 px-2 text-caption"
                    disabled={!isVerified(row.identity) || readOnly}
                    title={
                      readOnly
                        ? READ_ONLY_TITLE
                        : isVerified(row.identity)
                          ? 'Send a test email to yourself'
                          : 'Available once verified'
                    }
                    onClick={() => setTestFor(row)}
                  >
                    Send test
                  </Button>
                </div>
              </li>
            ))}
            <li className="px-1 text-caption text-text-2">{SHARED_QUOTA_NOTE}</li>
          </ul>

          <div className="hidden md:block">
            <DataTable
              label="Senders"
              columns={columns}
              rows={rows}
              rowKey={(row) => row.sender.id}
              footer={<span>{SHARED_QUOTA_NOTE}</span>}
            />
          </div>
        </>
      )}

      {dnsFor === null ? null : (
        <DnsDrawer
          row={dnsFor}
          workspaceId={workspaceId}
          onClose={() => void navigate('/senders')}
          onTest={() => setTestFor(dnsFor)}
        />
      )}

      {testFor === null ? null : (
        <TestSendDialog row={testFor} onClose={() => setTestFor(null)} />
      )}

      <AddSenderDialog
        open={adding}
        workspaceId={workspaceId}
        connections={connections.data ?? []}
        identities={identities.data ?? []}
        onClose={() => setAdding(false)}
      />
    </>
  );
}

function requestIdOf(error: unknown): string | undefined {
  return error instanceof ApiError ? error.requestId : undefined;
}

function isVerified(identity: SenderIdentity | undefined): boolean {
  return identity?.verificationStatus === 'verified';
}

function verificationStyle(identity: SenderIdentity | undefined) {
  if (identity === undefined) return VERIFICATION_STATES.unknown;
  return VERIFICATION_STATES[identity.verificationStatus];
}

/**
 * The quota a sender draws on.
 *
 * It belongs to the connection, not the sender: two senders on one SES
 * connection are one 50,000/day bucket, and the footer of the table says so
 * because it is the single most common misreading of this screen.
 */
function QuotaCell({ row }: { row: Row }) {
  const connectionQuota = row.connection === undefined ? null : quotaOf(row.connection);

  // A sender whose identity has failed verification has drawn nothing from
  // the connection's bucket and cannot: E2a's last row is "0 / 100,000" on
  // the same SendGrid connection whose other sender reads "12,930 / 100,000".
  const failed = row.identity?.verificationStatus === 'failed';
  const quota =
    connectionQuota === null ? null : failed ? { ...connectionQuota, used: 0, percent: 0 } : connectionQuota;

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-2 bg-neutral-soft">
          <div
            className={`h-full rounded-2 ${quotaBarClass(quota?.percent ?? 0)}`}
            style={{ width: `${quota?.percent ?? 0}%` }}
          />
        </div>
        <span className="text-caption whitespace-nowrap text-text-2 tabular-nums">
          {quota === null || quota.limit === null
            ? '—'
            : `${fmtNumber(quota.used)} / ${fmtNumber(quota.limit)}`}
        </span>
      </div>
      <div className="mt-[3px] truncate text-label text-text-3">
        {verificationNote(row.identity)}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- E2b drawer

export function DnsDrawer({
  row,
  workspaceId,
  onClose,
  onTest,
}: {
  row: Row;
  workspaceId: string;
  onClose: () => void;
  onTest: () => void;
}) {
  const queryClient = useQueryClient();
  const readOnly = useReadOnly();
  const workspace = useWorkspaceRecord();
  const [removing, setRemoving] = useState(false);
  const state = verificationStyle(row.identity);

  const dns = useQuery({
    queryKey: providerKeys.senderDns(workspaceId, row.sender.id),
    queryFn: () => providerApi.senderDns(row.sender.id),
  });

  const recheck = useMutation({
    mutationFn: () => providerApi.checkSenderDns(row.sender.id),
    onSuccess: (fresh) => {
      queryClient.setQueryData(providerKeys.senderDns(workspaceId, row.sender.id), fresh);
    },
  });

  const remove = useMutation({
    mutationFn: () => providerApi.removeSender(row.sender.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerKeys.senders(workspaceId) });
      setRemoving(false);
      onClose();
    },
  });

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        size="lg"
        title={<span className="text-section">{row.sender.fromName}</span>}
        subtitle={`${row.sender.fromEmail} · reply-to ${row.sender.replyTo ?? row.sender.fromEmail}`}
        headerExtra={
          <>
            <Badge tone={state.tone} pulse={state.pulse}>
              {state.label}
            </Badge>
            {row.connection === undefined ? null : (
              <span className="inline-flex h-[22px] items-center gap-1.5 rounded-badge border border-border px-2 text-caption">
                <ProviderTile type={row.connection.providerType} size={16} />
                {row.connection.name}
              </span>
            )}
            <SenderStateBadge sender={row.sender} />
          </>
        }
        footer={
          <>
            <IfPermitted permission="provider:write" fallback={<span />}>
              <Button
                variant="secondary"
                className="text-danger-text"
                disabled={readOnly}
                title={readOnly ? READ_ONLY_TITLE : undefined}
                onClick={() => setRemoving(true)}
              >
                Remove sender
              </Button>
            </IfPermitted>
            <span className="flex gap-2">
              <Button
                disabled={!isVerified(row.identity)}
                title={isVerified(row.identity) ? undefined : 'Available once verified'}
                variant="secondary"
                onClick={onTest}
              >
                Send test email
              </Button>
              <Button pending={recheck.isPending} onClick={() => recheck.mutate()}>
                Check DNS now
              </Button>
            </span>
          </>
        }
      >
        {dns.isPending ? (
          <p className="text-text-2">Looking up the records…</p>
        ) : dns.isError ? (
          <ErrorState
            size="table"
            title="We couldn't read the DNS records"
            description="The records themselves are unchanged. Try again in a moment."
            requestId={requestIdOf(dns.error)}
            onRetry={() => void dns.refetch()}
            retryLabel="Retry"
          />
        ) : (
          <>
            {dns.data.problem === null ? null : (
              <div className="-mx-5 -mt-4 mb-4 flex items-start gap-2.5 border-b border-warning bg-warning-soft px-5 py-2.5 text-ui">
                <span className="mt-0.5 flex-none text-warning-text">
                  <Icon name="alert" size={16} strokeWidth={2} />
                </span>
                <span>
                  <span className="font-semibold">{dns.data.problem.title}</span>{' '}
                  <span className="text-text-2">{dns.data.problem.detail}</span>
                </span>
              </div>
            )}

            <div className="flex flex-col gap-4">
              {dns.data.records.map((record) => (
                <RecordCard key={record.kind} record={record} />
              ))}

              <p className="m-0 text-caption text-text-2">
                Last checked {instantLabel(dns.data.lastCheckedAt, workspace.data?.timezone ?? null)}{' '}
                · next check in {dns.data.nextCheckInMinutes} minutes
              </p>

              {/* D4. Passing DNS makes this address trusted; it does not make
                  its bounces visible, and that is decided by the connection
                  underneath, not by these records. The drawer header has no
                  room left for a fourth chip, so it is said here. */}
              {row.connection?.providerType === 'smtp' ? (
                <div className="flex flex-wrap items-start gap-2">
                  <BestEffortBadge className="flex-none whitespace-nowrap" />
                  <span className="text-caption text-text-2">
                    SMTP has no bounce or complaint webhooks. Sends Relayd cannot confirm are
                    marked delivery uncertain and are not billed.
                  </span>
                </div>
              ) : null}
            </div>
          </>
        )}
      </Drawer>

      <ConfirmDestructive
        open={removing}
        onClose={() => setRemoving(false)}
        onConfirm={() => remove.mutate()}
        pending={remove.isPending}
        title={`Remove ${row.sender.fromName}?`}
        confirmLabel="Remove sender"
      >
        Campaigns that name this From address will not launch until another sender is chosen. The
        DNS records stay where they are — removing the sender here changes nothing at your DNS host.
      </ConfirmDestructive>
    </>
  );
}

/**
 * The sender's own state, when it is not simply sending.
 *
 * Paired with the date it recovers, because "Cooling down" without a time
 * is a state a campaign author cannot plan around.
 */
function SenderStateBadge({ sender }: { sender: Sender }) {
  if (sender.status === 'active') return null;
  const state = SENDER_STATES[sender.status];

  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={state.tone} pulse={state.pulse}>
        {state.label}
      </Badge>
      {sender.cooldownUntil === null ? null : (
        <span className="text-caption text-text-2">until {formatDay(sender.cooldownUntil)}</span>
      )}
    </span>
  );
}

function RecordCard({ record }: { record: DnsRecord }) {
  const state = RECORD_STATES[record.status];

  return (
    <section className="overflow-hidden rounded-control border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-tint px-3.5 py-2.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-semibold">{record.kind}</span>
          <span className="truncate text-caption text-text-2">{record.purpose}</span>
        </span>
        <Badge tone={state.tone} pulse={state.pulse}>
          {state.label}
        </Badge>
      </div>

      <dl className="m-0 grid grid-cols-[64px_1fr] gap-x-3 gap-y-2 px-3.5 py-3 text-caption">
        <dt className="text-text-2">Type</dt>
        <dd className="m-0 font-mono">{record.type}</dd>

        <dt className="text-text-2">Host</dt>
        <dd className="m-0 flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono">{record.host}</span>
          <CopyButton text={record.host} ariaLabel={`Copy ${record.kind} host`} />
        </dd>

        <dt className="text-text-2">Value</dt>
        <dd className="m-0 flex min-w-0 items-start gap-1.5">
          <span className="min-w-0 flex-1 font-mono break-all">{record.value}</span>
          <CopyButton text={record.value} ariaLabel={`Copy ${record.kind} value`} />
        </dd>

        <dt className="text-text-2">Found</dt>
        <dd className="m-0 text-text-2">{record.found}</dd>
      </dl>
    </section>
  );
}

// ------------------------------------------------- dialogs with no frame

/**
 * A test send.
 *
 * E2a draws the button and not the dialog, and the button's own tooltip
 * says "Send a test email to yourself" — so this asks for one address and
 * nothing else. The endpoint caps the list at five and audits every call.
 */
function TestSendDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const [to, setTo] = useState('');

  const send = useMutation({
    mutationFn: () =>
      providerApi.testSend(row.sender.id, {
        to: [to.trim()],
        subject: `Relayd test from ${row.sender.fromName}`,
      }),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Send a test from ${row.sender.fromName}`}
      description={`One message from ${row.sender.fromEmail}, outside any campaign. It is not billed and it does not appear in reports.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={to.trim() === '' || send.isSuccess}
            pending={send.isPending}
            onClick={() => send.mutate()}
          >
            {send.isSuccess ? 'Sent' : 'Send test'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Send to"
          type="email"
          value={to}
          autoComplete="off"
          placeholder="you@northwind.travel"
          onChange={(event) => setTo(event.target.value)}
        />
        {send.isError ? (
          <p role="alert" className="text-ui text-danger-text">
            {send.error instanceof ApiError ? send.error.message : 'The test send failed.'}
          </p>
        ) : null}
        {send.isSuccess ? (
          <p role="status" className="text-ui text-success-text">
            Queued. Accepted by the provider is not the same as delivered — check the inbox.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * Add a sender.
 *
 * E2a draws the button, not the form. It asks for exactly what POST /senders
 * takes, and the identity list is the one the provider has already verified:
 * a From address on an unverified domain is a campaign that cannot launch.
 */
function AddSenderDialog({
  open,
  workspaceId,
  connections,
  identities,
  onClose,
}: {
  open: boolean;
  workspaceId: string;
  connections: readonly Connection[];
  identities: readonly SenderIdentity[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [providerId, setProviderId] = useState('');
  const [identityId, setIdentityId] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [fromName, setFromName] = useState('');
  const [replyTo, setReplyTo] = useState('');

  const connectionId = providerId === '' ? (connections[0]?.id ?? '') : providerId;
  const available = identities.filter((identity) => identity.providerId === connectionId);
  const chosenIdentity = identityId === '' ? (available[0]?.id ?? '') : identityId;

  const create = useMutation({
    mutationFn: () =>
      providerApi.createSender({
        providerId: connectionId,
        identityId: chosenIdentity,
        fromEmail: fromEmail.trim(),
        fromName: fromName.trim(),
        ...(replyTo.trim() === '' ? {} : { replyTo: replyTo.trim() }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerKeys.senders(workspaceId) });
      setFromEmail('');
      setFromName('');
      setReplyTo('');
      onClose();
    },
  });

  const ready = connectionId !== '' && chosenIdentity !== '' && fromEmail.trim() !== '' && fromName.trim() !== '';

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Add sender"
      description="Pick a connection and one of the identities it has already verified. We generate the SPF, DKIM and DMARC records and verify them for you."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready} pending={create.isPending} onClick={() => create.mutate()}>
            Add sender
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select
          label="Provider connection"
          value={connectionId}
          onChange={(event) => {
            setProviderId(event.target.value);
            setIdentityId('');
          }}
        >
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {PROVIDER_INFO[connection.providerType].label} · {connection.name}
            </option>
          ))}
        </Select>

        <Select
          label="Verified identity"
          value={chosenIdentity}
          help={
            available.length === 0
              ? 'This connection has no verified identity yet. Verify a domain with the provider, then sync.'
              : undefined
          }
          onChange={(event) => setIdentityId(event.target.value)}
        >
          {available.map((identity) => (
            <option key={identity.id} value={identity.id}>
              {identity.value}
            </option>
          ))}
        </Select>

        <Field
          label="From address"
          type="email"
          value={fromEmail}
          autoComplete="off"
          placeholder="hello@northwind.travel"
          onChange={(event) => setFromEmail(event.target.value)}
        />

        <Field
          label="From name"
          value={fromName}
          autoComplete="off"
          placeholder="Northwind Voyages"
          onChange={(event) => setFromName(event.target.value)}
        />

        <Field
          label="Reply-to"
          type="email"
          value={replyTo}
          autoComplete="off"
          placeholder="support@northwind.travel"
          help="Optional. Replies go to the From address when this is empty."
          onChange={(event) => setReplyTo(event.target.value)}
        />

        {create.isError ? (
          <p role="alert" className="text-ui text-danger-text">
            {create.error instanceof ApiError ? create.error.message : 'The sender was not created.'}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
