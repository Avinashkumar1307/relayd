import type { Route, Row } from '../state.js';
import { find, id, nowIso, state } from '../state.js';
import {
  eventTypes,
  scopes,
  webhookDeliveries,
  webhookDeliveryTotal,
} from '../data/platform.js';

/**
 * Section J demo routes: API keys and outbound webhook endpoints.
 *
 * DEMO ONLY. Creating either answers with a `...ShownOnce` field, because
 * that is the real contract: the secret is returned once at creation and
 * never again, and both pages have a whole state built around that.
 *
 * Revoking a key stamps `revokedAt` rather than removing the row — a
 * revoked key stays visible in the list, greyed out (J3a's fourth row).
 *
 * The delivery log answers `{ deliveries, total }` rather than a bare
 * array, which is the shape J4c needs for "Showing 1–8 of 1,334" and the
 * one `webhookEndpointsApi.deliveries` normalises both forms into.
 */

const SHOWN_ONCE = 'rk_live_3e9c7a1d5b2f8e4c0a6d9b3f7e1c5a8d2b4f6e0c';

export const routes: Route[] = [
  { method: 'GET', pattern: /^\/api-keys\/scopes$/u, handler: () => ({ scopes }) },
  { method: 'GET', pattern: /^\/api-keys$/u, handler: () => state.apiKeys },
  {
    method: 'POST',
    pattern: /^\/api-keys$/u,
    handler: (_m, body) => {
      const input = body as {
        name: string;
        scopes: string[];
        environment?: 'live' | 'test';
        expiresInDays?: number;
      };
      const environment = input.environment ?? 'live';
      const expiresAt =
        input.expiresInDays === undefined
          ? null
          : new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();

      const row: Row = {
        id: id('key_'),
        name: input.name,
        keyPrefix: environment === 'test' ? 'rk_test_3e9c' : 'rk_live_3e9c',
        environment,
        integration: null,
        createdByName: 'Dana Haddad',
        revokedByName: null,
        scopes: input.scopes,
        lastUsedAt: null,
        expiresAt,
        revokedAt: null,
        createdAt: nowIso(),
      };

      state.apiKeys.unshift(row);
      return { ...row, keyShownOnce: environment === 'test' ? SHOWN_ONCE.replace('live', 'test') : SHOWN_ONCE };
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api-keys\/([^/]+)$/u,
    handler: (m) => {
      const row = find(state.apiKeys, m[1] ?? '');
      if (row !== undefined) {
        row['revokedAt'] = nowIso();
        row['revokedByName'] = 'Dana Haddad';
      }
      return { revoked: true };
    },
  },

  { method: 'GET', pattern: /^\/webhook-endpoints\/event-types$/u, handler: () => ({ eventTypes }) },
  { method: 'GET', pattern: /^\/webhook-endpoints$/u, handler: () => state.webhookEndpoints },
  {
    method: 'POST',
    pattern: /^\/webhook-endpoints$/u,
    handler: (_m, body) => {
      const input = body as { url: string; events: string[]; description?: string };
      const row: Row = {
        id: id('whk_'),
        url: input.url,
        events: input.events,
        status: 'active',
        description: input.description ?? null,
        consecutiveFailures: 0,
        successRate7d: null,
        lastDeliveryAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        disabledAt: null,
        disabledReason: null,
        secretMasked: 'whsec_2f8b••••••••••••••••••••••',
        secretCreatedAt: nowIso(),
        secretRotatedAt: null,
        undeliveredCount: null,
        replayableUntil: null,
        lastResponse: null,
        createdAt: nowIso(),
      };

      state.webhookEndpoints.unshift(row);
      return { ...row, secretShownOnce: 'whsec_2f8bd41c6a09e7523bd8f14c0a6e9375' };
    },
  },
  {
    method: 'GET',
    pattern: /^\/webhook-endpoints\/([^/]+)\/deliveries$/u,
    handler: (_m, _body) => ({ deliveries: webhookDeliveries, total: webhookDeliveryTotal }),
  },
  {
    method: 'POST',
    pattern: /^\/webhook-endpoints\/([^/]+)\/rotate-secret$/u,
    handler: (m) => {
      const row = find(state.webhookEndpoints, m[1] ?? '');
      if (row !== undefined) {
        row['secretRotatedAt'] = nowIso();
        row['secretMasked'] = 'whsec_7e40••••••••••••••••••••••';
      }
      return { ...(row ?? {}), secretShownOnce: 'whsec_7e40b95a2c18df6304ba7e21c9d05f83' };
    },
  },
  {
    method: 'POST',
    pattern: /^\/webhook-endpoints\/([^/]+)\/test$/u,
    handler: () => ({ sent: true }),
  },
  {
    method: 'POST',
    pattern: /^\/webhook-endpoints\/([^/]+)\/replay$/u,
    handler: (m) => {
      const row = find(state.webhookEndpoints, m[1] ?? '');
      const replaying = Number(row?.['undeliveredCount'] ?? 0);
      if (row !== undefined) {
        row['status'] = 'active';
        row['disabledAt'] = null;
        row['disabledReason'] = null;
        row['consecutiveFailures'] = 0;
        row['undeliveredCount'] = null;
      }
      return { replaying };
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/webhook-endpoints\/([^/]+)$/u,
    handler: (m, body) => {
      const row = find(state.webhookEndpoints, m[1] ?? '');
      if (row !== undefined) Object.assign(row, body as object);
      return row ?? {};
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/webhook-endpoints\/([^/]+)$/u,
    handler: (m) => {
      const index = state.webhookEndpoints.findIndex((row) => row.id === m[1]);
      if (index !== -1) state.webhookEndpoints.splice(index, 1);
      return {};
    },
  },
];

/** SPA paths the demo smoke test walks for this section. */
export const previewPaths: string[] = [
  '/settings/api',
  '/settings/api/new',
  '/settings/webhooks',
  '/settings/webhooks/whk_01J7Q2',
  '/settings/webhooks/whk_01J7Q8/deliveries',
];
