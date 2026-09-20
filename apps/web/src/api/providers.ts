import { api } from './client.js';

/**
 * Provider connection and sender endpoints (design section E).
 *
 * The one thing to know reading this: `ingestUrl` comes back from `connect`
 * and from nowhere else. It carries a token that can write events into the
 * workspace, so the UI must show it at that moment or not at all. A provider
 * secret is never read back either — the database stores a Secrets Manager
 * ARN, never the secret (CLAUDE.md section 11) — which is why nothing here
 * has a `getCredentials`.
 *
 * Several fields the E frames draw have no endpoint behind them yet. They are
 * optional on the types below, marked BACKEND PENDING at the call site, and
 * the pages derive a fallback from what the API does return, so the screens
 * are correct the day the fields appear and honest before then.
 */

export type ProviderType = 'ses' | 'sendgrid' | 'mailgun' | 'brevo' | 'smtp' | 'google';

export type ConnectionStatus =
  | 'pending'
  | 'verifying'
  | 'active'
  | 'degraded'
  | 'disabled'
  | 'revoked'
  | 'error';

/** What the "Inbound webhook" cell on E1a says about a connection. */
export type WebhookState = 'receiving' | 'no_events' | 'best_effort' | 'not_configured';

export interface Connection {
  id: string;
  providerType: ProviderType;
  name: string;
  status: ConnectionStatus;
  hasWebhookSecret: boolean;
  lastVerifiedAt: string | null;
  lastError: { kind?: string; message?: string } | null;
  quotaSnapshot: {
    max24Hour?: number | null;
    sentLast24Hours?: number | null;
    maxSendRate?: number | null;
  } | null;
  capabilities: {
    supportsWebhooks?: boolean;
    reportsQuota?: boolean;
    maxBatchSize?: number;
  };
  createdAt: string;

  // ---- BACKEND PENDING: GET /providers does not return these yet ---------
  /** E1a's line under the quota bar, e.g. "82% used · resets 00:00 UTC". */
  quotaNote?: string;
  /** E1a's "Inbound webhook" cell. */
  webhook?: { state: WebhookState; label: string; detail: string };
  /** E1a's "Last 24 h" cell. */
  last24h?: { accepted: number; note: string };
}

export interface ConnectResult extends Connection {
  ingestUrl: string;
  warnings: string[];
}

export interface SenderIdentity {
  id: string;
  providerId: string;
  kind: 'domain' | 'email';
  value: string;
  verificationStatus: 'pending' | 'verified' | 'failed' | 'expired';
  dkimStatus: string | null;
  spfStatus: string | null;
  dmarcStatus: string | null;
  verifiedAt: string | null;
  /** BACKEND PENDING: E2a's sub-line, e.g. "DMARC p=reject · DKIM mismatch". */
  note?: string | null;
}

export interface Sender {
  id: string;
  providerId: string;
  identityId: string;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
  status: 'active' | 'paused' | 'cooling_down' | 'disabled' | 'failed';
  dailyLimit: number | null;
  hourlyLimit: number | null;
  healthScore: number;
  consecutiveFailures: number;
  cooldownUntil: string | null;
  lastSendAt: string | null;
}

/** One row of the E2b drawer. */
export interface DnsRecord {
  kind: 'SPF' | 'DKIM' | 'DMARC';
  /** "authorises the server to send", "signs each message", … */
  purpose: string;
  status: 'verified' | 'pending' | 'failed';
  type: string;
  host: string;
  value: string;
  /** What the last lookup actually found. */
  found: string;
}

export interface SenderDns {
  senderId: string;
  /** The strip under the drawer header, when something is wrong. */
  problem: { title: string; detail: string } | null;
  records: DnsRecord[];
  lastCheckedAt: string;
  nextCheckInMinutes: number;
}

/** Credentials, per provider. Shaped to match the API's discriminated union. */
export type Credentials =
  | { type: 'ses'; accessKeyId: string; secretAccessKey: string; region: string }
  | { type: 'sendgrid'; apiKey: string }
  | { type: 'brevo'; apiKey: string }
  | { type: 'mailgun'; apiKey: string; domain: string; region: 'us' | 'eu' }
  | { type: 'smtp'; host: string; port: number; secure: boolean; user: string; pass: string };

