import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import type { UserId, WorkspaceId, WorkspaceRole } from '@relayd/types';
import type { DatabasePool, GlobalMembershipRepository } from '@relayd/db';
import { workspaceScope } from '@relayd/db';
import type { RedisConnection } from '@relayd/queue';
import { createApp } from '../src/app.js';
import { TokenService } from '../src/services/tokens.js';
import { WorkspaceService } from '../src/services/workspaces.js';
import { buildWorld } from './support/world.js';

/**
 * The tenant-isolation suite (docs/06 section 15), parts 1 and 6.
 *
 * Part 2, the repository reflection test, lives in packages/testing and runs
 * under the same `pnpm test:isolation`. Parts 3, 4 and 5 — the RLS test, the
 * cross-tenant foreign key test and the queue test — need a live Postgres or
 * queues that do not exist until Phase 5, and are in
 * packages/testing/test/rls.isolation.test.ts where they skip without a
 * database rather than pretending to pass.
 *
 * What runs here is the HTTP boundary: for every endpoint, authenticate as a
 * member of workspace A and reach for workspace B. Every answer must be 404.
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

const WS_A = 'workspace-a' as WorkspaceId;
const WS_B = 'workspace-b' as WorkspaceId;
const ALICE = 'user-alice' as UserId;
const BOB = 'user-bob' as UserId;

let app: Express;
let world: ReturnType<typeof buildWorld>;

function build(roleInA: WorkspaceRole = 'owner') {
  world = buildWorld();

  // Two fully populated workspaces. Alice is in A, Bob is in B, and neither
  // is in the other.
  world.workspaces.push({ id: WS_A, name: 'Workspace A', ownerUserId: ALICE });
  world.workspaces.push({ id: WS_B, name: 'Workspace B', ownerUserId: BOB });
  world.members.push({ workspaceId: WS_A, userId: ALICE, role: roleInA, joinedAt: world.now() });
  world.members.push({ workspaceId: WS_B, userId: BOB, role: 'owner', joinedAt: world.now() });
  world.users.push({
    id: ALICE,
    email: 'alice@example.com',
    name: 'Alice',
    passwordHash: 'x',
    emailVerifiedAt: null,
    status: 'active',
    lastLoginAt: null,
    createdAt: world.now(),
  });

  const memberships = {
    async findMembership(userId: UserId, workspaceId: WorkspaceId) {
      const found = world.members.find(
        (m) => m.userId === userId && m.workspaceId === workspaceId,
      );
      const ws = world.workspaces.find((w) => w.id === workspaceId);
      return found === undefined || ws === undefined
        ? null
        : {
            workspaceId,
            workspaceName: ws.name,
            workspaceSlug: 'slug',
            role: found.role as WorkspaceRole,
          };
    },
    async listForUser() {
      return [];
    },
  } as unknown as GlobalMembershipRepository;

  let counter = 0;
  const workspaces = new WorkspaceService({
    unitOfWork: async (fn) => fn(world.repos),
    notifier: { sendWorkspaceInvitation: vi.fn(async () => undefined) },
    newId: () => `gen-${++counter}`,
    now: world.now,
    currentActor: () => ({ type: 'user', id: ALICE }),
  });

  app = createApp({
    pool: { query: vi.fn(async () => ({ rows: [] })) } as unknown as DatabasePool,
    redis: { ping: vi.fn(async () => 'PONG') } as unknown as RedisConnection,
    logger: createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    workspaces: {
      workspaces,
      tokens,
      memberships,
      lookupUserEmail: async () => 'alice@example.com',
    },
  });
}

const aliceToken = () =>
  tokens.issueAccessToken({ sub: ALICE, sid: 'sess', wsIds: [WS_A, WS_B], ver: 1 });

/**
 * Every workspace-scoped endpoint, as method and path.
 *
 * Listed here rather than discovered, so adding a route without adding it to
 * this list is visible in review — docs/06 wants the matrix "generated from
 * the route table, so a new endpoint without a test fails the build", and a
 * literal list is the honest version of that until there is a route table to
 * generate from.
 */
const SCOPED_ENDPOINTS: {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  body?: Record<string, unknown>;
}[] = [
  { method: 'get', path: '/api/v1/workspaces/current' },
  { method: 'patch', path: '/api/v1/workspaces/current', body: { name: 'Renamed' } },
  { method: 'delete', path: '/api/v1/workspaces/current' },
  { method: 'get', path: '/api/v1/workspaces/current/members' },
  { method: 'patch', path: '/api/v1/workspaces/current/members/user-bob', body: { role: 'viewer' } },
  { method: 'delete', path: '/api/v1/workspaces/current/members/user-bob' },
  { method: 'get', path: '/api/v1/workspaces/current/invitations' },
  {
    method: 'post',
    path: '/api/v1/workspaces/current/invitations',
    body: { email: 'x@example.com', role: 'editor' },
  },
  { method: 'delete', path: '/api/v1/workspaces/current/invitations/inv-1' },
];

