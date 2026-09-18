import { generateKeyPairSync } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import type { GlobalMembershipRepository } from '@relayd/db';
import type { UserId, WorkspaceId, WorkspaceRole } from '@relayd/types';
import { requestContext } from '../src/middleware/authorize.js';
import { errorEnvelope } from '../src/middleware/error-envelope.js';
import { requestId } from '../src/middleware/request-id.js';
import { campaignRoutes } from '../src/routes/campaigns.js';
import { TokenService } from '../src/services/tokens.js';
import type { CampaignService } from '../src/services/campaigns.js';

/**
 * The campaign routes over HTTP.
 *
 * Two things live in the routing layer rather than in the service, and
 * neither can be tested below it.
 *
 * `campaign:launch` is separate from `campaign:write` (docs/06). An editor
 * may build a campaign and may not send it. That is the one permission split
 * in the product that maps to an irreversible action, and it is enforced by
 * which middleware is attached to which path — so it is tested by asking an
 * editor to launch something.
 *
 * The Idempotency-Key header is validated before it reaches a unique index.
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

function buildApp(role: WorkspaceRole, service: Partial<CampaignService> = {}): Express {
  const findMembership = vi.fn(async (userId: UserId, workspaceId: WorkspaceId) =>
    userId === USER && workspaceId === WS
      ? { workspaceId: WS, workspaceName: 'ws', workspaceSlug: 'ws', role }
      : null,
  );

  const campaigns = {
    async list() {
      return { items: [], nextCursor: null };
    },
    async get() {
      return { campaign: null, counters: null };
    },
    async progress() {
      return { outstanding: 0, complete: true };
    },
    async listRecipients() {
      return { items: [], nextCursor: null };
    },
    async create() {
      return { id: 'c1' };
    },
    async update() {
      return { id: 'c1' };
    },
    async remove() {
      /* nothing */
    },
    async schedule() {
      return { id: 'c1' };
    },
    async launch() {
      return { ok: true, recipientCount: 10 };
    },
    async lifecycle() {
      return { ok: true, state: 'pausing' };
    },
    async retryFailed() {
      return { retried: 0, excluded: {}, reopened: false };
    },
    async clone() {
      return { id: 'c2' };
    },
    async testSend() {
      return { queued: 1 };
    },
    ...service,
  } as unknown as CampaignService;

  const app = express();
  app.use(express.json());
  app.use(requestId);
  app.use(requestContext);
  app.use(
    '/api/v1',
    campaignRoutes({
      campaigns,
      tokens,
      memberships: { findMembership } as unknown as GlobalMembershipRepository,
    }),
  );
  app.use(
    errorEnvelope(
      createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    ),
  );

  return app;
}

/**
 * One signed token for the whole file.
 *
 * Issued once in `beforeAll` so `auth` stays synchronous — an async helper
 * here means every call site needs a second await before `.send()`, and
 * forgetting one produces a request that is never sent and a test that
 * passes.
 */
let bearer: string;

beforeAll(async () => {
  bearer = await tokens.issueAccessToken({ sub: USER, sid: 'session-1', wsIds: [WS], ver: 1 });
});

function auth(app: Express, method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  return request(app)[method](path)
    .set('Authorization', `Bearer ${bearer}`)
    .set('X-Workspace-Id', WS);
}

describe('campaign:launch is not campaign:write (docs/06)', () => {
  it('lets an editor create a campaign', async () => {
    const res = await auth(buildApp('editor'), 'post', '/api/v1/campaigns').send({ name: 'Spring' });
    expect(res.status).toBe(201);
  });

  it('refuses to let an editor launch one', async () => {
    // The permission split exists for exactly this: building is reversible,
    // sending is not.
    const launch = vi.fn();
    const res = await auth(buildApp('editor', { launch } as never), 'post', '/api/v1/campaigns/c1/launch')
      .send({ consentAttested: true });

    expect(res.status).toBe(403);
    expect(launch).not.toHaveBeenCalled();
  });

  it('lets an admin launch one', async () => {
    const res = await auth(buildApp('admin'), 'post', '/api/v1/campaigns/c1/launch').send({
      consentAttested: true,
    });

    expect(res.status).toBe(202);
  });

  it('refuses to let an editor pause or cancel', async () => {
    // Whoever is trusted to start a send should be the one who can stop it,
    // and an editor who could pause could halt someone else's campaign.
    for (const action of ['pause', 'resume', 'cancel']) {
      const res = await auth(buildApp('editor'), 'post', `/api/v1/campaigns/c1/${action}`).send({});
      expect(res.status, action).toBe(403);
    }
  });

  it('refuses to let an editor retry a failed campaign', async () => {
    const res = await auth(buildApp('editor'), 'post', '/api/v1/campaigns/c1/retry-failed').send({});
    expect(res.status).toBe(403);
  });

  it('lets a viewer read but not write', async () => {
    expect((await auth(buildApp('viewer'), 'get', '/api/v1/campaigns')).status).toBe(200);
    expect(
      (await auth(buildApp('viewer'), 'post', '/api/v1/campaigns').send({ name: 'x' })).status,
    ).toBe(403);
  });
});