export const providerApi = {
  list: () => api.get<Connection[]>('/providers'),
  get: (id: string) => api.get<Connection>(`/providers/${id}`),

  connect: (input: { providerType: ProviderType; name: string; credentials: Credentials }) =>
    api.post<ConnectResult>('/providers', input),

  rename: (id: string, name: string) => api.patch<Connection>(`/providers/${id}`, { name }),

  verify: (id: string, credentials: Credentials) =>
    api.post<Connection>(`/providers/${id}/verify`, { credentials }),

  rotate: (id: string, credentials: Credentials) =>
    api.post<Connection>(`/providers/${id}/rotate`, { credentials }),

  disconnect: (id: string) => api.delete<void>(`/providers/${id}`),

  /**
   * E1d's "Send test event".
   *
   * The server queues a job that posts a signed synthetic event at this
   * connection's own ingest URL, so what is proved is the whole inbound
   * path — the URL resolves, the signature verifies against this
   * connection's secret, and the event lands. 422 for a provider with no
   * inbound webhooks at all, which is SMTP (D4).
   */
  sendTestEvent: (id: string) => api.post<{ sent: boolean }>(`/providers/${id}/ingest/test`),

  listIdentities: (id: string) => api.get<SenderIdentity[]>(`/providers/${id}/identities`),
  syncIdentities: (id: string, credentials: Credentials) =>
    api.post<{ synced: number }>(`/providers/${id}/identities/sync`, { credentials }),

  listSenders: (providerId?: string) =>
    api.get<Sender[]>('/senders', providerId === undefined ? undefined : { providerId }),

  createSender: (input: {
    providerId: string;
    identityId: string;
    fromEmail: string;
    fromName: string;
    replyTo?: string;
    dailyLimit?: number;
  }) => api.post<Sender>('/senders', input),

  updateSender: (id: string, patch: { fromName?: string; dailyLimit?: number | null }) =>
    api.patch<Sender>(`/senders/${id}`, patch),

  removeSender: (id: string) => api.delete<void>(`/senders/${id}`),

  testSend: (id: string, input: { to: string[]; subject: string }) =>
    api.post<{ jobId: string; queued: number }>(`/senders/${id}/test`, {
      senderId: id,
      ...input,
    }),

  /**
   * The SPF / DKIM / DMARC records behind a sender (E2b).
   *
   * The server reports what the last identity sync stored; it runs no
   * resolver of its own. A record the provider has told us nothing about
   * comes back with an empty `value` and a `found` line saying so, rather
   * than a guess — a DKIM host in particular carries a provider-chosen
   * selector, and a made-up one would never verify.
   */
  senderDns: (id: string) => api.get<SenderDns>(`/senders/${id}/dns`),

  /**
   * E2b's "Check DNS now".
   *
   * Queues the re-check and answers with the state as it stands — the check
   * itself calls the provider, which needs the credential, which the API
   * process cannot read. `nextCheckInMinutes` says when the answer moves.
   */
  checkSenderDns: (id: string) => api.post<SenderDns>(`/senders/${id}/dns/check`),
};

/**
 * Query keys, prefixed with the workspace.
 *
 * Switching workspace clears the cache anyway, but a key that names the
 * tenant it belongs to cannot be served to the wrong one by a race between
 * the switch and an in-flight fetch.
 */
export const providerKeys = {
  connections: (workspaceId: string) => [workspaceId, 'providers'] as const,
  connection: (workspaceId: string, id: string) => [workspaceId, 'providers', id] as const,
  identities: (workspaceId: string, id: string) =>
    [workspaceId, 'providers', id, 'identities'] as const,
  /** Every connection's identities at once, for the sender table. */
  allIdentities: (workspaceId: string, connectionIds: readonly string[]) =>
    [workspaceId, 'providers', 'identities', connectionIds.join(',')] as const,
  senders: (workspaceId: string) => [workspaceId, 'senders'] as const,
  senderDns: (workspaceId: string, id: string) => [workspaceId, 'senders', id, 'dns'] as const,
};

