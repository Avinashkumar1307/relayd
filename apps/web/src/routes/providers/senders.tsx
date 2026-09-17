import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { PROVIDER_INFO, providerApi, providerKeys, type Connection, type Sender } from '../../api/providers.js';
import { IfPermitted } from '../../auth/guards.js';
import { Badge, Button, Cell, EmptyState, LoadError, Loading, Page, Table, formatDate } from '../../components/ui.js';

/**
 * Senders.
 *
 * The two things this page exists to show are the ones a customer cannot see
 * anywhere else: whether the identity behind each From address is still
 * verified with the provider, and what daily limit applies. Both decide
 * whether a campaign can launch, and both change without anyone touching
 * Relayd.
 */

const SENDER_TONE: Record<Sender['status'], 'neutral' | 'good' | 'warn' | 'bad'> = {
  active: 'good',
  paused: 'neutral',
  cooling_down: 'warn',
  disabled: 'neutral',
  failed: 'bad',
};

export function SendersPage() {
  const queryClient = useQueryClient();

  const connections = useQuery({
    queryKey: providerKeys.connections,
    queryFn: providerApi.list,
  });

  const senders = useQuery({
    queryKey: providerKeys.senders,
    queryFn: () => providerApi.listSenders(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => providerApi.removeSender(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: providerKeys.senders });
    },
  });

  const byConnection = new Map<string, Connection>(
    (connections.data ?? []).map((connection) => [connection.id, connection]),
  );

  return (
    <Page
      title="Senders"
      description="The From addresses your campaigns can send from."
    >
      {senders.isPending || connections.isPending ? (
        <Loading />
      ) : senders.isError ? (
        <LoadError error={senders.error} onRetry={() => void senders.refetch()} />
      ) : senders.data.length === 0 ? (
        <EmptyState title="No senders yet">
          Connect a provider and verify a domain with it, then add a From address here.
        </EmptyState>
      ) : (
        <Table
          columns={['From', 'Provider', 'Status', 'Health', 'Daily limit', 'Last sent', '']}
          caption="Senders"
        >
          {senders.data.map((sender) => {
            const connection = byConnection.get(sender.providerId);
            const info = connection === undefined ? null : PROVIDER_INFO[connection.providerType];

            return (
              <tr key={sender.id}>
                <Cell>
                  <div>
                    <div>{sender.fromEmail}</div>
                    <div className="text-xs text-slate-500">{sender.fromName}</div>
                  </div>
                </Cell>

                <Cell muted>
                  {info?.label ?? '—'}
                  {info?.bestEffort === true && (
                    // D4, repeated where a campaign author will actually see
                    // it. A customer choosing a sender is deciding what
                    // tracking they get.
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                      best-effort
                    </span>
                  )}
                </Cell>

                <Cell>
                  <Badge tone={SENDER_TONE[sender.status]}>{sender.status.replace('_', ' ')}</Badge>
                  {sender.cooldownUntil !== null && (
                    <div className="mt-1 text-xs text-slate-500">
                      until {formatDate(sender.cooldownUntil)}
                    </div>
                  )}
                </Cell>

                <Cell>
                  <HealthBar score={sender.healthScore} />
                </Cell>

                <Cell muted>
                  {sender.dailyLimit === null ? (
                    // Not "unlimited": the provider's own cap still applies,
                    // and saying unlimited would be a lie a customer plans a
                    // campaign around.
                    <span title="The provider's own limit still applies">Provider limit</span>
                  ) : (
                    sender.dailyLimit.toLocaleString()
                  )}
                </Cell>

                <Cell muted>{formatDate(sender.lastSendAt)}</Cell>

                <Cell>
                  <IfPermitted permission="provider:write">
                    <div className="flex justify-end">
                      <Button variant="danger" onClick={() => remove.mutate(sender.id)}>
                        Remove
                      </Button>
                    </div>
                  </IfPermitted>
                </Cell>
              </tr>
            );
          })}
        </Table>
      )}

      {connections.data !== undefined && connections.data.length > 0 && (
        <IdentityStatus connections={connections.data} />
      )}
    </Page>
  );
}

/**
 * A 0-100 score, shown as a bar and a number.
 *
 * The number is there because the bar alone cannot be read by anyone using a
 * screen reader, and because "82" is actionable in a way that a slightly
 * shorter bar is not.
 */
function HealthBar({ score }: { score: number }) {
  const tone = score >= 80 ? 'bg-emerald-500' : score >= 50 ? 'bg-amber-500' : 'bg-red-500';

  return (
    <div className="flex items-center gap-2">
      <div
        role="meter"
        aria-valuenow={score}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Sender health"
        className="h-2 w-16 overflow-hidden rounded-full bg-slate-200"
      >
        <div className={`h-full ${tone}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs text-slate-600">{score}</span>
    </div>
  );
}

/**
 * Verification status per connection.
 *
 * An identity can stop being verified without anyone touching Relayd — a DNS
 * record removed, a domain expired — and the first sign is a campaign that
 * will not launch. Showing it here is what turns that into something someone
 * can fix beforehand.
 */
function IdentityStatus({ connections }: { connections: Connection[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-900">Verified identities</h2>
      {connections.map((connection) => (
        <IdentityList key={connection.id} connection={connection} />
      ))}
    </section>
  );
}

function IdentityList({ connection }: { connection: Connection }) {
  const identities = useQuery({
    queryKey: providerKeys.identities(connection.id),
    queryFn: () => providerApi.listIdentities(connection.id),
  });

  if (identities.isPending) return <Loading label={`Loading ${connection.name}…`} />;
  if (identities.isError) return <LoadError error={identities.error} />;

  if (identities.data.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        {connection.name}: no identities found. Verify a domain or address with the provider, then
        sync.
      </p>
    );
  }

  return (
    <Table columns={['Identity', 'Type', 'Status', 'DKIM', 'Verified']} caption={connection.name}>
      {identities.data.map((identity) => (
        <tr key={identity.id}>
          <Cell>{identity.value}</Cell>
          <Cell muted>{identity.kind}</Cell>
          <Cell>
            <Badge
              tone={
                identity.verificationStatus === 'verified'
                  ? 'good'
                  : identity.verificationStatus === 'pending'
                    ? 'neutral'
                    : 'bad'
              }
            >
              {identity.verificationStatus}
            </Badge>
          </Cell>
          <Cell muted>{identity.dkimStatus ?? '—'}</Cell>
          <Cell muted>{formatDate(identity.verifiedAt)}</Cell>
        </tr>
      ))}
    </Table>
  );
}