describe('launch', () => {
  it('answers 202, not 200', async () => {
    // The snapshot is taken but nothing has been sent. A client that treats
    // launch as "done" shows a completed campaign with a zero send count for
    // the next several seconds.
    const res = await auth(buildApp('owner'), 'post', '/api/v1/campaigns/c1/launch').send({
      consentAttested: true,
    });

    expect(res.status).toBe(202);
  });

  it('requires the consent attestation', async () => {
    // docs/06 wants it at launch as well as at import: a customer who
    // imported a list six months ago is attesting about the list they are
    // mailing today.
    const res = await auth(buildApp('owner'), 'post', '/api/v1/campaigns/c1/launch').send({});
    expect(res.status).toBe(400);
  });

  it('refuses an attestation that is merely present', async () => {
    const res = await auth(buildApp('owner'), 'post', '/api/v1/campaigns/c1/launch').send({
      consentAttested: false,
    });

    expect(res.status).toBe(400);
  });

  it('passes a valid Idempotency-Key through', async () => {
    let seen: string | undefined;
    const launch = vi.fn(async (_s: unknown, _i: unknown, opts: { idempotencyKey?: string }) => {
      seen = opts.idempotencyKey;
      return { ok: true, recipientCount: 1 };
    });

    await auth(buildApp('owner', { launch } as never), 'post', '/api/v1/campaigns/c1/launch')
      .set('Idempotency-Key', 'req-2026-09-18-abc')
      .send({ consentAttested: true });

    expect(seen).toBe('req-2026-09-18-abc');
  });

  it('launches without one', async () => {
    let seen: unknown = 'unset';
    const launch = vi.fn(async (_s: unknown, _i: unknown, opts: { idempotencyKey?: string }) => {
      seen = opts.idempotencyKey;
      return { ok: true, recipientCount: 1 };
    });

    await auth(buildApp('owner', { launch } as never), 'post', '/api/v1/campaigns/c1/launch').send({
      consentAttested: true,
    });

    expect(seen).toBeUndefined();
  });

  it('rejects an oversized Idempotency-Key', async () => {
    // It becomes a unique index key. An unbounded header is a way to write
    // arbitrarily large rows.
    const res = await auth(buildApp('owner'), 'post', '/api/v1/campaigns/c1/launch')
      .set('Idempotency-Key', 'x'.repeat(300))
      .send({ consentAttested: true });

    expect(res.status).toBe(400);
  });

  it('rejects an Idempotency-Key with unsafe characters', async () => {
    for (const key of ['has space', 'has/slash', 'has%percent', 'has"quote']) {
      const res = await auth(buildApp('owner'), 'post', '/api/v1/campaigns/c1/launch')
        .set('Idempotency-Key', key)
        .send({ consentAttested: true });

      expect(res.status, key).toBe(400);
    }
  });

  it('does not launch when the key is refused', async () => {
    const launch = vi.fn();
    await auth(buildApp('owner', { launch } as never), 'post', '/api/v1/campaigns/c1/launch')
      .set('Idempotency-Key', 'bad key')
      .send({ consentAttested: true });

    expect(launch).not.toHaveBeenCalled();
  });
});

describe('progress', () => {
  it('is readable by a viewer', async () => {
    expect((await auth(buildApp('viewer'), 'get', '/api/v1/campaigns/c1/progress')).status).toBe(200);
  });
});

describe('unauthenticated requests', () => {
  it('get 401 rather than 403', async () => {
    const res = await request(buildApp('owner')).get('/api/v1/campaigns');
    expect(res.status).toBe(401);
  });
});
