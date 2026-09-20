import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import { AppError } from '@relayd/types';
import type { SessionId, UserId } from '@relayd/types';
import type { DatabasePool } from '@relayd/db';
import type { RedisConnection } from '@relayd/queue';
import { createApp } from '../src/app.js';
import type { ProfileService } from '../src/services/profile.js';
import { TokenService } from '../src/services/tokens.js';

/**
 * `/me` over HTTP.
 *
 * The service tests cover what happens; these cover who is allowed to ask and
 * what shape comes back. Three properties are only visible at this layer:
 *
 *   The caller's id comes from the verified token and never from the request.
 *   Everything below asserts that the service was handed the token's subject.
 *
 *   An API key cannot reach any of this. `/me` is mounted without the key
 *   path, so a key-shaped credential is refused rather than accepted as some
 *   workspace's ambient identity.
 *
 *   A revocation answers 204 and a stranger's session answers 404.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const USER = '0192f4a1-0000-7000-8000-00000000000a' as UserId;
const SESSION = '0192f4a1-0000-7000-8000-0000000000f1' as SessionId;
const OTHER_SESSION = '0192f4a1-0000-7000-8000-0000000000f2';

const PROFILE = {
  id: USER,
  name: 'Dana Haddad',
  email: 'dana@northwind.travel',
  emailVerified: true,
  createdAt: '2026-02-14T06:00:00.000Z',
};

const SESSIONS = [
  {
    id: SESSION,
    device: 'Mac',
    deviceKind: 'desktop' as const,
    client: 'Chrome 129 · macOS',
    location: '',
    ip: '94.204.118.22',
    lastActiveLabel: 'Active now',
    lastActiveAt: '2026-09-19T12:00:00.000Z',
    current: true,
  },
];

const tokens = new TokenService({
  privateKeyPem: privateKey,
  publicKeyPem: publicKey,
  keyId: 'k1',
  accessTokenTtlSeconds: 900,
});

function buildApp(overrides: Partial<Record<keyof ProfileService, unknown>> = {}) {
  const profile = {
    get: vi.fn(async () => PROFILE),
    updateName: vi.fn(async () => PROFILE),
    changePassword: vi.fn(async () => ({ otherSessionsRevoked: 2 })),
    startEmailChange: vi.fn(async () => ({ pending: true, email: 'new@example.org' })),
    listSessions: vi.fn(async () => SESSIONS),
    revokeSession: vi.fn(async () => undefined),
    revokeOtherSessions: vi.fn(async () => ({ revoked: 2 })),
    ...overrides,
  } as unknown as ProfileService;

  const app = createApp({
    pool: { query: vi.fn(async () => ({ rows: [] })) } as unknown as DatabasePool,
    redis: { ping: vi.fn(async () => 'PONG') } as unknown as RedisConnection,
    logger: createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    me: { profile, tokens },
  });

  return { app, profile };
}

async function bearer(): Promise<string> {
  const token = await tokens.issueAccessToken({
    sub: USER,
    sid: SESSION,
    wsIds: [],
    ver: 1,
  });
  return `Bearer ${token}`;
}

describe('authentication on /me', () => {
  it('refuses an unauthenticated request', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('REFUSES AN API KEY', async () => {
    // A key belongs to a workspace and has no person behind it. One that
    // could change its minter's password would be an escalation straight out
    // of its own scope, so the key path is simply not wired on this router.
    const { app, profile } = buildApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('authorization', 'Bearer rk_live_something');

    expect(res.status).toBe(401);
    expect(profile.get).not.toHaveBeenCalled();
  });

  it('refuses a token this server did not sign', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/me').set('authorization', 'Bearer not.a.token');
    expect(res.status).toBe(401);
  });

  it('needs no workspace header', async () => {
    // Nothing here is workspace-scoped. Requiring one would make changing
    // your own password depend on a workspace's billing state.
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/me').set('authorization', await bearer());
    expect(res.status).toBe(200);
  });
});

describe('GET /me', () => {
  it('answers the profile from the token subject', async () => {
    const { app, profile } = buildApp();
    const res = await request(app).get('/api/v1/me').set('authorization', await bearer());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(PROFILE);
    expect(vi.mocked(profile.get).mock.calls[0]?.[0]).toBe(USER);
  });
});

describe('PATCH /me', () => {
  it('trims the name before the service sees it', async () => {
    const { app, profile } = buildApp();
    await request(app)
      .patch('/api/v1/me')
      .set('authorization', await bearer())
      .send({ name: '  Dana H.  ' });

    expect(vi.mocked(profile.updateName).mock.calls[0]?.[1]).toBe('Dana H.');
  });

  it('rejects an attempt to set the email through it', async () => {
    // Strict schema. The address is an identity, not an attribute, and it
    // moves only through a proved change.
    const { app } = buildApp();
    const res = await request(app)
      .patch('/api/v1/me')
      .set('authorization', await bearer())
      .send({ name: 'Dana', email: 'attacker@example.com' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('rejects an empty name with a named field', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .patch('/api/v1/me')
      .set('authorization', await bearer())
      .send({ name: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain('name');
  });
});

describe('POST /me/password', () => {
  it('hands the service the session id from the token, not the body', async () => {
    // The session kept alive must be the one making the request. Taking it
    // from the body would let a caller keep a session that is not theirs.
    const { app, profile } = buildApp();
    await request(app)
      .post('/api/v1/me/password')
      .set('authorization', await bearer())
      .send({ currentPassword: 'old one', newPassword: 'a new long password' });

    expect(vi.mocked(profile.changePassword).mock.calls[0]?.[0]).toMatchObject({
      userId: USER,
      sessionId: SESSION,
    });
  });

  it('enforces the minimum length on the new password', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/me/password')
      .set('authorization', await bearer())
      .send({ currentPassword: 'old one', newPassword: 'short' });

    expect(res.status).toBe(400);
  });

  it('maps a wrong current password to 401', async () => {
    const { app } = buildApp({
      changePassword: vi.fn(async () => {
        throw new AppError('unauthenticated', 'Your current password is incorrect', 401);
      }),
    });

    const res = await request(app)
      .post('/api/v1/me/password')
      .set('authorization', await bearer())
      .send({ currentPassword: 'wrong', newPassword: 'a new long password' });

    expect(res.status).toBe(401);
  });

  it('never echoes either password', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/me/password')
      .set('authorization', await bearer())
      .send({ currentPassword: 'old one', newPassword: 'a new long password' });

    expect(JSON.stringify(res.body)).not.toContain('a new long password');
  });
});

describe('POST /me/email-change', () => {
  it('answers 202, because nothing has changed yet', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/me/email-change')
      .set('authorization', await bearer())
      .send({ newEmail: 'New@Example.ORG ', currentPassword: 'old one' });

    expect(res.status).toBe(202);
    expect(res.body.data.pending).toBe(true);
  });

  it('normalises the address before the service sees it', async () => {
    const { app, profile } = buildApp();
    await request(app)
      .post('/api/v1/me/email-change')
      .set('authorization', await bearer())
      .send({ newEmail: '  New@Example.ORG ', currentPassword: 'old one' });

    expect(vi.mocked(profile.startEmailChange).mock.calls[0]?.[0]).toMatchObject({
      newEmail: 'new@example.org',
    });
  });

  it('requires the current password', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/me/email-change')
      .set('authorization', await bearer())
      .send({ newEmail: 'new@example.org' });

    expect(res.status).toBe(400);
  });
});

describe('sessions over HTTP', () => {
  it('lists them for the token subject and marks this device', async () => {
    const { app, profile } = buildApp();
    const res = await request(app)
      .get('/api/v1/me/sessions')
      .set('authorization', await bearer());

    expect(res.status).toBe(200);
    expect(res.body.data[0].current).toBe(true);
    expect(vi.mocked(profile.listSessions).mock.calls[0]).toEqual([USER, SESSION]);
  });

  it('revokes one and answers 204', async () => {
    const { app, profile } = buildApp();
    const res = await request(app)
      .delete(`/api/v1/me/sessions/${OTHER_SESSION}`)
      .set('authorization', await bearer());

    expect(res.status).toBe(204);
    expect(vi.mocked(profile.revokeSession).mock.calls[0]).toEqual([USER, OTHER_SESSION]);
  });

  it('answers 404 for a malformed session id, exactly as for a stranger one', async () => {
    // Same answer both ways, so the shape of an id cannot be used to tell
    // "no such session" from "not yours".
    const { app, profile } = buildApp({
      revokeSession: vi.fn(async () => {
        throw new AppError('not_found', 'Session not found', 404);
      }),
    });

    const malformed = await request(app)
      .delete('/api/v1/me/sessions/not-a-uuid')
      .set('authorization', await bearer());
    const stranger = await request(app)
      .delete(`/api/v1/me/sessions/${OTHER_SESSION}`)
      .set('authorization', await bearer());

    expect(malformed.status).toBe(404);
    expect(stranger.status).toBe(404);
    expect(malformed.body.error.code).toBe(stranger.body.error.code);
    // A malformed id never reached the service at all.
    expect(profile.revokeSession).toHaveBeenCalledOnce();
  });

  it('revokes the rest and answers 204', async () => {
    const { app, profile } = buildApp();
    const res = await request(app)
      .delete('/api/v1/me/sessions')
      .set('authorization', await bearer());

    expect(res.status).toBe(204);
    expect(vi.mocked(profile.revokeOtherSessions).mock.calls[0]).toEqual([USER, SESSION]);
  });
});
