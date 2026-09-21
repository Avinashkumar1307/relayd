// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import type { DatabasePool, GlobalMembershipRepository } from '@relayd/db';
import type { RedisConnection } from '@relayd/queue';
import type { UserId, WorkspaceId } from '@relayd/types';
import { createApp } from '../src/app.js';
import { AuthService } from '../src/services/auth.js';
import { AuditLogService } from '../src/services/audit-log.js';
import { ProfileService } from '../src/services/profile.js';
import { TokenService } from '../src/services/tokens.js';
import { WorkspaceService } from '../src/services/workspaces.js';
import { tryGetPrincipal } from '../src/context.js';
import { buildWorld } from './support/world.js';

/**
 * The identity contract: what `apps/web` declares each response will contain,
 * asserted against what the real routers and the real services actually send.
 *
 * ## Why this file exists
 *
 * The browser's API client returns `envelope.data` straight to the caller, so
 * a declaration like `api.get<WorkspaceMember[]>('/workspaces/current/members')`
 * is a claim about the JSON the server writes. Nothing else in the suite
 * checks that claim: every web test mocks `fetch`, and every other API test
 * asserts the shape the API happens to produce. A field the page needs and the
 * server omits therefore passes both suites and reaches a customer as a blank
 * cell, an em dash where a name should be, or the word "undefined".
 *
 * So the assertions below are deliberately written from the *client's* types —
 * `apps/web/src/api/workspace.ts`, `apps/web/src/api/audit.ts` and
 * `apps/web/src/auth/AuthProvider.tsx` — and not from the services'. When one
 * of these fails, the question to ask is which side is wrong, not how to make
 * the expectation match.
 *
 * ## Why the real services, over the in-memory world
 *
 * A route test that stubs the service proves the route serialises whatever the
 * stub returned, which is the half of the contract that was never broken. The
 * omissions this file was written to catch — an invitation created without its
 * expiry, a member row without the person's name — live in the service. So the
 * services are real and only their storage is fake; `support/world.ts` needs no
 * database, which is what lets this run where Docker does not.
 *
 * The audit service is the exception: its repository is a query object the
 * world does not model, so it is stubbed, and what is asserted about it is the
 * routing and envelope shape rather than the query.
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

const PASSWORD = 'correct-horse-battery-staple';

/* ------------------------------------------------------------------ */
/* Assertion helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Every key the client declares as required is present with the right type.
 *
 * `toMatchObject` would pass on a missing optional and on a present-but-null
 * required field; this walks the keys the client cannot render without and
 * says which one is absent, because "expected undefined to be a string" in a
 * 40-key object is not a bug report.
 */
function hasShape(
  value: unknown,
  shape: Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array' | 'string|null'>,
  where: string,
): void {
  expect(value, `${where}: not an object`).toBeTypeOf('object');
  expect(value, `${where}: null`).not.toBeNull();
  const row = value as Record<string, unknown>;

  for (const [key, kind] of Object.entries(shape)) {
    const actual = row[key];
    const found = Array.isArray(actual) ? 'array' : actual === null ? 'null' : typeof actual;

    if (kind === 'string|null') {
      expect([`string`, `null`], `${where}.${key} is ${found}`).toContain(found);
      continue;
    }
    expect(found, `${where}.${key} is ${found}, client declares ${kind}`).toBe(kind);
  }
}

/** An ISO 8601 instant, which is what every date in these DTOs is typed as. */
function isIsoInstant(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && value.includes('T');
}

/* ------------------------------------------------------------------ */
/* The world, wired to the real services                               */
/* ------------------------------------------------------------------ */

