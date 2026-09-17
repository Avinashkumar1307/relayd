import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserId } from '@relayd/types';
import { hashPassword, hashToken } from '@relayd/utils';
import { AuthService } from '../src/services/auth.js';
import { buildWorld } from './support/world.js';
import { TokenService } from '../src/services/tokens.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function buildService(world: ReturnType<typeof buildWorld>) {
  let counter = 0;
  const notifier = {
    sendEmailVerification: vi.fn<(to: string, token: string) => Promise<void>>(
      async () => undefined,
    ),
    sendPasswordReset: vi.fn<(to: string, token: string) => Promise<void>>(
      async () => undefined,
    ),
  };

  const service = new AuthService({
    unitOfWork: async (fn) => fn(world.repos),
    tokens: new TokenService({
      privateKeyPem: privateKey,
      publicKeyPem: publicKey,
      keyId: 'k1',
      accessTokenTtlSeconds: 900,
    }),
    notifier,
    newId: () => `id-${++counter}`,
    now: world.now,
    refreshTtlDays: 30,
  });

  return { service, notifier };
}


/**
 * The nth call's arguments, asserting it happened.
 *
 * noUncheckedIndexedAccess makes mock.calls[n] possibly undefined, which is
 * correct: a test that reads arguments from a call that never occurred should
 * fail loudly rather than destructure undefined.
 */
function callArgs<A extends unknown[]>(mock: { mock: { calls: A[] } }, index = 0): A {
  const call = mock.mock.calls[index];
  if (call === undefined) {
    throw new Error(`expected at least ${index + 1} call(s), got ${mock.mock.calls.length}`);
  }
  return call;
}

const REGISTRATION = {
  email: 'aisha@example.com',
  name: 'Aisha',
  password: 'correct horse battery staple',
  workspaceName: 'Acme',
  workspaceSlug: 'acme',
};

let world: ReturnType<typeof buildWorld>;
let service: AuthService;
let notifier: ReturnType<typeof buildService>['notifier'];

beforeEach(() => {
  world = buildWorld();
  ({ service, notifier } = buildService(world));
});

describe('register', () => {
  it('creates user, workspace and owner membership together', async () => {
    await service.register(REGISTRATION);

    expect(world.users).toHaveLength(1);
    expect(world.workspaces).toHaveLength(1);
    expect(world.members).toHaveLength(1);
    expect(world.members[0]?.role).toBe('owner');
  });

  it('issues a verification token and emails it', async () => {
    await service.register(REGISTRATION);

    expect(notifier.sendEmailVerification).toHaveBeenCalledOnce();
    const [to, token] = callArgs(notifier.sendEmailVerification);
    expect(to).toBe(REGISTRATION.email);
    // Stored hashed, never in clear.
    expect(world.tokens[0]?.tokenHash.equals(hashToken(token))).toBe(true);
    expect(JSON.stringify(world.tokens)).not.toContain(token);
  });

  it('never stores the password in clear', async () => {
    await service.register(REGISTRATION);
    expect(world.users[0]?.passwordHash).not.toBe(REGISTRATION.password);
    expect(world.users[0]?.passwordHash?.startsWith('$argon2id$')).toBe(true);
  });

  it('rejects a duplicate address', async () => {
    await service.register(REGISTRATION);
    await expect(service.register(REGISTRATION)).rejects.toMatchObject({ status: 409 });
  });

  it('returns a usable session', async () => {
    const result = await service.register(REGISTRATION);
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(world.sessions).toHaveLength(1);
  });
});

