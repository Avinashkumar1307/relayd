// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';
import express, { type Express, type Response } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import { hashToken } from '@relayd/utils';
import type { ApiKeyResolution, GlobalApiKeyRepository, GlobalMembershipRepository } from '@relayd/db';
import type { UserId, WorkspaceId, WorkspaceRole } from '@relayd/types';
import { requestContext } from '../src/middleware/authorize.js';
import { errorEnvelope } from '../src/middleware/error-envelope.js';
import { requestId } from '../src/middleware/request-id.js';
import type { RateLimitStore } from '../src/middleware/rate-limit.js';
import { invitationRoutes, workspaceRoutes } from '../src/routes/workspaces.js';
import { TokenService } from '../src/services/tokens.js';
import type { WorkspaceService } from '../src/services/workspaces.js';

/**
 * The workspace and invitation routes over HTTP.
 *
 * What lives in the routing layer and nowhere else:
 *
 *   creating a workspace is authenticated but not workspace-scoped — requiring
 *   a workspace header would make a second workspace impossible to create;
 *
 *   the two invitation routes B5 needs are open to anyone at all, because the
 *   visitor has no account yet, and are the only routes here where an
 *   anonymous caller makes us do work — so they carry a per-IP limit;
 *
 *   ownership transfer is the owner's alone, and an API key — which has no
 *   role and no person behind it — can never do it however it is scoped.
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
const API_KEY = `rk_live_${'a'.repeat(43)}`;

interface BuildOptions {
  role?: WorkspaceRole;
  service?: Partial<WorkspaceService>;
  rateLimitStore?: RateLimitStore;
  signInNewAccount?: (res: Response) => Promise<void>;
  /** Every scope, to prove a key is refused by kind rather than by scope. */
  withApiKey?: boolean;
}

function buildApp(options: BuildOptions = {}): Express {
  const role = options.role ?? 'owner';

  const findMembership = vi.fn(async (userId: UserId, workspaceId: WorkspaceId) =>
    userId === USER && workspaceId === WS
      ? { workspaceId: WS, workspaceName: 'Northwind', workspaceSlug: 'northwind', role }
      : null,
  );

  const workspaces = {
    async get() {
      return { id: WS, name: 'Northwind Voyages', slug: 'northwind', timezone: 'UTC' };
    },
    async details() {
      return {
        id: WS,
        name: 'Northwind Voyages',
        slug: 'northwind',
        timezone: 'UTC',
        createdAt: '2026-02-14T06:00:00.000Z',
        createdByName: 'Dana Haddad',
      };
    },
    async createWorkspace() {
      return { id: 'ws-new', name: 'Labs', slug: 'labs', timezone: 'UTC', role: 'owner' };
    },
    async resendInvitation() {
      return {
        id: 'inv-1',
        email: 'omar.h@northwind.travel',
        role: 'editor',
        expiresAt: new Date('2026-09-25T06:00:00.000Z'),
      };
    },
    async transferOwnership() {
      return {
        previousOwner: { userId: USER, role: 'admin', joinedAt: new Date() },
        newOwner: { userId: 'user-2', role: 'owner', joinedAt: new Date() },
      };
    },
    async previewInvitation() {
      return {
        workspaceName: 'Northwind Voyages',
        workspaceMonogram: 'NV',
        inviterName: 'Farah Al-Mansoori',
        invitedAt: new Date('2026-09-18T06:00:00.000Z'),
        expiresAt: new Date('2026-09-25T06:00:00.000Z'),
        role: 'editor',
        email: 'omar.h@northwind.travel',
      };
    },
    async registerAndAcceptInvitation() {
      return {
        userId: 'user-new',
        email: 'omar.h@northwind.travel',
        workspaceId: WS,
        role: 'editor',
      };
    },
    ...options.service,
  } as unknown as WorkspaceService;

  const apiKeys = {
    async resolve() {
      return {
        id: 'key-1',
        workspaceId: WS,
        name: 'CI',
        // Deliberately generous: the refusal must not depend on scopes.
        scopes: ['workspace:read', 'workspace:update', 'workspace:delete', 'member:invite'],
        revokedAt: null,
        expiresAt: null,
        createdBy: null,
        lastUsedAt: null,
      } satisfies ApiKeyResolution as ApiKeyResolution;
    },
  } as unknown as GlobalApiKeyRepository;

  const routerOptions = {
    workspaces,
    tokens,
    memberships: { findMembership } as unknown as GlobalMembershipRepository,
    lookupUserEmail: async () => 'farah@northwind.travel',
    ...(options.withApiKey === true ? { apiKeys: { apiKeys } } : {}),
    ...(options.rateLimitStore === undefined ? {} : { rateLimitStore: options.rateLimitStore }),
    ...(options.signInNewAccount === undefined
      ? {}
      : {
          signInNewAccount: async (res: Response) => {
            await options.signInNewAccount?.(res);
          },
        }),
  };

  const app = express();
  app.use(express.json());
  app.use(requestId);
  app.use(requestContext);
  app.use('/api/v1/workspaces', workspaceRoutes(routerOptions));
  app.use('/api/v1/invitations', invitationRoutes(routerOptions));
  app.use(
    errorEnvelope(
      createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    ),
  );

  return app;
}

