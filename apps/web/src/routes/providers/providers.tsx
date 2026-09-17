import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PROVIDER_INFO,
  providerApi,
  providerKeys,
  type Connection,
  type ConnectionStatus,
  type Credentials,
  type ProviderType,
} from '../../api/providers.js';
import { IfPermitted } from '../../auth/guards.js';
import { Badge, Button, EmptyState, LoadError, Loading, Page, formatDate } from '../../components/ui.js';

/**
 * Provider connections.
 *
 * Cards rather than a table: a connection has a health story — status, last
 * verified, quota, last error — and a row of cells reads as five unrelated
 * facts. The card is also where the two things a customer cannot discover
 * elsewhere are shown: the one-time ingest URL, and the warnings from
 * verification.
 */

const STATUS_TONE: Record<ConnectionStatus, 'neutral' | 'good' | 'warn' | 'bad'> = {
  pending: 'neutral',
  verifying: 'neutral',
  active: 'good',
  degraded: 'warn',
  disabled: 'neutral',
  revoked: 'bad',
  error: 'bad',
};

export function ProvidersPage() {
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const [justConnected, setJustConnected] = useState<{ name: string; ingestUrl: string; warnings: string[] } | null>(
    null,
  );

  const connections = useQuery({
    queryKey: providerKeys.connections,
    queryFn: providerApi.list,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: providerKeys.connections });
  };

  return (
    <Page
      title="Providers"
      description="Relayd sends through your own provider accounts. We never hold your sending reputation."
      action={
        <IfPermitted permission="provider:write">
          <Button onClick={() => setConnecting(true)}>Connect a provider</Button>
        </IfPermitted>
      }
    >
      {justConnected !== null && (
        <OneTimeIngestUrl details={justConnected} onDismiss={() => setJustConnected(null)} />
      )}

      {connecting && (
        <ConnectForm
          onCancel={() => setConnecting(false)}
          onConnected={(result) => {
            setConnecting(false);
            setJustConnected({
              name: result.name,
              ingestUrl: result.ingestUrl,
              warnings: result.warnings,
            });
            invalidate();
          }}
        />
      )}

      {connections.isPending ? (
        <Loading />
      ) : connections.isError ? (
        <LoadError error={connections.error} onRetry={() => void connections.refetch()} />
      ) : connections.data.length === 0 ? (
        <EmptyState title="No providers connected">
          Connect an SES, SendGrid or SMTP account to start sending.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {connections.data.map((connection) => (
            <ConnectionCard key={connection.id} connection={connection} onChanged={invalidate} />
          ))}
        </div>
      )}
    </Page>
  );
}

/**
 * The ingest URL, shown once.
 *
 * Deliberately loud and deliberately not dismissible by accident. The token in
 * it can write delivery events into this workspace, so it is never readable
 * again — losing it means rotating the connection.
 */