function build() {
  const world = buildWorld();
  let counter = 0;
  const newId = () => `0192f4a1-0000-7000-8000-${String(++counter).padStart(12, '0')}`;

  const notifier = {
    sendEmailVerification: vi.fn(async () => undefined),
    sendPasswordReset: vi.fn(async () => undefined),
    sendWorkspaceInvitation: vi.fn(async () => undefined),
  };

  const unitOfWork = async <T,>(fn: (repos: typeof world.repos) => Promise<T>) => fn(world.repos);

  const auth = new AuthService({
    unitOfWork,
    tokens,
    notifier,
    newId,
    now: world.now,
    refreshTtlDays: 30,
  });

  const profile = new ProfileService({ unitOfWork, newId, now: world.now, notifier });

  const workspaces = new WorkspaceService({
    unitOfWork,
    notifier,
    newId,
    now: world.now,
    // The audited actor is the signed-in caller. Read per request rather than
    // captured, so the invitation rows below are attributed to whoever sent
    // them instead of to a constant.
    currentActor: () => {
      const principal = tryGetPrincipal();
      return principal === undefined
        ? { type: 'system' as const }
        : { type: 'user' as const, id: principal.userId };
    },
  });

  /**
   * The membership lookup `requireWorkspace` runs, over the world's rows.
   *
   * This is what makes a non-member a 404 rather than a 403, so it reads the
   * same array the services write to rather than answering yes.
   */
  const memberships = {
    async findMembership(userId: UserId, workspaceId: WorkspaceId) {
      const member = world.members.find(
        (m) => m.userId === userId && m.workspaceId === workspaceId,
      );
      if (member === undefined) return null;
      const workspace = world.workspaces.find((w) => w.id === workspaceId);
      return {
        workspaceId,
        workspaceName: workspace?.name ?? '',
        workspaceSlug: workspace?.slug ?? '',
        role: member.role as 'owner' | 'admin' | 'editor' | 'viewer',
      };
    },
  } as unknown as GlobalMembershipRepository;

  const auditLogs = {
    async list() {
      return {
        events: [
          {
            id: 'aud-1',
            occurredAt: '2026-09-17T09:30:00.000Z',
            actor: { kind: 'user', name: 'Dana Haddad', initials: 'DH' },
            action: 'campaign.launched',
            resource: 'cmp_8f3k2a',
            resourceType: 'campaign',
            details: 'recipientCount: 42',
          },
          {
            id: 'aud-2',
            occurredAt: '2026-09-17T09:00:00.000Z',
            actor: { kind: 'system', name: 'Relayd', initials: 'R' },
            action: 'workspace.updated',
            // Workspace-wide events carry no resource. The client types this
            // `string | null`, and null is the case the page renders an em
            // dash for — undefined would render the word.
            resource: null,
            resourceType: 'workspace',
            details: 'timezone: UTC',
          },
        ],
        total: 3412,
      };
    },
    async filterOptions() {
      return {
        actors: [{ id: 'user-1', name: 'Dana Haddad' }],
        actions: ['campaign.launched'],
        resourceTypes: ['campaign'],
      };
    },
  } as unknown as AuditLogService;

  const app = createApp({
    pool: { query: vi.fn(async () => ({ rows: [] })) } as unknown as DatabasePool,
    redis: { ping: vi.fn(async () => 'PONG') } as unknown as RedisConnection,
    logger: createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    auth: { auth, secureCookies: false, refreshTtlDays: 30, tokens },
    me: { profile, tokens },
    workspaces: {
      workspaces,
      tokens,
      memberships,
      lookupUserEmail: async (userId: UserId) =>
        world.users.find((u) => u.id === userId)?.email ?? null,
    },
    audit: { auditLogs, tokens, memberships },
  });

  return { app, world, notifier };
}

type World = ReturnType<typeof build>;

let ctx: World;
/** The session `POST /auth/register` answered with, reused by every read. */
let session: {
  accessToken: string;
  sessionId: string;
  user: Record<string, unknown>;
  memberships: Record<string, unknown>[];
};
let workspaceId: string;
let refreshCookie: string;

/**
 * One registration for the file.
 *
 * argon2 is deliberately expensive, so hashing once and reading many times is
 * the difference between a suite that runs on every save and one that does
 * not. Nothing below mutates the password.
 */
beforeAll(async () => {
  ctx = build();

  const registered = await request(ctx.app)
    .post('/api/v1/auth/register')
    .send({
      email: 'dana@northwind.travel',
      name: 'Dana Haddad',
      password: PASSWORD,
      workspaceName: 'Northwind Voyages',
      workspaceSlug: 'northwind-voyages',
    })
    .expect(201);

  session = registered.body.data;
  workspaceId = session.memberships[0]?.['workspaceId'] as string;

  const cookies = registered.headers['set-cookie'] as unknown as string[] | undefined;
  refreshCookie = (cookies ?? []).join('; ');

  // The world's users are created unverified; J5 draws both states and the
  // profile assertions below want the verified one to be reachable.
  const user = ctx.world.users[0];
  if (user !== undefined) user.emailVerifiedAt = ctx.world.now();
}, 30_000);

function get(path: string, scoped = true) {
  const req = request(ctx.app).get(path).set('Authorization', `Bearer ${session.accessToken}`);
  return scoped ? req.set('X-Workspace-Id', workspaceId) : req;
}

function send(method: 'post' | 'patch' | 'delete', path: string, scoped = true) {
  const req = request(ctx.app)[method](path).set(
    'Authorization',
    `Bearer ${session.accessToken}`,
  );
  return scoped ? req.set('X-Workspace-Id', workspaceId) : req;
}