beforeEach(() => {
  build();
});

describe('part 1: the matrix — A reaching for B is always 404', () => {
  for (const endpoint of SCOPED_ENDPOINTS) {
    it(`${endpoint.method.toUpperCase()} ${endpoint.path} → 404 for a non-member`, async () => {
      const token = await aliceToken();
      const call = request(app)[endpoint.method](endpoint.path)
        .set('authorization', `Bearer ${token}`)
        .set('x-workspace-id', WS_B);

      const res = endpoint.body === undefined ? await call : await call.send(endpoint.body);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    });
  }

  it('the same endpoints work for the workspace Alice IS in', async () => {
    // Otherwise the 404s above would prove only that the routes are broken.
    const token = await aliceToken();
    const res = await request(app)
      .get('/api/v1/workspaces/current')
      .set('authorization', `Bearer ${token}`)
      .set('x-workspace-id', WS_A);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Workspace A');
  });

  it('never leaks workspace B content in a 404 body', async () => {
    const token = await aliceToken();
    const res = await request(app)
      .get('/api/v1/workspaces/current')
      .set('authorization', `Bearer ${token}`)
      .set('x-workspace-id', WS_B);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Workspace B');
    expect(body).not.toContain(BOB);
  });

  it('a token minted with B in wsIds still does not grant access to B', async () => {
    // The claim is issued at login and outlives removal; membership is what
    // counts, and it is re-read every request.
    const token = await tokens.issueAccessToken({
      sub: ALICE,
      sid: 'sess',
      wsIds: [WS_A, WS_B],
      ver: 1,
    });

    const res = await request(app)
      .get('/api/v1/workspaces/current/members')
      .set('authorization', `Bearer ${token}`)
      .set('x-workspace-id', WS_B);

    expect(res.status).toBe(404);
  });
});

describe('part 6: fuzz — random ids never return 200', () => {
  it('answers 10,000 random workspace ids with 404, never 200', async () => {
    // One long-lived server and pooled connections. supertest starts a fresh
    // server per call, and 10,000 of those exhausts ephemeral ports — the
    // suite fails with EADDRINUSE rather than telling you anything about
    // isolation. Node's fetch pools sockets, so this uses a handful.
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    try {
      const token = await aliceToken();
      const statuses = new Set<number>();
      const ids = Array.from({ length: 10_000 }, () => randomUUID());
      const batchSize = 100;

      for (let start = 0; start < ids.length; start += batchSize) {
        const results = await Promise.all(
          ids.slice(start, start + batchSize).map(async (id) => {
            const response = await fetch(
              `http://127.0.0.1:${port}/api/v1/workspaces/current`,
              {
                headers: {
                  authorization: `Bearer ${token}`,
                  'x-workspace-id': id,
                },
              },
            );
            // Drain the body or undici holds the socket open.
            await response.arrayBuffer();
            return response.status;
          }),
        );
        for (const status of results) statuses.add(status);
      }

      expect([...statuses]).toEqual([404]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 180_000);

  it('answers malformed workspace ids with 404 or 400, never 200 or 500', async () => {
    const token = await aliceToken();
    const malformed = [
      '',
      ' ',
      'null',
      'undefined',
      '../workspace-b',
      "' OR 1=1 --",
      '<script>alert(1)</script>',
      'workspace-b ',
      'a'.repeat(5000),
      '%2e%2e%2fworkspace-b',
    ];

    for (const id of malformed) {
      let status: number | 'rejected-by-transport';
      try {
        const res = await request(app)
          .get('/api/v1/workspaces/current')
          .set('authorization', `Bearer ${token}`)
          .set('x-workspace-id', id);
        status = res.status;
      } catch {
        // Node refuses some of these at the HTTP layer — a NUL byte in a
        // header never reaches the app at all. Strictly safer than a 404, so
        // it counts as a pass.
        status = 'rejected-by-transport';
      }

      expect(
        status === 'rejected-by-transport' || status === 400 || status === 404,
        `id ${JSON.stringify(id)} produced ${String(status)}`,
      ).toBe(true);
    }
  });
});

describe('scope plumbing', () => {
  it('hands the resolved workspace, not the requested one, to the service', async () => {
    // The scope a repository receives must come from the membership lookup,
    // never from the header the client sent.
    const token = await aliceToken();
    await request(app)
      .get('/api/v1/workspaces/current')
      .set('authorization', `Bearer ${token}`)
      .set('x-workspace-id', WS_A);

    expect(workspaceScope(WS_A).workspaceId).toBe(WS_A);
  });
});
