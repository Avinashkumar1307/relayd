import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiKeysApi,
  webhookEndpointsApi,
  type ApiKey,
  type WebhookDelivery,
  type WebhookEndpoint,
} from '../../api/platform.js';
import { ApiError } from '../../api/client.js';
import {
  Badge,
  Button,
  Cell,
  EmptyState,
  LoadError,
  Loading,
  Page,
  Table,
  formatDate,
} from '../../components/ui.js';

/**
 * API keys and outbound webhooks (BUILD-PLAN Phase 9).
 *
 * The page exists to do one thing well: hand over a credential exactly once,
 * in a way the person cannot miss and cannot half-copy. Everything else here
 * is in service of that.
 *
 * Two details are not decoration. The reveal panel says plainly that it will
 * not be shown again, because a person who assumes they can come back for it
 * will close the dialog. And a revoked key stays in the list, because the
 * question after a leak is "was it revoked, and when", and a list that hides
 * them answers with silence.
 */

export function ApiSettingsPage() {
  return (
    <Page
      title="API and webhooks"
      description="Credentials for integrating with Relayd, and where we send events."
    >
      <ApiKeysSection />
      <WebhookEndpointsSection />
    </Page>
  );
}

// ------------------------------------------------------------------ keys

function ApiKeysSection() {
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => apiKeysApi.list() });
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ name: string; key: string } | null>(null);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">API keys</h2>
        <Button onClick={() => setCreating(true)}>Create key</Button>
      </div>

      {issued !== null && <RevealPanel
        title={`Key for ${issued.name}`}
        value={issued.key}
        onDismiss={() => setIssued(null)}
      />}

      {creating && (
        <CreateKeyDialog
          onClose={() => setCreating(false)}
          onIssued={(name, key) => {
            setIssued({ name, key });
            setCreating(false);
          }}
        />
      )}

      {keys.isPending && <Loading label="Loading keys…" />}
      {keys.isError && <LoadError error={keys.error} onRetry={() => void keys.refetch()} />}

      {keys.data?.length === 0 && (
        <EmptyState title="No API keys">
          <p>Create one to call Relayd from your own code.</p>
        </EmptyState>
      )}

      {keys.data !== undefined && keys.data.length > 0 && (
        <Table columns={['Name', 'Key', 'Scopes', 'Last used', '']}>
          {keys.data.map((key) => (
            <ApiKeyRow key={key.id} apiKey={key} />
          ))}
        </Table>
      )}
    </section>
  );
}

function ApiKeyRow({ apiKey }: { apiKey: ApiKey }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const revoke = useMutation({
    mutationFn: () => apiKeysApi.revoke(apiKey.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      setConfirming(false);
    },
  });

  const revoked = apiKey.revokedAt !== null;

  return (
    <tr className="border-t border-slate-100">
      <Cell>
        {apiKey.name}
        {revoked && (
          <span className="ml-2">
            <Badge tone="bad">Revoked {formatDate(apiKey.revokedAt)}</Badge>
          </span>
        )}
      </Cell>
      <Cell muted>
        <code className="font-mono text-xs">{apiKey.keyPrefix}…</code>
      </Cell>
      <Cell muted>{apiKey.scopes.join(', ')}</Cell>
      <Cell muted>{apiKey.lastUsedAt === null ? 'Never' : formatDate(apiKey.lastUsedAt)}</Cell>
      <Cell>
        {!revoked &&
          (confirming ? (
            <span className="flex gap-2">
              <Button variant="danger" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
                {revoke.isPending ? 'Revoking…' : 'Confirm'}
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button variant="secondary" onClick={() => setConfirming(true)}>
              Revoke
            </Button>
          ))}
      </Cell>
    </tr>
  );
}