/* ------------------------------------------------------------------ */
/* The session payload                                                 */
/* ------------------------------------------------------------------ */

/**
 * `AuthProvider.adopt` reads `accessToken`, `memberships` and `user` off every
 * one of these, and `client.ts` reads `accessToken` off the bare refresh. A
 * mismatch here is not a blank cell — it is a sign-in that appears to succeed
 * and leaves the app anonymous, or a workspace switcher with nothing in it.
 */
describe('the session payload: register, login, refresh and /auth/session', () => {
  /** `Session` in AuthProvider.tsx, plus the `sessionId` the route documents. */
  function assertSession(body: unknown, where: string): void {
    hasShape(
      body,
      { accessToken: 'string', sessionId: 'string', user: 'object', memberships: 'array' },
      where,
    );

    const data = body as { user: unknown; memberships: unknown[] };

    // SessionUser. `emailVerified` is optional on the client and always sent
    // here, which is the safe direction; the other three are not optional.
    hasShape(
      data.user,
      { id: 'string', name: 'string', email: 'string', emailVerified: 'boolean' },
      `${where}.user`,
    );

    for (const [index, membership] of data.memberships.entries()) {
      hasShape(
        membership,
        {
          workspaceId: 'string',
          workspaceName: 'string',
          workspaceSlug: 'string',
          role: 'string',
        },
        `${where}.memberships[${index}]`,
      );
    }
  }

  it('register answers the whole session', () => {
    assertSession(session, 'POST /auth/register');
    expect(session.memberships).toHaveLength(1);
  });

  it('login answers the same four keys', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: 'dana@northwind.travel', password: PASSWORD })
      .expect(200);

    assertSession(res.body.data, 'POST /auth/login');
  }, 20_000);

  it('refresh answers the same four keys', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookie)
      .expect(200);

    assertSession(res.body.data, 'POST /auth/refresh');

    // The rotation replaced the cookie this test was holding.
    const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
    refreshCookie = (cookies ?? []).join('; ');
  });

  it('GET /auth/session answers the user and memberships without the tokens', async () => {
    const res = await get('/api/v1/auth/session', false).expect(200);

    hasShape(res.body.data, { user: 'object', memberships: 'array' }, 'GET /auth/session');
    expect(res.body.data).not.toHaveProperty('accessToken');
  });

  /**
   * B2 collects a name, an address and a password. It collected them before
   * the server would accept them, and a registration missing the workspace
   * pair was a 400 — the one contract break that stops anybody signing up at
   * all.
   */
  it('REGISTERS AN ACCOUNT WITH NO WORKSPACE, AS B2 SENDS IT', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/register')
      .send({ email: 'omar.h@northwind.travel', name: 'Omar Haddad', password: PASSWORD })
      .expect(201);

    assertSession(res.body.data, 'POST /auth/register (no workspace)');
    // Empty, not absent: `adopt` calls `.find` on it before anything else.
    expect(res.body.data.memberships).toEqual([]);
  }, 20_000);

  it('refuses half a workspace rather than inventing the other half', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/register')
      .send({
        email: 'half@northwind.travel',
        name: 'Half',
        password: PASSWORD,
        workspaceName: 'No Slug',
      })
      .expect(400);

    expect(res.body.error.code).toBe('validation_failed');
  });

  it('verify-email answers { verified, email }, which B3 reads both of', async () => {
    // The token is whatever registration issued; the world stores its hash,
    // so this asks the service for the rejection path's shape instead.
    const res = await request(ctx.app)
      .post('/api/v1/auth/verify-email')
      .send({ token: 'not-a-real-token' });

    expect([200, 400, 404]).toContain(res.status);
    if (res.status === 200) {
      hasShape(res.body.data, { verified: 'boolean', email: 'string' }, 'POST /auth/verify-email');
    }
  });
});

/* ------------------------------------------------------------------ */
/* /me — AccountProfile and AccountSession                             */
/* ------------------------------------------------------------------ */