let bearer: string;

beforeAll(async () => {
  bearer = await tokens.issueAccessToken({ sub: USER, sid: 'session-1', wsIds: [WS], ver: 1 });
});

const asUser = (app: Express, method: 'get' | 'post', path: string) =>
  request(app)[method](path).set('Authorization', `Bearer ${bearer}`).set('X-Workspace-Id', WS);

describe('POST /workspaces', () => {
  it('creates one without a workspace header', async () => {
    // There is no workspace yet to name, and requiring one would make the
    // second workspace uncreatable.
    const res = await request(buildApp())
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ name: 'Northwind Labs', slug: 'northwind-labs', timezone: 'Asia/Dubai' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: 'ws-new', role: 'owner' });
  });

  it('refuses an anonymous caller', async () => {
    const res = await request(buildApp())
      .post('/api/v1/workspaces')
      .send({ name: 'Northwind Labs', slug: 'northwind-labs' });

    expect(res.status).toBe(401);
  });

  it('rejects a slug that is not a usable URL', async () => {
    const createWorkspace = vi.fn();
    const res = await request(buildApp({ service: { createWorkspace } as never }))
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ name: 'Northwind Labs', slug: 'Northwind Labs!' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('rejects an unknown field rather than dropping it', async () => {
    const res = await request(buildApp())
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ name: 'Labs', slug: 'labs', role: 'owner' });

    expect(res.status).toBe(400);
  });

  it('refuses an API key however it is scoped', async () => {
    // A key is bound to one workspace and has no person behind it to own
    // another.
    const createWorkspace = vi.fn();
    const res = await request(buildApp({ withApiKey: true, service: { createWorkspace } as never }))
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ name: 'Labs', slug: 'labs' });

    expect(res.status).toBe(403);
    expect(createWorkspace).not.toHaveBeenCalled();
  });
});

describe('POST /workspaces/current/invitations/:id/resend', () => {
  it('lets an admin resend', async () => {
    const res = await asUser(
      buildApp({ role: 'admin' }),
      'post',
      '/api/v1/workspaces/current/invitations/inv-1/resend',
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ email: 'omar.h@northwind.travel' });
  });

  it('never returns the token it just emailed', async () => {
    const res = await asUser(
      buildApp({ role: 'owner' }),
      'post',
      '/api/v1/workspaces/current/invitations/inv-1/resend',
    );

    expect(JSON.stringify(res.body)).not.toContain('token');
  });

  it('refuses an editor and a viewer', async () => {
    for (const role of ['editor', 'viewer'] as const) {
      const resendInvitation = vi.fn();
      const res = await asUser(
        buildApp({ role, service: { resendInvitation } as never }),
        'post',
        '/api/v1/workspaces/current/invitations/inv-1/resend',
      );

      expect(res.status, role).toBe(403);
      expect(resendInvitation).not.toHaveBeenCalled();
    }
  });

  it('404s a caller who is not a member, rather than 403', async () => {
    const res = await request(buildApp())
      .post('/api/v1/workspaces/current/invitations/inv-1/resend')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Workspace-Id', 'ws-somebody-else');

    expect(res.status).toBe(404);
  });
});

