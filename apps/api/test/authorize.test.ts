import { generateKeyPairSync } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import type { UserId, WorkspaceId, WorkspaceRole } from '@relayd/types';
import type { GlobalMembershipRepository } from '@relayd/db';
import { errorEnvelope } from '../src/middleware/error-envelope.js';
import { requestId } from '../src/middleware/request-id.js';
import {
  authenticate,
  requestContext,
  requirePermission,
  requireWorkspace,
} from '../src/middleware/authorize.js';
import { requireScope, requireWorkspaceContext } from '../src/context.js';
import { TokenService } from '../src/services/tokens.js';

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

const WS_A = 'ws-a' as WorkspaceId;
const WS_B = 'ws-b' as WorkspaceId;
const MEMBER = 'user-member' as UserId;

/** Membership table: user -> workspace -> role. */
let memberships: { userId: UserId; workspaceId: WorkspaceId; role: WorkspaceRole }[];
let findMembership: ReturnType<typeof vi.fn>;

function buildApp(): Express {
  findMembership = vi.fn(async (userId: UserId, workspaceId: WorkspaceId) => {
    const found = memberships.find(
      (m) => m.userId === userId && m.workspaceId === workspaceId,
    );
    return found === undefined
      ? null
      : {
          workspaceId: found.workspaceId,
          workspaceName: 'ws',
          workspaceSlug: 'ws',
          role: found.role,
        };
  });

  const app = express();
  app.use(requestId);
  app.use(requestContext);

  const repo = { findMembership } as unknown as GlobalMembershipRepository;

  app.get(
    '/scoped',
    authenticate(tokens),
    requireWorkspace({ memberships: repo }),
    (_req, res) => {
      const ctx = requireWorkspaceContext();
      res.json({ data: { workspaceId: requireScope().workspaceId, role: ctx.role } });
    },
  );

  app.post(
    '/launch',
    authenticate(tokens),
    requireWorkspace({ memberships: repo }),
    requirePermission('campaign:launch'),
    (_req, res) => {
      res.json({ data: { launched: true } });
    },
  );

  app.post(
    '/billing',
    authenticate(tokens),
    requireWorkspace({ memberships: repo }),
    requirePermission('billing:write'),
    (_req, res) => {
      res.json({ data: { ok: true } });
    },
  );

  // Deliberately missing requireWorkspace, to prove the guard.
  app.get('/misrouted', authenticate(tokens), requirePermission('workspace:read'), (_req, res) => {
    res.json({ data: {} });
  });

  app.use(
    errorEnvelope(
      createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    ),
  );
  return app;
}

const tokenFor = async (userId: UserId, wsIds: WorkspaceId[]) =>
  tokens.issueAccessToken({ sub: userId, sid: 'session-1', wsIds, ver: 1 });

let app: Express;

beforeEach(() => {
  memberships = [{ userId: MEMBER, workspaceId: WS_A, role: 'admin' }];
  app = buildApp();
});

describe('authentication', () => {
  it('401s with no Authorization header', async () => {
    const res = await request(app).get('/scoped').set('x-workspace-id', WS_A);
    expect(res.status).toBe(401);
  });

  it('401s on a non-Bearer scheme', async () => {
    const res = await request(app)
      .get('/scoped')
      .set('authorization', 'Basic abc')
      .set('x-workspace-id', WS_A);
    expect(res.status).toBe(401);
  });

  it('gives the same 401 for expired, forged and malformed tokens', async () => {
    const expired = new TokenService({
      privateKeyPem: privateKey,
      publicKeyPem: publicKey,
      keyId: 'k1',
      accessTokenTtlSeconds: -1,
    });
    const forgedKeys = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const forged = new TokenService({
      privateKeyPem: forgedKeys.privateKey,
      publicKeyPem: forgedKeys.publicKey,
      keyId: 'k1',
      accessTokenTtlSeconds: 900,
    });

    const cases = [
      await expired.issueAccessToken({ sub: MEMBER, sid: 's', wsIds: [WS_A], ver: 1 }),
      await forged.issueAccessToken({ sub: MEMBER, sid: 's', wsIds: [WS_A], ver: 1 }),
      'utter.nonsense.here',
    ];

    const bodies = new Set<string>();
    for (const token of cases) {
      const res = await request(app)
        .get('/scoped')
        .set('authorization', `Bearer ${token}`)
        .set('x-workspace-id', WS_A);
      expect(res.status).toBe(401);
      bodies.add(res.body.error.message);
    }

    // One message for all three: no oracle telling a forger what to fix.
    expect(bodies.size).toBe(1);
  });
});