function CreateKeyDialog({
  onClose,
  onIssued,
}: {
  onClose: () => void;
  onIssued: (name: string, key: string) => void;
}) {
  const queryClient = useQueryClient();
  const scopes = useQuery({ queryKey: ['api-keys', 'scopes'], queryFn: () => apiKeysApi.scopes() });

  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  const create = useMutation({
    mutationFn: () => apiKeysApi.create({ name, scopes: selected }),
    onSuccess: async (issued) => {
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      onIssued(issued.name, issued.keyShownOnce);
    },
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create API key"
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-5">
        <h3 className="text-sm font-semibold text-slate-900">Create API key</h3>

        <label className="block text-sm">
          <span className="text-slate-700">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="CI deploy"
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1"
          />
        </label>

        {scopes.isPending && <Loading label="Loading scopes…" />}
        {scopes.isError && <LoadError error={scopes.error} />}

        {scopes.data !== undefined && (
          <fieldset className="space-y-1">
            {/*
              Only what this person's own role can grant. Offering a scope the
              POST will refuse is a form the user cannot complete and cannot
              see why.
            */}
            <legend className="text-sm text-slate-700">Scopes</legend>
            {scopes.data.scopes.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(scope)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, scope]
                        : current.filter((held) => held !== scope),
                    )
                  }
                />
                <code className="font-mono text-xs">{scope}</code>
              </label>
            ))}
          </fieldset>
        )}

        {create.isError && (
          <p role="alert" className="text-sm text-red-700">
            {create.error instanceof ApiError ? create.error.message : 'That did not work.'}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={name.trim() === '' || selected.length === 0 || create.isPending}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- webhooks

function WebhookEndpointsSection() {
  const endpoints = useQuery({
    queryKey: ['webhook-endpoints'],
    queryFn: () => webhookEndpointsApi.list(),
  });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ url: string; value: string } | null>(null);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Webhook endpoints</h2>
        <Button onClick={() => setCreating(true)}>Add endpoint</Button>
      </div>

      {secret !== null && (
        <RevealPanel
          title={`Signing secret for ${secret.url}`}
          value={secret.value}
          onDismiss={() => setSecret(null)}
        >
          <p>
            Verify the <code className="font-mono">Relayd-Signature</code> header with this. We
            sign <code className="font-mono">{'{timestamp}.{body}'}</code> with HMAC-SHA256 and
            send it as <code className="font-mono">t=…,v1=…</code>.
          </p>
        </RevealPanel>
      )}

      {creating && (
        <CreateEndpointDialog
          onClose={() => setCreating(false)}
          onCreated={(url, value) => {
            setSecret({ url, value });
            setCreating(false);
          }}
        />
      )}

      {endpoints.isPending && <Loading label="Loading endpoints…" />}
      {endpoints.isError && (
        <LoadError error={endpoints.error} onRetry={() => void endpoints.refetch()} />
      )}

      {endpoints.data?.length === 0 && (
        <EmptyState title="No webhook endpoints">
          <p>Add one to be told when a campaign finishes or an email bounces.</p>
        </EmptyState>
      )}

      {endpoints.data?.map((endpoint) => (
        <EndpointCard key={endpoint.id} endpoint={endpoint} onRotated={setSecret} />
      ))}
    </section>
  );
}

function EndpointCard({
  endpoint,
  onRotated,
}: {
  endpoint: WebhookEndpoint;
  onRotated: (secret: { url: string; value: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [showingDeliveries, setShowingDeliveries] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] });

  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'paused') =>
      webhookEndpointsApi.update(endpoint.id, { status }),
    onSuccess: invalidate,
  });

  const rotate = useMutation({
    mutationFn: () => webhookEndpointsApi.rotateSecret(endpoint.id),
    onSuccess: async (result) => {
      await invalidate();
      onRotated({ url: result.url, value: result.secretShownOnce });
    },
  });

  const remove = useMutation({
    mutationFn: () => webhookEndpointsApi.remove(endpoint.id),
    onSuccess: invalidate,
  });

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="font-mono text-sm text-slate-900">{endpoint.url}</p>
          <p className="text-xs text-slate-600">{endpoint.events.join(', ')}</p>
        </div>
        <EndpointStatus endpoint={endpoint} />
      </div>

      {endpoint.status === 'disabled' && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <p className="font-medium">We stopped sending to this endpoint.</p>
          <p className="mt-1">
            {endpoint.disabledReason ??
              'It failed too many times in a row.'}{' '}
            Fix it and choose Resume — nothing that happened while it was disabled is resent.
          </p>
        </div>
      )}

      {endpoint.status === 'failing' && (
        <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          The last {endpoint.consecutiveFailures} deliveries failed. We are still trying, and we
          will stop if this continues.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => setStatus.mutate(endpoint.status === 'paused' ? 'active' : 'paused')}
          disabled={setStatus.isPending}
        >
          {endpoint.status === 'paused' || endpoint.status === 'disabled' ? 'Resume' : 'Pause'}
        </Button>
        <Button variant="secondary" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
          {rotate.isPending ? 'Rotating…' : 'Rotate secret'}
        </Button>
        <Button variant="secondary" onClick={() => setShowingDeliveries((shown) => !shown)}>
          {showingDeliveries ? 'Hide deliveries' : 'Recent deliveries'}
        </Button>
        <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
          Delete
        </Button>
      </div>

      {endpoint.secretRotatedAt !== null && (
        <p className="text-xs text-slate-500">
          Secret rotated {formatDate(endpoint.secretRotatedAt)}. The previous secret keeps working
          for 24 hours, so you can deploy without a gap.
        </p>
      )}

      {showingDeliveries && <Deliveries endpointId={endpoint.id} />}
    </div>
  );
}

function EndpointStatus({ endpoint }: { endpoint: WebhookEndpoint }) {
  const tone =
    endpoint.status === 'active'
      ? 'good'
      : endpoint.status === 'failing'
        ? 'warn'
        : endpoint.status === 'disabled'
          ? 'bad'
          : 'neutral';

  return <Badge tone={tone}>{endpoint.status}</Badge>;
}

