import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import type { SessionId, UserId } from '@relayd/types';
import type { DatabasePool } from '@relayd/db';
import type { RedisConnection } from '@relayd/queue';
import { createApp } from '../src/app.js';
import type { AuthService } from '../src/services/auth.js';
import { TokenService } from '../src/services/tokens.js';

/**
 * The account-shaped half of /auth: who is signed in, and resending a
 * verification link.
 *
 * The session payload is the interesting one. It rides on register, login and
 * refresh rather than living behind a separate call, because the SPA needs a
 * name and a workspace list to draw its first frame and a second request would
 * cost a round trip on every load — and leave a window in which the shell has
 * a token and nothing to render. `GET /auth/session` answers the same thing
 * for a caller that already holds an access token, without spending a refresh
 * token to do it.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const USER = '0192f4a1-0000-7000-8000-00000000000a' as UserId;

const USER_PAYLOAD = {
  id: USER,
  name: 'Dana Haddad',
  email: 'dana@northwind.travel',
  emailVerified: true,
};

const MEMBERSHIPS = [
  {
    workspaceId: '0192f4a1-0000-7000-8000-000000000001',
    workspaceName: 'Northwind Voyages',
    workspaceSlug: 'northwind-voyages',
    role: 'owner' as const,
  },
];

const TOKENS = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  sessionId: 'session-1' as SessionId,
  user: USER_PAYLOAD,
  memberships: MEMBERSHIPS,
};

const tokens = new TokenService({
  privateKeyPem: privateKey,
  publicKeyPem: publicKey,
  keyId: 'k1',
  accessTokenTtlSeconds: 900,
});

function buildApp(overrides: Partial<Record<keyof AuthService, unknown>> = {}) {
  const auth = {
    register: vi.fn(async () => TOKENS),
    login: vi.fn(async () => TOKENS),
    refresh: vi.fn(async () => TOKENS),
    logout: vi.fn(async () => undefined),
    session: vi.fn(async () => ({ user: USER_PAYLOAD, memberships: MEMBERSHIPS })),
    verifyEmail: vi.fn(async () => ({ verified: true, email: USER_PAYLOAD.email })),
    resendEmailVerification: vi.fn(async () => undefined),
    requestPasswordReset: vi.fn(async () => undefined),
    resetPassword: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as AuthService;

  const app = createApp({
    pool: { query: vi.fn(async () => ({ rows: [] })) } as unknown as DatabasePool,
    redis: { ping: vi.fn(async () => 'PONG') } as unknown as RedisConnection,
    logger: createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    auth: { auth, secureCookies: false, refreshTtlDays: 30, tokens },
  });

  return { app, auth };
}

async function bearer(): Promise<string> {
  const token = await tokens.issueAccessToken({
    sub: USER,
    sid: 'session-1',
    wsIds: [],
    ver: 1,
  });
  return `Bearer ${token}`;
}

describe('the session payload on the token responses', () => {
  it('carries the user and the memberships on login', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'dana@northwind.travel', password: 'correct horse battery staple' });

    expect(res.status).toBe(200);
    expect(res.body.data.user).toEqual(USER_PAYLOAD);
    expect(res.body.data.memberships).toEqual(MEMBERSHIPS);
  });

  it('carries it on refresh too, so a reload knows who you are', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', ['relayd_refresh=whatever']);

    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe('Dana Haddad');
  });

  it('still never puts the refresh token in the body', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'dana@northwind.travel', password: 'correct horse battery staple' });

    expect(JSON.stringify(res.body)).not.toContain(TOKENS.refreshToken);
  });
});

describe('GET /auth/session', () => {
  it('answers who is signed in', async () => {
    const { app, auth } = buildApp();
    const res = await request(app)
      .get('/api/v1/auth/session')
      .set('authorization', await bearer());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ user: USER_PAYLOAD, memberships: MEMBERSHIPS });
    expect(vi.mocked(auth.session).mock.calls[0]?.[0]).toBe(USER);
  });

  it('refuses an unauthenticated caller', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/auth/session');
    expect(res.status).toBe(401);
  });

  it('DOES NOT ROTATE THE REFRESH COOKIE', async () => {
    // The whole reason this exists next to /auth/refresh: re-reading who you
    // are must not spend the long-lived credential.
    const { app, auth } = buildApp();
    const res = await request(app)
      .get('/api/v1/auth/session')
      .set('authorization', await bearer());

    expect(res.headers['set-cookie']).toBeUndefined();
    expect(auth.refresh).not.toHaveBeenCalled();
  });
});

describe('POST /auth/resend-verification', () => {
  it('answers 202 for an address with no account', async () => {
    // Same answer for every address. Anything else is an enumeration oracle
    // (docs/06), and this one would also leak whether the account is verified.
    const { app } = buildApp();
    const unknown = await request(app)
      .post('/api/v1/auth/resend-verification')
      .send({ email: 'nobody@example.com' });
    const known = await request(app)
      .post('/api/v1/auth/resend-verification')
      .send({ email: 'dana@northwind.travel' });

    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(unknown.body).toEqual(known.body);
  });

  it('accepts an empty body from a page that has no address', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/v1/auth/resend-verification').send({});
    expect(res.status).toBe(202);
  });

  it('normalises the address before the service sees it', async () => {
    const { app, auth } = buildApp();
    await request(app)
      .post('/api/v1/auth/resend-verification')
      .send({ email: '  Dana@Northwind.TRAVEL ' });

    expect(vi.mocked(auth.resendEmailVerification).mock.calls[0]?.[0]).toEqual({
      email: 'dana@northwind.travel',
    });
  });

  it('PREFERS THE TOKEN SUBJECT OVER AN ADDRESS IN THE BODY', async () => {
    // A signed-in caller must not be able to aim somebody else's verification
    // email by putting another address in the body.
    const { app, auth } = buildApp();
    await request(app)
      .post('/api/v1/auth/resend-verification')
      .set('authorization', await bearer())
      .send({ email: 'victim@example.com' });

    expect(vi.mocked(auth.resendEmailVerification).mock.calls[0]?.[0]).toEqual({ userId: USER });
  });

  it('falls back to the body when the bearer token is junk', async () => {
    const { app, auth } = buildApp();
    const res = await request(app)
      .post('/api/v1/auth/resend-verification')
      .set('authorization', 'Bearer nonsense')
      .send({ email: 'dana@northwind.travel' });

    // An invalid token is "not signed in" here, not a 401: the endpoint is
    // reachable by somebody who cannot log in yet, which is the whole point.
    expect(res.status).toBe(202);
    expect(vi.mocked(auth.resendEmailVerification).mock.calls[0]?.[0]).toEqual({
      email: 'dana@northwind.travel',
    });
  });

  it('rejects an unknown field rather than dropping it', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/auth/resend-verification')
      .send({ email: 'dana@northwind.travel', userId: 'someone-else' });

    expect(res.status).toBe(400);
  });
});

describe('POST /auth/verify-email', () => {
  it('names the address that ended up verified', async () => {
    // B3b prints it, and after an email change it is not the address the
    // browser started with.
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: 'a-token' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ verified: true, email: 'dana@northwind.travel' });
  });
});