describe('login', () => {
  beforeEach(async () => {
    await service.register(REGISTRATION);
  });

  it('succeeds with the right password', async () => {
    const result = await service.login(REGISTRATION.email, REGISTRATION.password);
    expect(result.accessToken).toBeTruthy();
    expect(world.users[0]?.lastLoginAt).not.toBeNull();
  });

  it('gives the same error for a wrong password and an unknown account', async () => {
    const wrong = await service.login(REGISTRATION.email, 'nope').catch((e: Error) => e);
    const missing = await service.login('nobody@example.com', 'nope').catch((e: Error) => e);

    expect(wrong).toMatchObject({ status: 401 });
    expect(missing).toMatchObject({ status: 401 });
    // Identical message: no enumeration oracle (docs/06).
    expect((wrong as Error).message).toBe((missing as Error).message);
  });

  it('refuses a suspended account', async () => {
    const user = world.users[0];
    if (user !== undefined) user.status = 'suspended';
    await expect(service.login(REGISTRATION.email, REGISTRATION.password)).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe('refresh rotation and theft detection', () => {
  let initial: Awaited<ReturnType<AuthService['register']>>;

  beforeEach(async () => {
    initial = await service.register(REGISTRATION);
  });

  it('issues a new refresh token and retires the old one', async () => {
    const rotated = await service.refresh(initial.refreshToken);

    expect(rotated.refreshToken).not.toBe(initial.refreshToken);
    const old = world.sessions.find((s) => s.id === initial.sessionId);
    expect(old?.revokedAt).not.toBeNull();
    expect(old?.replacedBy).toBe(rotated.sessionId);
  });

  it('keeps the successor in the same rotation family', async () => {
    const rotated = await service.refresh(initial.refreshToken);
    const first = world.sessions.find((s) => s.id === initial.sessionId);
    const second = world.sessions.find((s) => s.id === rotated.sessionId);
    expect(second?.familyId).toBe(first?.familyId);
  });

  it('REVOKES THE WHOLE FAMILY when a consumed token is presented again', async () => {
    // The leaked-token scenario: attacker replays a token the real user
    // already rotated away from.
    const second = await service.refresh(initial.refreshToken);
    const third = await service.refresh(second.refreshToken);

    await expect(service.refresh(initial.refreshToken)).rejects.toMatchObject({ status: 401 });

    // Every session in the family is dead, including the one the legitimate
    // user was still holding.
    const family = world.sessions.filter((s) => s.familyId === world.sessions[0]?.familyId);
    expect(family.every((s) => s.revokedAt !== null)).toBe(true);
    await expect(service.refresh(third.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an unknown token', async () => {
    await expect(service.refresh('not-a-real-token')).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an expired session', async () => {
    const session = world.sessions[0];
    if (session !== undefined) session.expiresAt = new Date('2020-01-01T00:00:00Z');
    await expect(service.refresh(initial.refreshToken)).rejects.toMatchObject({ status: 401 });
  });
});

describe('logout', () => {
  it('revokes the presented session and nothing else', async () => {
    const a = await service.register(REGISTRATION);
    const b = await service.login(REGISTRATION.email, REGISTRATION.password);

    await service.logout(a.refreshToken);

    expect(world.sessions.find((s) => s.id === a.sessionId)?.revokedAt).not.toBeNull();
    expect(world.sessions.find((s) => s.id === b.sessionId)?.revokedAt).toBeNull();
  });

  it('is silent about an unknown token', async () => {
    await expect(service.logout('nonsense')).resolves.toBeUndefined();
  });
});

describe('email verification', () => {
  it('marks the address verified and consumes the token', async () => {
    await service.register(REGISTRATION);
    const [, token] = callArgs(notifier.sendEmailVerification);

    await service.verifyEmail(token);

    expect(world.users[0]?.emailVerifiedAt).not.toBeNull();
    expect(world.tokens[0]?.consumedAt).not.toBeNull();
  });

  it('refuses a second use of the same link', async () => {
    await service.register(REGISTRATION);
    const [, token] = callArgs(notifier.sendEmailVerification);

    await service.verifyEmail(token);
    await expect(service.verifyEmail(token)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an unknown link', async () => {
    await expect(service.verifyEmail('made-up')).rejects.toMatchObject({ status: 404 });
  });
});

describe('password reset', () => {
  beforeEach(async () => {
    await service.register(REGISTRATION);
  });

  it('resolves for an unknown address without sending anything', async () => {
    await expect(service.requestPasswordReset('nobody@example.com')).resolves.toBeUndefined();
    expect(notifier.sendPasswordReset).not.toHaveBeenCalled();
  });

  it('supersedes an outstanding reset so only the newest link works', async () => {
    await service.requestPasswordReset(REGISTRATION.email);
    await service.requestPasswordReset(REGISTRATION.email);

    const [, first] = callArgs(notifier.sendPasswordReset);
    const [, second] = callArgs(notifier.sendPasswordReset, 1);

    await expect(service.resetPassword(first, 'new-password-1')).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.resetPassword(second, 'new-password-2')).resolves.toBeUndefined();
  });

  it('changes the password and kills every existing session', async () => {
    const live = await service.login(REGISTRATION.email, REGISTRATION.password);
    await service.requestPasswordReset(REGISTRATION.email);
    const [, token] = callArgs(notifier.sendPasswordReset);

    await service.resetPassword(token, 'a brand new password');

    expect(world.sessions.every((s) => s.revokedAt !== null)).toBe(true);
    await expect(service.refresh(live.refreshToken)).rejects.toMatchObject({ status: 401 });
    await expect(
      service.login(REGISTRATION.email, 'a brand new password'),
    ).resolves.toBeTruthy();
    await expect(
      service.login(REGISTRATION.email, REGISTRATION.password),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a reused reset link', async () => {
    await service.requestPasswordReset(REGISTRATION.email);
    const [, token] = callArgs(notifier.sendPasswordReset);

    await service.resetPassword(token, 'first-new-password');
    await expect(service.resetPassword(token, 'second-new-password')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('session management', () => {
  it('lists only live sessions', async () => {
    const a = await service.register(REGISTRATION);
    await service.login(REGISTRATION.email, REGISTRATION.password);
    await service.logout(a.refreshToken);

    const listed = await service.listSessions(world.users[0]!.id);
    expect(listed).toHaveLength(1);
  });

  it('refuses to revoke a session belonging to someone else', async () => {
    await service.register(REGISTRATION);
    const otherUserId = 'someone-else' as UserId;
    await expect(
      service.revokeSession(otherUserId, world.sessions[0]!.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(world.sessions[0]?.revokedAt).toBeNull();
  });

  it('revokes a session the caller owns', async () => {
    const a = await service.register(REGISTRATION);
    await expect(service.revokeSession(world.users[0]!.id, a.sessionId)).resolves.toBe(true);
  });
});

describe('password hashing cost', () => {
  it('is applied even for an account that does not exist', async () => {
    // Guards the enumeration defence: if the missing-account path skipped the
    // dummy verify, absence would be measurably faster.
    const start = Date.now();
    await service.login('nobody@example.com', 'whatever').catch(() => undefined);
    const missingMs = Date.now() - start;

    await service.register(REGISTRATION);
    const start2 = Date.now();
    await service.login(REGISTRATION.email, 'wrong').catch(() => undefined);
    const wrongMs = Date.now() - start2;

    // Same order of magnitude; argon2 dominates both.
    expect(missingMs).toBeGreaterThan(wrongMs / 10);
  });
});

describe('stored hash format', () => {
  it('is argon2id with the documented cost', async () => {
    const hash = await hashPassword('x');
    expect(hash).toContain('$argon2id$');
    expect(hash).toContain('m=65536,t=3,p=4');
  });
});
