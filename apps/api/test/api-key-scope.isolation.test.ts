// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import { hashToken } from '@relayd/utils';
import { PERMISSIONS } from '@relayd/types';
import type { UserId, WorkspaceId, WorkspaceRole } from '@relayd/types';
import type {
  ApiKeyResolution,
  GlobalApiKeyRepository,
  GlobalMembershipRepository,
} from '@relayd/db';
import { requestContext } from '../src/middleware/authorize.js';
import { errorEnvelope } from '../src/middleware/error-envelope.js';
import { requestId } from '../src/middleware/request-id.js';
import { campaignRoutes } from '../src/routes/campaigns.js';
import { billingRoutes } from '../src/routes/billing.js';
import { apiKeyRoutes } from '../src/routes/api-keys.js';
import { outboundWebhookRoutes } from '../src/routes/outbound-webhooks.js';
import { TokenService } from '../src/services/tokens.js';

/**
 * The Phase 9 gate, as a test: "a read-scoped key cannot write anything".
 *
 * This walks the real route table with a real key rather than testing the
 * middleware in isolation, because the failure it guards against is not a
 * broken check — it is a route somebody mounted without one. A unit test of
 * `requirePermission` passes whether or not it is attached to anything.
 *
 * Two properties, each with its control:
 *
 *   A key holding only read scopes is refused every write, and can still read.
 *   A key is refused key management and billing writes whatever it holds, and
 *   those routes still work for a signed-in owner.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const tokens = new TokenService({
  privateKeyPem: privateKey,
  publicKeyPem: publicKey,
  keyId: 'k1',
  accessTokenTtlSeconds: 900,
});

const WS = 'ws-a' as WorkspaceId;
const USER = 'user-1' as UserId;

const READ_KEY = `rk_live_${'r'.repeat(43)}`;
const FULL_KEY = `rk_live_${'f'.repeat(43)}`;

/** Everything a key could hold. `billing:write` is excluded by the matrix. */
const EVERY_GRANTABLE_SCOPE = PERMISSIONS.filter((permission) => permission !== 'billing:write');

const READ_SCOPES = ['workspace:read', 'contact:read', 'provider:read', 'billing:read'];

function resolutionFor(key: string): ApiKeyResolution | null {
  const base = {
    workspaceId: WS,
    revokedAt: null,
    expiresAt: null,
    createdBy: null,
    lastUsedAt: null,
  };

  if (key === READ_KEY) {
    return { ...base, id: 'key-read', name: 'Read only', scopes: READ_SCOPES };
  }

  if (key === FULL_KEY) {
    return { ...base, id: 'key-full', name: 'Everything', scopes: [...EVERY_GRANTABLE_SCOPE] };
  }

  return null;
}

function buildApp(): Express {
  const repository = {
    async resolve(hash: Buffer) {
      for (const key of [READ_KEY, FULL_KEY]) {
        if (hash.equals(hashToken(key))) return resolutionFor(key);
      }
      return null;
    },
  } as unknown as GlobalApiKeyRepository;

  const apiKeys = { apiKeys: repository };

  const findMembership = vi.fn(async (userId: UserId, workspaceId: WorkspaceId) =>
    userId === USER && workspaceId === WS
      ? {
          workspaceId: WS,
          workspaceName: 'ws',
          workspaceSlug: 'ws',
          role: 'owner' as WorkspaceRole,
        }
      : null,
  );

  const memberships = { findMembership } as unknown as GlobalMembershipRepository;
  const shared = { tokens, memberships, apiKeys };

  /**
   * Every service answers cheerfully, so a 2xx means a guard let it past.
   *
   * A Proxy would be shorter and would also answer to `then`, which makes the
   * object a thenable and hangs the first `await` that touches it.
   */
  const reply = async () => ({ id: 'x', items: [], nextCursor: null, ok: true, revoked: true });

  const permissive = Object.fromEntries(
    [
      'list', 'get', 'create', 'update', 'remove', 'schedule', 'launch', 'lifecycle',
      'retryFailed', 'clone', 'testSend', 'progress', 'listRecipients', 'audiencePreview',
      'issue', 'revoke', 'grantableScopes', 'overview', 'usage', 'invoices',
      'entitlementCheck', 'startCheckout', 'checkoutStatus', 'portalSession',
      'planChangePreview', 'changePlan', 'cancel', 'plans', 'eventTypes',
      'rotateSecret', 'deliveries',
    ].map((name) => [name, reply]),
  );

  const app = express();
  app.use(express.json());
  app.use(requestId);
  app.use(requestContext);

  app.use('/api/v1', campaignRoutes({ ...shared, campaigns: permissive as never }));
  app.use('/api/v1', billingRoutes({ ...shared, billing: permissive as never }));
  app.use(
    '/api/v1',
    apiKeyRoutes({ tokens, memberships, apiKeyAuth: apiKeys, apiKeys: permissive as never }),
  );
  app.use('/api/v1', outboundWebhookRoutes({ ...shared, webhooks: permissive as never }));

  app.use(
    errorEnvelope(
      createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    ),
  );

  return app;
}