function Deliveries({ endpointId }: { endpointId: string }) {
  const deliveries = useQuery({
    queryKey: ['webhook-endpoints', endpointId, 'deliveries'],
    queryFn: () => webhookEndpointsApi.deliveries(endpointId, { limit: 25 }),
  });

  if (deliveries.isPending) return <Loading label="Loading deliveries…" />;
  if (deliveries.isError) return <LoadError error={deliveries.error} />;

  if (deliveries.data.length === 0) {
    return <p className="text-sm text-slate-600">Nothing delivered to this endpoint yet.</p>;
  }

  return (
    <Table columns={['Event', 'Status', 'Attempt', 'Response', 'When']}>
      {deliveries.data.map((delivery) => (
        <tr key={delivery.id} className="border-t border-slate-100">
          <Cell>{delivery.eventType}</Cell>
          <Cell>
            <Badge tone={deliveryTone(delivery)}>{delivery.status}</Badge>
          </Cell>
          <Cell muted>{delivery.attempt}</Cell>
          <Cell muted>
            {/*
              The response, not just the status. An integrator debugging a
              missing event needs what their own server said, and "it failed"
              is not something they can act on.
            */}
            {delivery.responseCode ?? delivery.error ?? '—'}
          </Cell>
          <Cell muted>{formatDate(delivery.deliveredAt ?? delivery.createdAt)}</Cell>
        </tr>
      ))}
    </Table>
  );
}

function deliveryTone(delivery: WebhookDelivery): 'neutral' | 'good' | 'warn' | 'bad' {
  if (delivery.status === 'delivered') return 'good';
  if (delivery.status === 'pending') return 'neutral';
  if (delivery.status === 'abandoned') return 'bad';
  return 'warn';
}

function CreateEndpointDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (url: string, secret: string) => void;
}) {
  const queryClient = useQueryClient();
  const types = useQuery({
    queryKey: ['webhook-endpoints', 'event-types'],
    queryFn: () => webhookEndpointsApi.eventTypes(),
  });

  const [url, setUrl] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  const create = useMutation({
    mutationFn: () => webhookEndpointsApi.create({ url, events: selected }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] });
      onCreated(created.url, created.secretShownOnce);
    },
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add webhook endpoint"
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-5">
        <h3 className="text-sm font-semibold text-slate-900">Add webhook endpoint</h3>

        <label className="block text-sm">
          <span className="text-slate-700">URL</span>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/hooks/relayd"
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 font-mono text-xs"
          />
          <span className="mt-1 block text-xs text-slate-500">
            Must be https and reachable from the internet.
          </span>
        </label>

        {types.isPending && <Loading label="Loading event types…" />}
        {types.isError && <LoadError error={types.error} />}

        {types.data !== undefined && (
          <fieldset className="max-h-48 space-y-1 overflow-y-auto">
            <legend className="text-sm text-slate-700">Events</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes('*')}
                onChange={(event) => setSelected(event.target.checked ? ['*'] : [])}
              />
              <span>Everything, including events we add later</span>
            </label>
            {types.data.eventTypes.map((type) => (
              <label key={type} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={selected.includes('*')}
                  checked={selected.includes(type)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, type]
                        : current.filter((held) => held !== type),
                    )
                  }
                />
                <code className="font-mono text-xs">{type}</code>
              </label>
            ))}
          </fieldset>
        )}

        {create.isError && (
          <p role="alert" className="text-sm text-red-700">
            {create.error instanceof ApiError ? create.error.message : 'That did not work.'}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={url.trim() === '' || selected.length === 0 || create.isPending}
          >
            {create.isPending ? 'Adding…' : 'Add'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- the reveal

/**
 * The one-time reveal.
 *
 * Says plainly that it will not be shown again, because a person who assumes
 * they can come back for it will close this and be wrong. The copy button is
 * there so nobody half-selects a 50-character string, and the dismiss is
 * explicit rather than a click-outside for the same reason.
 */
export function RevealPanel({
  title,
  value,
  onDismiss,
  children,
}: {
  title: string;
  value: string;
  onDismiss: () => void;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div
      role="alert"
      className="space-y-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4"
    >
      <div>
        <p className="text-sm font-semibold text-emerald-900">{title}</p>
        <p className="text-sm text-emerald-900">
          Copy this now. We store only a hash of it, so we cannot show it to you again — not here,
          and not if you ask support.
        </p>
      </div>

      <code className="block overflow-x-auto rounded border border-emerald-200 bg-white px-3 py-2 font-mono text-xs text-slate-900">
        {value}
      </code>

      {children !== undefined && <div className="text-xs text-emerald-900">{children}</div>}

      <div className="flex gap-2">
        <Button
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="secondary" onClick={onDismiss}>
          I have saved it
        </Button>
      </div>
    </div>
  );
}