describe('workspace resolution: 404 for non-members', () => {
  it('resolves the workspace for a member', async () => {
    const res = await request(app)
      .get('/scoped')
      .set('authorization', `Bearer ${await tokenFor(MEMBER, [WS_A])}`)
      .set('x-workspace-id', WS_A);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ workspaceId: WS_A, role: 'admin' });
  });

  it('404s — never 403 — for a workspace the caller does not belong to', async () => {
    // The central rule of docs/06: never confirm a workspace exists to a
    // non-member.
    const res = await request(app)
      .get('/scoped')
      .set('authorization', `Bearer ${await tokenFor(MEMBER, [WS_A])}`)
      .set('x-workspace-id', WS_B);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('404s identically for a workspace that does not exist at all', async () => {
    const real = await request(app)
      .get('/scoped')
      .set('authorization', `Bearer ${await tokenFor(MEMBER, [WS_A])}`)
      .set('x-workspace-id', WS_B);
    const imaginary = await request(app)
      .get('/scoped')
      .set('authorization', `Bearer ${await tokenFor(MEMBER, [WS_A])}`)
      .set('x-workspace-id', 'not-a-workspace-at-all');

    expect(real.status).toBe(404);
    expect(imaginary.status).toBe(404);
    expect(real.body.error.message).toBe(imaginary.body.error.message);
  });

  it('IGNORES the token wsIds claim and re-reads membership', async () => {
    // A token minted while the user was a member of B must not grant access
    // after they were removed — otherwise every revocation waits out the
    // 15-minute token lifetime.
    const res = await request(app)
      .get('/scoped')
      .set('authorization', `Bearer ${await tokenFor(MEMBER, [WS_A, WS_B])}`)
      .set('x-workspace-id', WS_B);

    expect(res.status).toBe(404);
    expect(findMembership).toHaveBeenCalledWith(MEMBER, WS_B);
  });

  it('400s when the workspace header is missing', async () => {
    const res = await request(app)
      .get('/scoped')
      .set('authorization', `Bearer ${await tokenFor(MEMBER, [WS_A])}`);
    expect(res.status).toBe(400);
  });
});

describe('permissions: 403 for members who lack them', () => {
  it('allows an admin to launch', async () => {
    const res = await request(app)
      .post('/launch')
      .set('authorization', `Bearer ${await tokenFor(MEMBER, [WS_A])}`)
      .set('x-workspace-id', WS_A);
    expect(res.status).toBe(200);
  });

  it('403s an editor on campaign:launch, which they may not do', async () => {
    memberships = [{ userId: MEMBER, workspaceId: WS_A, role: 'editor' }];
    const res = await request(app)
      .post('/launch')
      .set('authorization', `Bearer ${await tokenFor(MEMBER, [WS_A])}`)
      .set('x-workspace-id', WS_A);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('insufficient_permission');
  });

  it('403s an admin on billing:write, which is owner-only', async () => {
    const res = await request(app)
      .post('/billing')
      .set('authorization', `Bearer ${await tokenFor(MEMBER, [WS_A])}`)
      .set('x-workspace-id', WS_A);
    expect(res.status).toBe(403);
  });

  it('allows an owner on billing:write', async () => {
    memberships = [{ userId: MEMBER, workspaceId: WS_A, role: 'owner' }];
    const res = await request(app)
      .post('/billing')
      .set('authorization', `Bearer ${await tokenFor(MEMBER, [WS_A])}`)
      .set('x-workspace-id', WS_A);
    expect(res.status).toBe(200);
  });

  it('403 is only ever reachable by a member', async () => {
    // A non-member hitting a permission-gated route gets 404 from the
    // workspace layer, before the permission check is consulted.
    memberships = [];
    const res = await request(app)
      .post('/billing')
      .set('authorization', `Bearer ${await tokenFor(MEMBER, [WS_A])}`)
      .set('x-workspace-id', WS_A);

    expect(res.status).toBe(404);
  });
});

describe('misrouting guard', () => {
  it('500s rather than guessing when requirePermission runs without a workspace', async () => {
    // A routing mistake, not a client error. Defaulting to some workspace is
    // how cross-tenant leaks happen.
    const res = await request(app)
      .get('/misrouted')
      .set('authorization', `Bearer ${await tokenFor(MEMBER, [WS_A])}`)
      .set('x-workspace-id', WS_A);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
  });
});
