import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import { AppError } from '@relayd/types';
import type { SessionId } from '@relayd/types';
import type { DatabasePool } from '@relayd/db';
import type { RedisConnection } from '@relayd/queue';
import { createApp } from '../src/app.js';
import type { AuthService } from '../src/services/auth.js';

const tokens = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  sessionId: 'session-1' as SessionId,
};

function buildApp(overrides: Partial<Record<keyof AuthService, unknown>> = {}) {
  const auth = {
    register: vi.fn(async () => tokens),
    login: vi.fn(async () => tokens),
    refresh: vi.fn(async () => tokens),
    logout: vi.fn(async () => undefined),
    verifyEmail: vi.fn(async () => undefined),
    requestPasswordReset: vi.fn(async () => undefined),
    resetPassword: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as AuthService;

  const app = createApp({
    pool: { query: vi.fn(async () => ({ rows: [] })) } as unknown as DatabasePool,
    redis: { ping: vi.fn(async () => 'PONG') } as unknown as RedisConnection,
    logger: createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    auth: { auth, secureCookies: false, refreshTtlDays: 30 },
  });

  return { app, auth };
}

const VALID_REGISTRATION = {
  email: 'aisha@example.com',
  name: 'Aisha',
  password: 'correct horse battery staple',
  workspaceName: 'Acme',
  workspaceSlug: 'acme',
};

describe('POST /api/v1/auth/register', () => {
  it('returns 201 with the access token in the body', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/v1/auth/register').send(VALID_REGISTRATION);

    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBe(tokens.accessToken);
  });

  it('puts the refresh token in an HttpOnly SameSite=Lax cookie, never the body', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/v1/auth/register').send(VALID_REGISTRATION);

    const cookie = (res.headers['set-cookie'] as unknown as string[])[0] ?? '';
    expect(cookie).toContain('relayd_refresh=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    // The long-lived credential must never be readable by script.
    expect(JSON.stringify(res.body)).not.toContain(tokens.refreshToken);
  });

  it('rejects an unknown field rather than dropping it', async () => {
    // Strict schemas: docs/06 requires mass-assignment attempts to 400.
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...VALID_REGISTRATION, role: 'owner' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('names the offending field in details', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...VALID_REGISTRATION, password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain('password');
  });

  it('lowercases and trims the email before the service sees it', async () => {
    const { app, auth } = buildApp();
    await request(app)
      .post('/api/v1/auth/register')
      .send({ ...VALID_REGISTRATION, email: '  Aisha@Example.COM ' });

    expect(vi.mocked(auth.register).mock.calls[0]?.[0]).toMatchObject({
      email: 'aisha@example.com',
    });
  });
});

describe('POST /api/v1/auth/login', () => {
  it('returns 200 and sets the cookie', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'aisha@example.com', password: 'correct horse battery staple' });

    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('maps a service 401 to the error envelope', async () => {
    const { app } = buildApp({
      login: vi.fn(async () => {
        throw new AppError('unauthenticated', 'Email or password is incorrect', 401);
      }),
    });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'aisha@example.com', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
    expect(res.body.error.requestId).toBeTruthy();
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('401s when no cookie is present', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('reads the token from the cookie, not the body', async () => {
    const { app, auth } = buildApp();
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', ['relayd_refresh=the-cookie-token']);

    expect(res.status).toBe(200);
    expect(vi.mocked(auth.refresh).mock.calls[0]?.[0]).toBe('the-cookie-token');
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('returns 204 and clears the cookie', async () => {
    const { app, auth } = buildApp();
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', ['relayd_refresh=some-token']);

    expect(res.status).toBe(204);
    expect(auth.logout).toHaveBeenCalledWith('some-token');
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain('relayd_refresh=;');
  });

  it('still clears the cookie when no session was found', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/v1/auth/logout');
    expect(res.status).toBe(204);
    expect(res.headers['set-cookie']).toBeDefined();
  });
});

describe('POST /api/v1/auth/forgot-password', () => {
  it('returns 202 with the same body for any address', async () => {
    const { app } = buildApp();

    const known = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'aisha@example.com' });
    const unknown = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@example.com' });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    // Byte-identical: no enumeration oracle.
    expect(known.body).toEqual(unknown.body);
  });
});

describe('POST /api/v1/auth/reset-password', () => {
  it('clears the cookie, because every session was revoked', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'a-reset-token', password: 'a brand new password' });

    expect(res.status).toBe(200);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain('relayd_refresh=;');
  });
});