interface Route {
  method: 'post' | 'patch' | 'delete';
  path: string;
  body?: Record<string, unknown>;
  /** The scope a correctly-scoped key needs. Absent for key-forbidden routes. */
  scope?: string;
}

/** Mutating routes an external integrator can reach. */
const WRITES: Route[] = [
  { method: 'post', path: '/api/v1/campaigns', body: { name: 'Spring' }, scope: 'campaign:write' },
  { method: 'patch', path: '/api/v1/campaigns/c1', body: { name: 'Autumn' }, scope: 'campaign:write' },
  { method: 'delete', path: '/api/v1/campaigns/c1', scope: 'campaign:write' },
  {
    method: 'post',
    path: '/api/v1/campaigns/c1/launch',
    body: { consentAttested: true },
    scope: 'campaign:launch',
  },
  { method: 'post', path: '/api/v1/campaigns/c1/pause', scope: 'campaign:launch' },
];

/** Routes no key may reach, whatever its scopes. */
const KEY_FORBIDDEN: Route[] = [
  { method: 'post', path: '/api/v1/api-keys', body: { name: 'x', scopes: ['contact:read'] } },
  { method: 'delete', path: '/api/v1/api-keys/key-1' },
  {
    method: 'post',
    path: '/api/v1/billing/checkout',
    body: { planCode: 'growth', interval: 'month' },
  },
  { method: 'post', path: '/api/v1/billing/plan', body: { planCode: 'growth', interval: 'month' } },
  { method: 'post', path: '/api/v1/billing/cancel', body: {} },
  {
    method: 'post',
    path: '/api/v1/webhook-endpoints',
    body: { url: 'https://hooks.example.com/h', events: ['*'] },
  },
];

let bearer: string;

beforeAll(async () => {
  bearer = await tokens.issueAccessToken({ sub: USER, sid: 'session-1', wsIds: [WS], ver: 1 });
});

function send(app: Express, key: string, route: Route) {
  const agent = request(app);
  const call =
    route.method === 'post'
      ? agent.post(route.path)
      : route.method === 'patch'
        ? agent.patch(route.path)
        : agent.delete(route.path);

  return call.set('Authorization', `Bearer ${key}`).send(route.body ?? {});
}

describe('a read-scoped key cannot write anything', () => {
  it('is refused every mutating route', async () => {
    const app = buildApp();

    for (const route of WRITES) {
      const res = await send(app, READ_KEY, route);

      expect(res.status, `${route.method.toUpperCase()} ${route.path}`).toBe(403);
      expect(res.body.error.code, route.path).toBe('insufficient_permission');
    }
  });

  it('can still read', async () => {
    // The control. A test that refuses everything also passes when the key
    // path is broken outright, which is not the property being claimed.
    const app = buildApp();

    const res = await request(app)
      .get('/api/v1/campaigns')
      .set('Authorization', `Bearer ${READ_KEY}`);

    expect(res.status).toBe(200);
  });

  it('names the scope it is missing', async () => {
    // So an integrator fixes their key rather than guessing.
    const app = buildApp();

    for (const route of WRITES) {
      const res = await send(app, READ_KEY, route);
      expect(res.body.error.message, route.path).toContain(route.scope as string);
    }
  });
});

describe('a fully scoped key', () => {
  it('reaches every mutating route it has scopes for', async () => {
    const app = buildApp();

    for (const route of WRITES) {
      const res = await send(app, FULL_KEY, route);

      expect(res.status, `${route.method.toUpperCase()} ${route.path}`).toBeLessThan(400);
    }
  });
});

describe('routes no key may reach', () => {
  it('refuse even a fully scoped key', async () => {
    // Key management and billing writes refuse keys outright rather than
    // checking a scope. A key that could mint another key makes revocation
    // whack-a-mole; a key that could change the plan is a fraud case.
    const app = buildApp();

    for (const route of KEY_FORBIDDEN) {
      const res = await send(app, FULL_KEY, route);

      expect(res.status, `${route.method.toUpperCase()} ${route.path}`).toBe(403);
    }
  });

  it('still allow a signed-in owner', async () => {
    // The control again: these routes are refused to keys, not broken.
    const app = buildApp();

    const res = await request(app)
      .post('/api/v1/api-keys')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Workspace-Id', WS)
      .send({ name: 'CI', scopes: ['contact:read'] });

    expect(res.status).toBeLessThan(400);
  });
});

describe('the credential fork', () => {
  it('refuses an unknown key without falling back to JWT verification', async () => {
    const app = buildApp();

    const res = await request(app)
      .get('/api/v1/campaigns')
      .set('Authorization', `Bearer rk_live_${'z'.repeat(43)}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_api_key');
  });

  it('still accepts a session token', async () => {
    const app = buildApp();

    const res = await request(app)
      .get('/api/v1/campaigns')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Workspace-Id', WS);

    expect(res.status).toBe(200);
  });

  it('needs no workspace header for a key', async () => {
    // The key is the workspace binding. Requiring the header as well would
    // make every integrator send a value they cannot get wrong and cannot
    // usefully change.
    const app = buildApp();

    const res = await request(app)
      .get('/api/v1/campaigns')
      .set('Authorization', `Bearer ${FULL_KEY}`);

    expect(res.status).toBe(200);
  });
});