export interface ProviderInfo {
  /** The bold name on a connection card: "Amazon SES", "SMTP". */
  label: string;
  /** The chooser card's heading, which is not always the label: "Any SMTP server". */
  chooser: string;
  /** The letters in the 44px tile. */
  monogram: string;
  /** The chooser card's one-line pitch. */
  blurb: string;
  /** "Needs:" on the chooser card. */
  needs: string;
  /** "Delivery feedback:" on the chooser card. */
  feedback: string;
  /** The note shown while entering credentials, and in the best-effort tooltip. */
  note: string;
  /** D4 — no asynchronous bounce data at all. */
  bestEffort?: boolean;
  available: boolean;
}

/**
 * What each provider is called, and what a customer gives up by choosing it.
 *
 * SMTP's note is D4: without webhooks there is no asynchronous bounce data,
 * so a workspace sending over SMTP accumulates bad addresses invisibly.
 * Saying so at the point of choosing is the whole mitigation, and the badge
 * on E1a repeats it for the person who arrives a month later.
 *
 * Google Workspace is excluded by D6 and so is not available.
 */
export const PROVIDER_INFO: Record<ProviderType, ProviderInfo> = {
  ses: {
    label: 'Amazon SES',
    chooser: 'Amazon SES',
    monogram: 'SES',
    blurb: 'Best for high volume at low cost. Full bounce and complaint events via SNS.',
    needs: 'IAM access key + secret, region',
    feedback: 'Full · via SNS webhook',
    note: 'If the account is in the SES sandbox, Relayd will show a “sandbox” badge and limit sends to verified addresses until production access is granted.',
    available: true,
  },
  sendgrid: {
    label: 'SendGrid',
    chooser: 'SendGrid',
    monogram: 'SG',
    blurb: 'Managed sending with subusers and IP pools. Events via Event Webhook.',
    needs: 'Restricted API key',
    feedback: 'Full · via Event Webhook',
    note: 'Use a restricted API key with Mail Send only. Relayd never needs full access to your SendGrid account.',
    available: true,
  },
  mailgun: {
    label: 'Mailgun',
    chooser: 'Mailgun',
    monogram: 'MG',
    blurb: 'Per-domain sending in a US or EU region. Events via webhooks.',
    needs: 'Sending API key, domain, region',
    feedback: 'Full · via webhooks',
    note: 'Use a sending key scoped to this domain, and pick the region the domain was created in — a key from the other region fails verification.',
    available: true,
  },
  brevo: {
    label: 'Brevo',
    chooser: 'Brevo',
    monogram: 'BR',
    blurb: 'Transactional and marketing sending on one account. Events via webhooks.',
    needs: 'API v3 key',
    feedback: 'Full · via webhooks',
    note: 'Use an API v3 key. Relayd needs it to send and to read the senders you have already verified with Brevo.',
    available: true,
  },
  smtp: {
    label: 'SMTP',
    chooser: 'Any SMTP server',
    monogram: 'SMTP',
    blurb: 'Your own mail server or another relay. Relayd throttles to the limits you set.',
    needs: 'Host, port, TLS, username, password',
    feedback: 'Best-effort · no bounce webhooks',
    note: 'SMTP has no bounce or complaint webhooks. Relayd infers failures from SMTP responses only; sends it cannot confirm are marked delivery uncertain and are not billed.',
    bestEffort: true,
    available: true,
  },
  google: {
    label: 'Google Workspace',
    chooser: 'Google Workspace',
    monogram: 'GW',
    blurb: 'Not available.',
    needs: '—',
    feedback: '—',
    note: 'Google Workspace is not a provider Relayd connects to.',
    available: false,
  },
};

/** The providers the chooser offers, in the order E1b draws them. */
export const PROVIDER_ORDER: readonly ProviderType[] = [
  'ses',
  'sendgrid',
  'smtp',
  'mailgun',
  'brevo',
];

export const CONNECTABLE: readonly ProviderType[] = PROVIDER_ORDER.filter(
  (type) => PROVIDER_INFO[type].available,
);
