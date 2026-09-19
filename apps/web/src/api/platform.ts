import { api } from './client.js';

/**
 * API keys and outbound webhook endpoints.
 *
 * Both have a one-time reveal, and the shape of these types says so: the
 * secret appears on the response that creates it and on no other. There is no
 * `get` that returns one, because there is nothing stored that could answer.
 */

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** The create response, and the only one that ever carries the key. */
export interface IssuedApiKey extends ApiKey {
  keyShownOnce: string;
}

export type WebhookEndpointStatus = 'active' | 'paused' | 'failing' | 'disabled';

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  status: WebhookEndpointStatus;
  description: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  secretRotatedAt: string | null;
  createdAt: string;
}

export interface CreatedWebhookEndpoint extends WebhookEndpoint {
  secretShownOnce: string;
}

export interface WebhookDelivery {
  id: number;
  eventType: string;
  eventId: string;
  attempt: number;
  status: 'pending' | 'delivered' | 'failed' | 'abandoned';
  responseCode: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number | null;
  scheduledFor: string;
  deliveredAt: string | null;
  createdAt: string;
}

export const apiKeysApi = {
  list: () => api.get<ApiKey[]>('/api-keys'),

  /** Their role intersected with what a key may ever hold. */
  scopes: () => api.get<{ scopes: string[] }>('/api-keys/scopes'),

  create: (input: { name: string; scopes: string[]; expiresInDays?: number }) =>
    api.post<IssuedApiKey>('/api-keys', input),

  revoke: (id: string) => api.delete<{ revoked: boolean }>(`/api-keys/${id}`),
};

export const webhookEndpointsApi = {
  list: () => api.get<WebhookEndpoint[]>('/webhook-endpoints'),

  eventTypes: () => api.get<{ eventTypes: string[] }>('/webhook-endpoints/event-types'),

  create: (input: { url: string; events: string[]; description?: string }) =>
    api.post<CreatedWebhookEndpoint>('/webhook-endpoints', input),

  update: (
    id: string,
    input: { url?: string; events?: string[]; description?: string | null; status?: 'active' | 'paused' },
  ) => api.patch<WebhookEndpoint>(`/webhook-endpoints/${id}`, input),

  rotateSecret: (id: string) =>
    api.post<CreatedWebhookEndpoint>(`/webhook-endpoints/${id}/rotate-secret`, {}),

  remove: (id: string) => api.delete<void>(`/webhook-endpoints/${id}`),

  deliveries: (id: string, input: { limit?: number } = {}) =>
    api.get<WebhookDelivery[]>(`/webhook-endpoints/${id}/deliveries`, input),
};