describe('POST /workspaces/current/transfer-ownership', () => {
  it('lets the owner hand over', async () => {
    const res = await asUser(buildApp({ role: 'owner' }), 'post', '/api/v1/workspaces/current/transfer-ownership')
      .send({ userId: '0192f4a1-0000-7000-8000-00000000000b' });

    expect(res.status).toBe(200);
    expect(res.body.data.newOwner.role).toBe('owner');
  });

  it('refuses an admin', async () => {
    const transferOwnership = vi.fn();
    const res = await asUser(
      buildApp({ role: 'admin', service: { transferOwnership } as never }),
      'post',
      '/api/v1/workspaces/current/transfer-ownership',
    ).send({ userId: '0192f4a1-0000-7000-8000-00000000000b' });

    expect(res.status).toBe(403);
    expect(transferOwnership).not.toHaveBeenCalled();
  });

  it('refuses an API key holding every scope', async () => {
    const transferOwnership = vi.fn();
    const res = await request(
      buildApp({ withApiKey: true, service: { transferOwnership } as never }),
    )
      .post('/api/v1/workspaces/current/transfer-ownership')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ userId: '0192f4a1-0000-7000-8000-00000000000b' });

    expect(res.status).toBe(403);
    expect(transferOwnership).not.toHaveBeenCalled();
  });

  it('rejects a userId that is not an id', async () => {
    const res = await asUser(buildApp(), 'post', '/api/v1/workspaces/current/transfer-ownership')
      .send({ userId: 'someone' });

    expect(res.status).toBe(400);
  });
});

describe('GET /invitations/:token', () => {
  it('renders for a visitor with no account and no session', async () => {
    const res = await request(buildApp()).get('/api/v1/invitations/some-token');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ workspaceName: 'Northwind Voyages', role: 'editor' });
  });

  it('does not shadow POST /invitations/accept', async () => {
    const acceptInvitation = vi.fn(async () => ({ workspaceId: WS, role: 'editor' }));
    const res = await request(buildApp({ service: { acceptInvitation } as never }))
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ token: 'some-token' });

    expect(res.status).toBe(200);
    expect(acceptInvitation).toHaveBeenCalledOnce();
  });

  it('counts anonymous callers per IP when a store is wired', async () => {
    let calls = 0;
    const store: RateLimitStore = {
      async hit() {
        calls += 1;
        return { currentCount: calls, previousCount: 0, elapsedFraction: 0.5 };
      },
    };
    const app = buildApp({ rateLimitStore: store });

    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await request(app).get('/api/v1/invitations/some-token')).status);
    }

    expect(statuses[0]).toBe(200);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('POST /invitations/:token/register', () => {
  const body = { name: 'Omar Haddad', password: 'a-long-enough-password' };

  it('takes no credentials, because there is no account yet', async () => {
    const res = await request(buildApp())
      .post('/api/v1/invitations/some-token/register')
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ workspaceId: WS, role: 'editor' });
  });

  it('refuses an email field: the token decides who this account is for', async () => {
    const registerAndAcceptInvitation = vi.fn();
    const res = await request(
      buildApp({ service: { registerAndAcceptInvitation } as never }),
    )
      .post('/api/v1/invitations/some-token/register')
      .send({ ...body, email: 'someone.else@example.com' });

    expect(res.status).toBe(400);
    expect(registerAndAcceptInvitation).not.toHaveBeenCalled();
  });

  it('refuses a password shorter than the shared rule allows', async () => {
    const res = await request(buildApp())
      .post('/api/v1/invitations/some-token/register')
      .send({ name: 'Omar', password: 'short' });

    expect(res.status).toBe(400);
  });

  it('hands the response to the sign-in path when one is wired', async () => {
    // So the person who just typed a password arrives signed in, with the
    // same cookie and the same envelope POST /auth/register writes.
    const signInNewAccount = vi.fn(async (res: Response) => {
      res.status(201).json({ data: { accessToken: 'token', sessionId: 'session-2' } });
    });

    const res = await request(buildApp({ signInNewAccount }))
      .post('/api/v1/invitations/some-token/register')
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBe('token');
    expect(signInNewAccount).toHaveBeenCalledOnce();
  });
});

/** Unused-import guard: the hash helper is what the token lookups are built on. */
export const _hashToken = hashToken;
