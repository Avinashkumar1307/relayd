import { api } from './client.js';

/**
 * Provider connection and sender endpoints.
 *
 * The one thing to know reading this: `ingestUrl` comes back from `connect`
 * and from nowhere else. It carries a token that can write events into the
 * workspace, so the UI must show it at that moment or not at all.
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

  connect: (input: {
    providerType: ProviderType;
    name: string;
    credentials: Credentials;
  }) => api.post<ConnectResult>('/providers', input),

  rename: (id: string, name: string) => api.patch<Connection>(`/providers/${id}`, { name }),

  verify: (id: string, credentials: Credentials) =>
    api.post<Connection>(`/providers/${id}/verify`, { credentials }),

  rotate: (id: string, credentials: Credentials) =>
    api.post<Connection>(`/providers/${id}/rotate`, { credentials }),

  disconnect: (id: string) => api.delete<void>(`/providers/${id}`),

  listIdentities: (id: string) => api.get<SenderIdentity[]>(`/providers/${id}/identities`),
  syncIdentities: (id: string, credentials: Credentials) =>
    api.post<{ synced: number }>(`/providers/${id}/identities/sync`, { credentials }),

  listSenders: (providerId?: string) =>
    api.get<Sender[]>(`/senders${providerId === undefined ? '' : `?providerId=${providerId}`}`),

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
};

export const providerKeys = {
  connections: ['providers'] as const,
  connection: (id: string) => ['providers', id] as const,
  identities: (id: string) => ['providers', id, 'identities'] as const,
  senders: ['senders'] as const,
};

/**
 * What each provider is called, and what a customer gives up by choosing it.
 *
 * SMTP's note is D4: without webhooks there is no asynchronous bounce data at
 * all, so a workspace sending over SMTP accumulates bad addresses invisibly.
 * Saying so at the point of choosing is the whole mitigation.
 */
export const PROVIDER_INFO: Record<
  ProviderType,
  { label: string; note?: string; bestEffort?: boolean; available: boolean }
> = {
  ses: { label: 'Amazon SES', available: true },
  sendgrid: { label: 'SendGrid', available: true },
  smtp: {
    label: 'SMTP',
    bestEffort: true,
    note: 'SMTP gives no delivery feedback, so bounces and complaints are not recorded automatically. Sending over SMTP is best-effort and tracking is reduced.',
    available: true,
  },
  mailgun: { label: 'Mailgun', available: false },
  brevo: { label: 'Brevo', available: false },
  google: { label: 'Google Workspace', available: false },
};