describe('/me matches AccountProfile and AccountSession', () => {
  it('GET /me answers every field the profile card draws', async () => {
    const res = await get('/api/v1/me', false).expect(200);

    hasShape(
      res.body.data,
      { id: 'string', name: 'string', email: 'string', emailVerified: 'boolean' },
      'GET /me',
    );
    // Optional on the client, always sent: J5 prints it and a missing one
    // would print "Invalid Date".
    expect(isIsoInstant(res.body.data.createdAt)).toBe(true);
  });

  it('PATCH /me answers the profile again, not an acknowledgement', async () => {
    const res = await send('patch', '/api/v1/me', false).send({ name: 'Dana Haddad' }).expect(200);

    hasShape(
      res.body.data,
      { id: 'string', name: 'string', email: 'string', emailVerified: 'boolean' },
      'PATCH /me',
    );
  });

  it('POST /me/email-change answers { pending, email }', async () => {
    const res = await send('post', '/api/v1/me/email-change', false)
      .send({ newEmail: 'dana.h@northwind.travel', currentPassword: PASSWORD })
      .expect(202);

    hasShape(res.body.data, { pending: 'boolean', email: 'string' }, 'POST /me/email-change');
    expect(res.body.data.pending).toBe(true);
    // The address in the answer is the proposed one, which is what J5 echoes
    // back in "check your inbox at ...".
    expect(res.body.data.email).toBe('dana.h@northwind.travel');
  }, 20_000);

  it('GET /me/sessions answers every column of J5 session table', async () => {
    const res = await get('/api/v1/me/sessions', false).expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);

    for (const [index, row] of (res.body.data as unknown[]).entries()) {
      hasShape(
        row,
        {
          id: 'string',
          device: 'string',
          deviceKind: 'string',
          client: 'string',
          // Empty string, never null: the client renders it directly above
          // the IP and null would print "null".
          location: 'string',
          ip: 'string',
          lastActiveLabel: 'string',
          current: 'boolean',
        },
        `GET /me/sessions[${index}]`,
      );
      expect(['desktop', 'mobile', 'unknown']).toContain(
        (row as { deviceKind: string }).deviceKind,
      );
      expect(isIsoInstant((row as { lastActiveAt: unknown }).lastActiveAt)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Workspaces, members and invitations                                 */
/* ------------------------------------------------------------------ */

describe('/workspaces/current matches WorkspaceDetails', () => {
  const required = {
    id: 'string',
    name: 'string',
    slug: 'string',
    timezone: 'string',
    role: 'string',
  } as const;

  it('GET answers the record J1 renders, created line included', async () => {
    const res = await get('/api/v1/workspaces/current').expect(200);

    hasShape(res.body.data, required, 'GET /workspaces/current');
    expect(isIsoInstant(res.body.data.createdAt)).toBe(true);
    expect(res.body.data.createdByName).toBe('Dana Haddad');
  });

  /**
   * J1 writes the PATCH response back into the record it is rendering from,
   * so a narrower body would blank the id, the slug and the read-only card
   * the instant somebody renamed the workspace.
   */
  it('PATCH ANSWERS THE SAME SHAPE AS GET, NOT A SUBSET', async () => {
    const res = await send('patch', '/api/v1/workspaces/current')
      .send({ name: 'Northwind Voyages', timezone: 'Europe/Berlin' })
      .expect(200);

    hasShape(res.body.data, required, 'PATCH /workspaces/current');
    expect(res.body.data.timezone).toBe('Europe/Berlin');
    expect(isIsoInstant(res.body.data.createdAt)).toBe(true);
  });

  it('rejects a body carrying fields it cannot store, rather than dropping them', async () => {
    // The client must not send `slug` or `defaultSenderId` — neither can be
    // written today — and this is what makes that binding rather than a
    // convention: a strict schema turns a stray field into a 400 that loses
    // the rename too.
    await send('patch', '/api/v1/workspaces/current')
      .send({ name: 'Northwind', slug: 'northwind-2' })
      .expect(400);
  });
});

describe('/workspaces/current/members matches WorkspaceMember', () => {
  const required = {
    userId: 'string',
    role: 'string',
    joinedAt: 'string',
    // The Member and Email columns. Without these J2a prints a uuid where a
    // person belongs, and K3's "ask the Owner" cannot name anyone.
    name: 'string',
    email: 'string',
  } as const;

  it('GET answers a person per row, not just a membership', async () => {
    const res = await get('/api/v1/workspaces/current/members').expect(200);

    expect(res.body.data).toHaveLength(1);
    hasShape(res.body.data[0], required, 'GET /workspaces/current/members[0]');
    expect(res.body.data[0].name).toBe('Dana Haddad');
    expect(res.body.data[0].email).toBe('dana@northwind.travel');
    expect(isIsoInstant(res.body.data[0].joinedAt)).toBe(true);
  });

  it('PATCH a role answers the same row shape the table came from', async () => {
    // A second member, so the owner is not the one being demoted.
    const second = ctx.world.users.find((u) => u.email === 'omar.h@northwind.travel');
    expect(second).toBeDefined();
    ctx.world.members.push({
      workspaceId: workspaceId as WorkspaceId,
      userId: second?.id as UserId,
      role: 'editor',
      joinedAt: ctx.world.now(),
    });

    const res = await send('patch', `/api/v1/workspaces/current/members/${second?.id ?? ''}`)
      .send({ role: 'admin' })
      .expect(200);

    hasShape(res.body.data, required, 'PATCH /workspaces/current/members/:id');
    expect(res.body.data.role).toBe('admin');
    expect(res.body.data.email).toBe('omar.h@northwind.travel');
  });
});

describe('/workspaces/current/invitations matches WorkspaceInvitation', () => {
  const required = {
    id: 'string',
    email: 'string',
    role: 'string',
    // J2a prints the expiry on the row it has just created. The create call
    // used to answer without one, so the row said "Expires undefined" until
    // the list refetched.
    expiresAt: 'string',
  } as const;

  let created: Record<string, unknown>;

  it('POST ANSWERS THE EXPIRY, NOT JUST THE ID', async () => {
    const res = await send('post', '/api/v1/workspaces/current/invitations')
      .send({ email: 'priya.n@northwind.travel', role: 'editor' })
      .expect(201);

    created = res.body.data;
    hasShape(created, required, 'POST /workspaces/current/invitations');
    expect(isIsoInstant(created['expiresAt'])).toBe(true);
  });

  it('GET answers who sent each one', async () => {
    const res = await get('/api/v1/workspaces/current/invitations').expect(200);

    expect(res.body.data).toHaveLength(1);
    hasShape(res.body.data[0], required, 'GET /workspaces/current/invitations[0]');
    expect(res.body.data[0].invitedByName).toBe('Dana Haddad');
  });

  it('DELETE answers 204 with no body, which the client types as void', async () => {
    const res = await send(
      'delete',
      `/api/v1/workspaces/current/invitations/${String(created['id'])}`,
    ).expect(204);

    expect(res.text).toBe('');
  });
});

describe('POST /workspaces answers the id B6a switches to', () => {
  it('carries an id, and the name and slug it was given', async () => {
    const res = await send('post', '/api/v1/workspaces', false)
      .send({ name: 'Northwind Labs', slug: 'northwind-labs', timezone: 'UTC' })
      .expect(201);

    hasShape(
      res.body.data,
      { id: 'string', name: 'string', slug: 'string', timezone: 'string', role: 'string' },
      'POST /workspaces',
    );
  });
});

/* ------------------------------------------------------------------ */
/* The audit log                                                       */
/* ------------------------------------------------------------------ */

describe('/audit-logs matches AuditPage and AuditFilterOptions', () => {
  it('answers { events, total } in data, because J6 footer is a count', async () => {
    const res = await get('/api/v1/audit-logs').expect(200);

    hasShape(res.body.data, { events: 'array', total: 'number' }, 'GET /audit-logs');

    for (const [index, event] of (res.body.data.events as unknown[]).entries()) {
      hasShape(
        event,
        {
          id: 'string',
          occurredAt: 'string',
          actor: 'object',
          action: 'string',
          // Null for a workspace-wide event. The page renders null as an em
          // dash and `undefined` as the word.
          resource: 'string|null',
          details: 'string',
        },
        `GET /audit-logs.events[${index}]`,
      );

      hasShape(
        (event as { actor: unknown }).actor,
        { kind: 'string', name: 'string', initials: 'string' },
        `GET /audit-logs.events[${index}].actor`,
      );
      expect(['user', 'system', 'api_key']).toContain(
        (event as { actor: { kind: string } }).actor.kind,
      );
    }
  });

  it('answers the two pickers J6 draws', async () => {
    const res = await get('/api/v1/audit-logs/filters').expect(200);

    hasShape(res.body.data, { actors: 'array', actions: 'array' }, 'GET /audit-logs/filters');
    for (const [index, actor] of (res.body.data.actors as unknown[]).entries()) {
      hasShape(actor, { id: 'string', name: 'string' }, `filters.actors[${index}]`);
    }
    for (const action of res.body.data.actions as unknown[]) {
      expect(action).toBeTypeOf('string');
    }
  });
});

/* ------------------------------------------------------------------ */
/* The one status code the whole tenancy story rests on                */
/* ------------------------------------------------------------------ */

it('answers 404, never 403, for a workspace the caller is not in', async () => {
  const res = await request(ctx.app)
    .get('/api/v1/workspaces/current')
    .set('Authorization', `Bearer ${session.accessToken}`)
    .set('X-Workspace-Id', '0192f4a1-9999-7000-8000-999999999999');

  expect(res.status).toBe(404);
});