function OneTimeIngestUrl({
  details,
  onDismiss,
}: {
  details: { name: string; ingestUrl: string; warnings: string[] };
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <section className="space-y-3 rounded-lg border-2 border-amber-300 bg-amber-50 p-5">
      <h2 className="text-base font-semibold text-amber-900">
        Copy this webhook URL now — it is not shown again
      </h2>
      <p className="text-sm text-amber-900">
        Paste it into {details.name}&apos;s webhook settings so delivery, bounce and complaint
        events reach Relayd. It is unique to this connection; anyone who has it can send events to
        your workspace, so treat it as a secret. If you lose it, rotate the connection to get a new
        one.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded border border-amber-300 bg-white px-3 py-2 text-xs text-slate-900">
          {details.ingestUrl}
        </code>
        <Button
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(details.ingestUrl);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      {details.warnings.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-amber-900">
          {details.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <Button variant="secondary" onClick={onDismiss}>
        I have copied it
      </Button>
    </section>
  );
}

function ConnectionCard({
  connection,
  onChanged,
}: {
  connection: Connection;
  onChanged: () => void;
}) {
  const info = PROVIDER_INFO[connection.providerType];

  const disconnect = useMutation({
    mutationFn: () => providerApi.disconnect(connection.id),
    onSuccess: onChanged,
  });

  const quota = connection.quotaSnapshot;

  return (
    <article className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">{connection.name}</h2>
          <p className="text-xs text-slate-500">{info.label}</p>
        </div>
        <Badge tone={STATUS_TONE[connection.status]}>{connection.status}</Badge>
      </div>

      {info.bestEffort === true && (
        // D4. Shown on every SMTP card, not only at connect time: the person
        // reading this page a month later is the one planning a campaign.
        <p className="rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-700">{info.note}</p>
      )}

      {connection.lastError !== null && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
          {connection.lastError.message ?? 'The last check failed.'}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-slate-500">Last checked</dt>
        <dd className="text-slate-900">{formatDate(connection.lastVerifiedAt)}</dd>

        <dt className="text-slate-500">Webhook events</dt>
        <dd className="text-slate-900">
          {connection.capabilities.supportsWebhooks === false
            ? 'Not supported'
            : connection.hasWebhookSecret
              ? 'Configured'
              : 'Not configured'}
        </dd>

        {quota != null && quota.max24Hour != null && (
          <>
            <dt className="text-slate-500">Provider daily cap</dt>
            <dd className="text-slate-900">
              {(quota.sentLast24Hours ?? 0).toLocaleString()} / {quota.max24Hour.toLocaleString()}
            </dd>
          </>
        )}
      </dl>

      <IfPermitted permission="provider:write">
        <div className="flex gap-2">
          <Button
            variant="danger"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </div>
        {disconnect.isError && <LoadError error={disconnect.error} />}
      </IfPermitted>
    </article>
  );
}

/**
 * The connect form.
 *
 * The credential fields are per provider, and every one is type="password":
 * these are pasted in shared screens and captured in screen recordings more
 * often than anyone admits.
 */
function ConnectForm({
  onCancel,
  onConnected,
}: {
  onCancel: () => void;
  onConnected: (result: { name: string; ingestUrl: string; warnings: string[] }) => void;
}) {
  const [providerType, setProviderType] = useState<ProviderType>('ses');

  const connect = useMutation({
    mutationFn: (input: { providerType: ProviderType; name: string; credentials: Credentials }) =>
      providerApi.connect(input),
    onSuccess: (result) =>
      onConnected({ name: result.name, ingestUrl: result.ingestUrl, warnings: result.warnings }),
  });

  const info = PROVIDER_INFO[providerType];

  return (
    <section className="space-y-4 rounded-lg border border-slate-300 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-900">Connect a provider</h2>

      <div className="space-y-1">
        <label htmlFor="provider-type" className="block text-sm font-medium text-slate-800">
          Provider
        </label>
        <select
          id="provider-type"
          value={providerType}
          onChange={(event) => setProviderType(event.target.value as ProviderType)}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        >
          {(Object.keys(PROVIDER_INFO) as ProviderType[])
            .filter((type) => PROVIDER_INFO[type].available)
            .map((type) => (
              <option key={type} value={type}>
                {PROVIDER_INFO[type].label}
              </option>
            ))}
        </select>
      </div>

      {info.note !== undefined && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{info.note}</p>
      )}

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const name = String(data.get('name') ?? '').trim();
          const credentials = credentialsFrom(providerType, data);
          if (name === '' || credentials === null) return;

          connect.mutate({ providerType, name, credentials });
        }}
      >
        <Field name="name" label="A name for this connection" placeholder="Production SES" />

        {providerType === 'ses' && (
          <>
            <Field name="accessKeyId" label="Access key ID" secret />
            <Field name="secretAccessKey" label="Secret access key" secret />
            <Field name="region" label="Region" placeholder="eu-west-1" />
          </>
        )}

        {providerType === 'sendgrid' && <Field name="apiKey" label="API key" secret />}

        {providerType === 'smtp' && (
          <>
            <Field name="host" label="Host" placeholder="smtp.example.com" />
            <Field name="port" label="Port" type="number" defaultValue="587" />
            <Field name="user" label="Username" />
            <Field name="pass" label="Password" secret />
            <label className="flex items-center gap-2 text-sm text-slate-800">
              <input type="checkbox" name="secure" />
              Use TLS from the start (port 465)
            </label>
          </>
        )}

        <div className="flex gap-2">
          <Button type="submit" disabled={connect.isPending}>
            {connect.isPending ? 'Checking with the provider…' : 'Connect'}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>

        {connect.isError && <LoadError error={connect.error} />}
      </form>
    </section>
  );
}

function Field({
  name,
  label,
  type = 'text',
  placeholder,
  defaultValue,
  secret,
}: {
  name: string;
  label: string;
  type?: string;
  placeholder?: string;
  defaultValue?: string;
  secret?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={`field-${name}`} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        id={`field-${name}`}
        name={name}
        // Secrets are masked and kept out of autofill and password managers'
        // save prompts: this is a customer's provider credential, not a login.
        type={secret === true ? 'password' : type}
        autoComplete={secret === true ? 'new-password' : 'off'}
        placeholder={placeholder}
        defaultValue={defaultValue}
        required
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
      />
    </div>
  );
}

function credentialsFrom(providerType: ProviderType, data: FormData): Credentials | null {
  const text = (key: string): string => String(data.get(key) ?? '').trim();

  switch (providerType) {
    case 'ses':
      return {
        type: 'ses',
        accessKeyId: text('accessKeyId'),
        secretAccessKey: text('secretAccessKey'),
        region: text('region'),
      };
    case 'sendgrid':
      return { type: 'sendgrid', apiKey: text('apiKey') };
    case 'smtp': {
      const port = Number(text('port'));
      if (!Number.isInteger(port)) return null;
      return {
        type: 'smtp',
        host: text('host'),
        port,
        secure: data.get('secure') !== null,
        user: text('user'),
        pass: text('pass'),
      };
    }
    default:
      return null;
  }
}
