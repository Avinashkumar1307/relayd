import { api, apiRequestEnvelope } from './client.js';

/**
 * API keys and outbound webhook endpoints — section J parts 3 and 4.
 *
 * Both have a one-time reveal, and the shape of these types says so: the
 * secret appears on the response that creates it and on no other. There is no
 * `get` that returns one, because there is nothing stored that could answer.
 *
 * Several fields below are marked BACKEND PENDING. The J frames show more
 * than `apps/api` returns today — an environment on a key, a 7-day success
 * rate and a replay window on an endpoint — and every one of them is
 * optional here, so the pages render against the real API (without those
 * columns filled) and against the preview backend (with them) from one type.
 */

/** J3a/J3b: `rk_live_…` or `rk_test_…`. */
export type ApiKeyEnvironment = 'live' | 'test';

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** BACKEND PENDING: POST/GET /api-keys — the live/test split J3a draws. */
  environment?: ApiKeyEnvironment | undefined;
  /** BACKEND PENDING: "HubSpot · created by Omar Haddad" under the name. */
  integration?: string | null | undefined;
  createdByName?: string | null | undefined;
  revokedByName?: string | null | undefined;
}

/** The create response, and the only one that ever carries the key. */
export interface IssuedApiKey extends ApiKey {
  keyShownOnce: string;
}

/**
 * The four states J4a draws.
 *
 * `disabled` is ours — fifty consecutive failures stopped it — and shows as
 * "Auto-disabled" in warning. `paused` is the customer's own switch and
 * shows as "Disabled" in neutral. Conflating them would hide which of the
 * two happened, and only one of them is something to fix.
 */
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
  /** BACKEND PENDING: GET /webhook-endpoints — J4a's "Success · 7d" column. */
  successRate7d?: number | null | undefined;
  /** BACKEND PENDING: J4a's "Last delivery" column. */
  lastDeliveryAt?: string | null | undefined;
  /** BACKEND PENDING: J4a's masked secret and J4b's "Created 2 Jun 2026". */
  secretMasked?: string | undefined;
  secretCreatedAt?: string | null | undefined;
  /** BACKEND PENDING: J4c — what a re-enable would replay, and until when. */
  undeliveredCount?: number | null | undefined;
  replayableUntil?: string | null | undefined;
  /** BACKEND PENDING: J4c's "Last response" card. */
  lastResponse?: string | null | undefined;
}

export interface CreatedWebhookEndpoint extends WebhookEndpoint {
  secretShownOnce: string;
}

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'abandoned';

export interface WebhookDelivery {
  id: number;
  eventType: string;
  eventId: string;
  attempt: number;
  status: WebhookDeliveryStatus;
  responseCode: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number | null;
  scheduledFor: string;
  deliveredAt: string | null;
  createdAt: string;
  /** BACKEND PENDING: J4c's "Next retry" column — "+30 min", "Endpoint disabled". */
  nextRetryLabel?: string | null | undefined;
}

/** What `deliveries()` hands back, whichever shape the server sent. */
export interface WebhookDeliveryPage {
  deliveries: WebhookDelivery[];
  /** J4c prints "Showing 1–8 of 1,334". Null when the server does not count. */
  total: number | null;
}

export const platformKeys = {
  apiKeys: (workspaceId: string) => ['api-keys', workspaceId] as const,
  apiKeyScopes: (workspaceId: string) => ['api-keys', workspaceId, 'scopes'] as const,
  webhooks: (workspaceId: string) => ['webhook-endpoints', workspaceId] as const,
  webhookEventTypes: (workspaceId: string) => ['webhook-endpoints', workspaceId, 'event-types'] as const,
  webhookDeliveries: (workspaceId: string, endpointId: string, status: string) =>
    ['webhook-endpoints', workspaceId, endpointId, 'deliveries', status] as const,
};

export const apiKeysApi = {
  list: () => api.get<ApiKey[]>('/api-keys'),

  /** Their role intersected with what a key may ever hold. Never billing. */
  scopes: () => api.get<{ scopes: string[] }>('/api-keys/scopes'),

  create: (input: {
    name: string;
    scopes: string[];
    expiresInDays?: number;
    // BACKEND PENDING: POST /api-keys { environment } — ignored by apps/api today.
    environment?: ApiKeyEnvironment;
  }) => api.post<IssuedApiKey>('/api-keys', input),

  revoke: (id: string) => api.delete<{ revoked: boolean }>(`/api-keys/${id}`),
};

export const webhookEndpointsApi = {
  list: () => api.get<WebhookEndpoint[]>('/webhook-endpoints'),

  eventTypes: () => api.get<{ eventTypes: string[] }>('/webhook-endpoints/event-types'),

  create: (input: { url: string; events: string[]; description?: string }) =>
    api.post<CreatedWebhookEndpoint>('/webhook-endpoints', input),

  update: (
    id: string,
    input: {
      url?: string;
      events?: string[];
      description?: string | null;
      status?: 'active' | 'paused';
    },
  ) => api.patch<WebhookEndpoint>(`/webhook-endpoints/${id}`, input),

  rotateSecret: (id: string) =>
    api.post<CreatedWebhookEndpoint>(`/webhook-endpoints/${id}/rotate-secret`, {}),

  remove: (id: string) => api.delete<void>(`/webhook-endpoints/${id}`),

  /**
   * The delivery log.
   *
   * `apps/api` answers a bare array; J4c needs a total and a status filter,
   * so the richer object shape is accepted too and the array is normalised
   * into it. Both are handled here rather than in the page, which should not
   * have to know which server it is talking to.
   *
   * BACKEND PENDING: GET /webhook-endpoints/:id/deliveries?status= and a total.
   */
  deliveries: async (
    id: string,
    input: { limit?: number; status?: string } = {},
  ): Promise<WebhookDeliveryPage> => {
    const envelope = await apiRequestEnvelope<WebhookDelivery[] | WebhookDeliveryPage>(
      `/webhook-endpoints/${id}/deliveries`,
      { method: 'GET', query: { ...input } },
    );

    const body = envelope.data;
    return Array.isArray(body) ? { deliveries: body, total: null } : body;
  },

  // BACKEND PENDING: POST /webhook-endpoints/:id/test — J4b and J4c's "Send test event".
  sendTest: (id: string) => api.post<{ sent: boolean }>(`/webhook-endpoints/${id}/test`, {}),

  // BACKEND PENDING: POST /webhook-endpoints/:id/replay — J4c's re-enable and replay.
  replay: (id: string) => api.post<{ replaying: number }>(`/webhook-endpoints/${id}/replay`, {}),
};
