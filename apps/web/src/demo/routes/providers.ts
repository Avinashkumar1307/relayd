import type { Route, Row } from '../state.js';
import { find, id, nowIso, state } from '../state.js';
import { identities, senderDns, verifiedDns } from '../data/providers.js';

/**
 * Section E demo routes: provider connections, identities, senders, DNS.
 *
 * DEMO ONLY. Creating a connection answers with an ingest URL because the
 * real API does: webhook ingest is per connection, so the endpoint token is
 * minted with it and shown exactly once (CLAUDE.md section 11). Nothing
 * here ever reads a credential back — there is no route that could.
 *
 * The DNS routes have no backend yet (BACKEND PENDING: GET and POST
 * /senders/:id/dns), so they answer from the fixtures. "Check DNS now"
 * deliberately returns the same records: in the frame the DKIM record is
 * still missing, and a preview that healed itself on click would teach the
 * wrong thing about propagation.
 */

const domainOf = (email: string): string => email.split('@')[1] ?? 'northwind.travel';

function dnsFor(senderId: string): unknown {
  const stored = senderDns[senderId];
  if (stored !== undefined) return stored;

  const sender = find(state.senders, senderId);
  const email = typeof sender?.['fromEmail'] === 'string' ? sender['fromEmail'] : '';
  return verifiedDns(senderId, domainOf(email));
}

export const routes: Route[] = [
  { method: 'GET', pattern: /^\/providers$/u, handler: () => state.connections },
  {
    method: 'POST',
    pattern: /^\/providers$/u,
    handler: (_m, body) => {
      const input = body as { name: string; providerType: string };
      const connectionId = id('prv_');
      const row: Row = {
        id: connectionId,
        providerType: input.providerType,
        name: input.name,
        status: 'active',
        hasWebhookSecret: input.providerType !== 'smtp',
        lastVerifiedAt: nowIso(),
        lastError: null,
        quotaSnapshot: { max24Hour: 50_000, sentLast24Hours: 0, maxSendRate: 14 },
        capabilities: {
          supportsWebhooks: input.providerType !== 'smtp',
          reportsQuota: true,
          maxBatchSize: 50,
        },
        createdAt: nowIso(),
        quotaNote: '0% used · resets 00:00 UTC',
        webhook: {
          state: input.providerType === 'smtp' ? 'best_effort' : 'not_configured',
          label: input.providerType === 'smtp' ? 'Best-effort · no webhooks' : 'Not configured',
          detail:
            input.providerType === 'smtp'
              ? 'No webhooks · delivery is inferred from the SMTP response only'
              : 'No endpoint configured · bounces and complaints will not reach Relayd',
        },
        last24h: { accepted: 0, note: 'accepted by the provider' },
      };
      state.connections.unshift(row);

      return {
        ...row,
        ingestUrl: `https://hooks.relayd.io/in/${connectionId}/9f2c1a7e4b3d8c5f2a1e6b9d0c4f7a2e`,
        warnings:
          input.providerType === 'ses'
            ? ['This SES account is in the sandbox. Sends go only to verified addresses until AWS grants production access.']
            : [],
      };
    },
  },
  {
    method: 'GET',
    pattern: /^\/providers\/([^/]+)\/identities$/u,
    handler: (m) => identities.filter((row) => row.providerId === m[1]),
  },
  {
    method: 'POST',
    pattern: /^\/providers\/([^/]+)\/identities\/sync$/u,
    handler: (m) => identities.filter((row) => row.providerId === m[1]),
  },
  // BACKEND PENDING: POST /providers/:id/ingest/test
  {
    method: 'POST',
    pattern: /^\/providers\/([^/]+)\/ingest\/test$/u,
    handler: () => ({ sent: true }),
  },
  {
    method: 'POST',
    pattern: /^\/providers\/([^/]+)\/(verify|rotate)$/u,
    handler: (m) => {
      const row = find(state.connections, m[1] ?? '');
      if (row !== undefined) {
        row['status'] = 'active';
        row['lastVerifiedAt'] = nowIso();
        row['lastError'] = null;
      }
      return row ?? {};
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/providers\/([^/]+)$/u,
    handler: (m, body) => {
      const row = find(state.connections, m[1] ?? '');
      if (row !== undefined) Object.assign(row, body as object);
      return row ?? {};
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/providers\/([^/]+)$/u,
    handler: (m) => {
      state.connections = state.connections.filter((row) => row.id !== m[1]);
      state.senders = state.senders.filter((row) => row['providerId'] !== m[1]);
      return {};
    },
  },
  {
    method: 'GET',
    pattern: /^\/providers\/([^/]+)$/u,
    handler: (m) => find(state.connections, m[1] ?? '') ?? state.connections[0],
  },

  { method: 'GET', pattern: /^\/senders$/u, handler: () => state.senders },
  // BACKEND PENDING: GET /senders/:id/dns — declared before /senders/:id so
  // the literal segment wins.
  { method: 'GET', pattern: /^\/senders\/([^/]+)\/dns$/u, handler: (m) => dnsFor(m[1] ?? '') },
  // BACKEND PENDING: POST /senders/:id/dns/check
  { method: 'POST', pattern: /^\/senders\/([^/]+)\/dns\/check$/u, handler: (m) => dnsFor(m[1] ?? '') },
  {
    method: 'POST',
    pattern: /^\/senders\/([^/]+)\/test$/u,
    handler: () => ({ jobId: 'job_demo_test', queued: 1 }),
  },
  {
    method: 'POST',
    pattern: /^\/senders$/u,
    handler: (_m, body) => {
      const input = body as {
        fromEmail: string;
        fromName: string;
        providerId: string;
        identityId: string;
        replyTo?: string;
      };
      const row: Row = {
        id: id('snd_'),
        providerId: input.providerId,
        identityId: input.identityId,
        fromEmail: input.fromEmail,
        fromName: input.fromName,
        replyTo: input.replyTo ?? null,
        status: 'active',
        dailyLimit: null,
        hourlyLimit: null,
        healthScore: 100,
        consecutiveFailures: 0,
        cooldownUntil: null,
        lastSendAt: null,
      };
      state.senders.push(row);
      return row;
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/senders\/([^/]+)$/u,
    handler: (m, body) => {
      const row = find(state.senders, m[1] ?? '');
      if (row !== undefined) Object.assign(row, body as object);
      return row ?? {};
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/senders\/([^/]+)$/u,
    handler: (m) => {
      state.senders = state.senders.filter((row) => row.id !== m[1]);
      return {};
    },
  },
];

/** SPA paths the demo smoke test walks for this section. */
export const previewPaths: string[] = [
  '/providers',
  '/providers/connect',
  '/senders',
  '/senders/snd_members',
];
