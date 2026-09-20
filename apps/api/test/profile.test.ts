import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@relayd/types';
import { hashToken } from '@relayd/utils';
import { AuthService } from '../src/services/auth.js';
import {
  ProfileService,
  describeUserAgent,
  relativeLabel,
} from '../src/services/profile.js';
import { TokenService } from '../src/services/tokens.js';
import { buildWorld } from './support/world.js';
import { generateKeyPairSync } from 'node:crypto';

/**
 * J5 — the signed-in person.
 *
 * Nothing here is workspace-scoped, which is the point and the risk. The
 * repositories these call live under `repositories/global/` and take no
 * `WorkspaceScope`, so the check that normally holds tenants apart is absent
 * by design. What replaces it is the subject: every method takes the user id
 * from a verified access token, and the tests below spend most of their effort
 * on the two places that could still cross a person boundary — revoking
 * somebody else's session, and moving an account onto somebody else's address.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const REGISTRATION = {
  email: 'dana@northwind.travel',
  name: 'Dana Haddad',
  password: 'correct horse battery staple',
  workspaceName: 'Northwind Voyages',
  workspaceSlug: 'northwind-voyages',
};

let world: ReturnType<typeof buildWorld>;
let auth: AuthService;
let profile: ProfileService;
let notifier: {
  sendEmailVerification: ReturnType<typeof vi.fn>;
  sendPasswordReset: ReturnType<typeof vi.fn>;
};
/** Mutable, so a cooldown can be waited out without waiting. */
let clock: Date;

function build() {
  let counter = 0;
  const now = () => clock;

  notifier = {
    sendEmailVerification: vi.fn(async () => undefined),
    sendPasswordReset: vi.fn(async () => undefined),
  };

  const unitOfWork = async <T>(fn: (repos: typeof world.repos) => Promise<T>) => fn(world.repos);

  auth = new AuthService({
    unitOfWork,
    tokens: new TokenService({
      privateKeyPem: privateKey,
      publicKeyPem: publicKey,
      keyId: 'k1',
      accessTokenTtlSeconds: 900,
    }),
    notifier,
    newId: () => `id-${++counter}`,
    now,
    refreshTtlDays: 30,
  });

  profile = new ProfileService({
    unitOfWork,
    notifier,
    newId: () => `id-${++counter}`,
    now,
  });
}

/** The nth call's arguments, asserting the call happened. */
function callArgs<A extends unknown[]>(mock: { mock: { calls: A[] } }, index = 0): A {
  const call = mock.mock.calls[index];
  if (call === undefined) {
    throw new Error(`expected at least ${index + 1} call(s), got ${mock.mock.calls.length}`);
  }
  return call;
}

beforeEach(() => {
  // One clock for the world and the services. A cooldown is a comparison
  // between a row's created_at and the service's now, and two clocks would
  // make that test prove nothing.
  clock = new Date('2026-09-19T12:00:00Z');
  world = buildWorld(() => clock);
  build();
});

describe('reading the profile', () => {
  it('answers name, address, verification and the created date', async () => {
    const session = await auth.register(REGISTRATION);

    const found = await profile.get(session.user.id);

    expect(found).toMatchObject({
      name: 'Dana Haddad',
      email: 'dana@northwind.travel',
      emailVerified: false,
    });
    expect(typeof found.createdAt).toBe('string');
  });

  it('never returns the password hash', async () => {
    const session = await auth.register(REGISTRATION);
    const found = await profile.get(session.user.id);
    expect(JSON.stringify(found)).not.toContain('argon2');
  });

  it('refuses a token minted for an account that has since been suspended', async () => {
    const session = await auth.register(REGISTRATION);
    const user = world.users[0];
    if (user !== undefined) user.status = 'suspended';

    // 401, not 404: the account is not missing, the caller is not signed in.
    await expect(profile.get(session.user.id)).rejects.toMatchObject({ status: 401 });
  });
});

describe('changing the name', () => {
  it('writes it and answers the updated profile', async () => {
    const session = await auth.register(REGISTRATION);

    const updated = await profile.updateName(session.user.id, 'Dana H.');

    expect(updated.name).toBe('Dana H.');
    expect(world.users[0]?.name).toBe('Dana H.');
  });
});

describe('changing the password', () => {
  it('requires the current password', async () => {
    const session = await auth.register(REGISTRATION);

    await expect(
      profile.changePassword({
        userId: session.user.id,
        sessionId: session.sessionId,
        currentPassword: 'not the password',
        newPassword: 'a brand new long password',
      }),
    ).rejects.toMatchObject({ status: 401 });

    // Nothing moved.
    expect(
      await auth.login(REGISTRATION.email, REGISTRATION.password),
    ).toBeTruthy();
  });

  it('replaces the hash so the old password stops working', async () => {
    const session = await auth.register(REGISTRATION);

    await profile.changePassword({
      userId: session.user.id,
      sessionId: session.sessionId,
      currentPassword: REGISTRATION.password,
      newPassword: 'a brand new long password',
    });

    await expect(auth.login(REGISTRATION.email, REGISTRATION.password)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      auth.login(REGISTRATION.email, 'a brand new long password'),
    ).resolves.toBeTruthy();
  });

  it('SIGNS OUT EVERY OTHER SESSION AND KEEPS THIS ONE', async () => {
    // J5 says so in as many words, and both halves matter: the other devices
    // must die, and the browser doing the securing must not — being logged
    // out for securing your account teaches you not to.
    const first = await auth.register(REGISTRATION);
    const second = await auth.login(REGISTRATION.email, REGISTRATION.password);
    const third = await auth.login(REGISTRATION.email, REGISTRATION.password);

    const result = await profile.changePassword({
      userId: first.user.id,
      sessionId: first.sessionId,
      currentPassword: REGISTRATION.password,
      newPassword: 'a brand new long password',
    });

    expect(result.otherSessionsRevoked).toBe(2);
    expect(world.sessions.find((s) => s.id === first.sessionId)?.revokedAt).toBeNull();
    expect(world.sessions.find((s) => s.id === second.sessionId)?.revokedAt).not.toBeNull();
    expect(world.sessions.find((s) => s.id === third.sessionId)?.revokedAt).not.toBeNull();
  });

  it('kills outstanding reset links', async () => {
    // One left live in an inbox after a password change is a standing
    // takeover primitive.
    const session = await auth.register(REGISTRATION);
    await auth.requestPasswordReset(REGISTRATION.email);
    const [, resetToken] = callArgs(notifier.sendPasswordReset);

    await profile.changePassword({
      userId: session.user.id,
      sessionId: session.sessionId,
      currentPassword: REGISTRATION.password,
      newPassword: 'a brand new long password',
    });

    await expect(auth.resetPassword(resetToken as string, 'attacker password')).rejects.toMatchObject(
      { status: 404 },
    );
  });
});

describe('changing the email', () => {
  async function registered() {
    const session = await auth.register(REGISTRATION);
    notifier.sendEmailVerification.mockClear();
    return session;
  }

  it('does not move the address until the new one is proved', async () => {
    const session = await registered();

    await profile.startEmailChange({
      userId: session.user.id,
      newEmail: 'dana@example.org',
      currentPassword: REGISTRATION.password,
    });

    expect(world.users[0]?.email).toBe('dana@northwind.travel');
  });

  it('sends the link to the NEW address, never the old one', async () => {
    const session = await registered();

    await profile.startEmailChange({
      userId: session.user.id,
      newEmail: 'dana@example.org',
      currentPassword: REGISTRATION.password,
    });

    const [to] = callArgs(notifier.sendEmailVerification);
    expect(to).toBe('dana@example.org');
  });

  it('applies the change when the emailed link is opened', async () => {
    const session = await registered();
    await profile.startEmailChange({
      userId: session.user.id,
      newEmail: 'dana@example.org',
      currentPassword: REGISTRATION.password,
    });
    const [, token] = callArgs(notifier.sendEmailVerification);

    const result = await auth.verifyEmail(token as string);

    expect(result).toEqual({ verified: true, email: 'dana@example.org' });
    expect(world.users[0]?.email).toBe('dana@example.org');
    // Proved by opening it, so verified in the same breath.
    expect(world.users[0]?.emailVerifiedAt).not.toBeNull();
  });

  it('requires the current password', async () => {
    const session = await registered();

    await expect(
      profile.startEmailChange({
        userId: session.user.id,
        newEmail: 'dana@example.org',
        currentPassword: 'wrong',
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(notifier.sendEmailVerification).not.toHaveBeenCalled();
  });

  it('refuses an address that already has an account, before emailing anything', async () => {
    const session = await registered();
    await auth.register({ ...REGISTRATION, email: 'omar@northwind.travel', workspaceSlug: 'other' });
    notifier.sendEmailVerification.mockClear();

    await expect(
      profile.startEmailChange({
        userId: session.user.id,
        newEmail: 'omar@northwind.travel',
        currentPassword: REGISTRATION.password,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(notifier.sendEmailVerification).not.toHaveBeenCalled();
  });

  it('REFUSES TO LAND ON AN ADDRESS CLAIMED SINCE THE LINK WAS SENT', async () => {
    // The race the unique index exists for: two people ask to move to the
    // same address, and the second link must fail rather than collide.
    const session = await registered();
    await profile.startEmailChange({
      userId: session.user.id,
      newEmail: 'shared@example.org',
      currentPassword: REGISTRATION.password,
    });
    const [, token] = callArgs(notifier.sendEmailVerification);

    await auth.register({
      ...REGISTRATION,
      email: 'shared@example.org',
      workspaceSlug: 'claimed',
    });

    await expect(auth.verifyEmail(token as string)).rejects.toMatchObject({ status: 409 });
    expect(world.users[0]?.email).toBe('dana@northwind.travel');
  });

  it('supersedes an outstanding change so only the newest link works', async () => {
    const session = await registered();
    await profile.startEmailChange({
      userId: session.user.id,
      newEmail: 'first@example.org',
      currentPassword: REGISTRATION.password,
    });
    await profile.startEmailChange({
      userId: session.user.id,
      newEmail: 'second@example.org',
      currentPassword: REGISTRATION.password,
    });

    const [, first] = callArgs(notifier.sendEmailVerification);
    const [, second] = callArgs(notifier.sendEmailVerification, 1);

    await expect(auth.verifyEmail(first as string)).rejects.toMatchObject({ status: 404 });
    await expect(auth.verifyEmail(second as string)).resolves.toMatchObject({
      email: 'second@example.org',
    });
  });

  it('refuses the address the account already has', async () => {
    const session = await registered();

    await expect(
      profile.startEmailChange({
        userId: session.user.id,
        newEmail: REGISTRATION.email,
        currentPassword: REGISTRATION.password,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('will not let a password-reset token be redeemed as a verification', async () => {
    // Two flows, two purposes. One standing in for the other is how a reset
    // link forwarded to a colleague becomes something else entirely.
    await registered();
    await auth.requestPasswordReset(REGISTRATION.email);
    const [, resetToken] = callArgs(notifier.sendPasswordReset);

    await expect(auth.verifyEmail(resetToken as string)).rejects.toMatchObject({ status: 404 });
    expect(world.tokens.find((t) => t.purpose === 'password_reset')?.consumedAt).toBeNull();
  });
});

describe('sessions', () => {
  it('marks exactly one row as this device', async () => {
    const first = await auth.register(REGISTRATION);
    await auth.login(REGISTRATION.email, REGISTRATION.password);

    const rows = await profile.listSessions(first.user.id, first.sessionId);

    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.current)).toHaveLength(1);
    expect(rows.find((row) => row.current)?.id).toBe(first.sessionId);
  });

  it('lists nobody else', async () => {
    const mine = await auth.register(REGISTRATION);
    const theirs = await auth.register({
      ...REGISTRATION,
      email: 'omar@northwind.travel',
      workspaceSlug: 'omar',
    });

    const rows = await profile.listSessions(mine.user.id, mine.sessionId);

    expect(rows.map((row) => row.id)).not.toContain(theirs.sessionId);
  });

  it('REFUSES TO REVOKE A SESSION THAT IS NOT THE CALLERS, WITH 404', async () => {
    // 404 rather than 403: a member must not be able to probe for other
    // people's session ids (CLAUDE.md section 11).
    const mine = await auth.register(REGISTRATION);
    const theirs = await auth.register({
      ...REGISTRATION,
      email: 'omar@northwind.travel',
      workspaceSlug: 'omar',
    });

    await expect(profile.revokeSession(mine.user.id, theirs.sessionId)).rejects.toMatchObject({
      status: 404,
    });
    expect(world.sessions.find((s) => s.id === theirs.sessionId)?.revokedAt).toBeNull();
  });

  it('gives the same 404 for a session id that never existed', async () => {
    const mine = await auth.register(REGISTRATION);

    await expect(
      profile.revokeSession(mine.user.id, 'no-such-session' as SessionId),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('revokes one of the caller own sessions', async () => {
    const first = await auth.register(REGISTRATION);
    const second = await auth.login(REGISTRATION.email, REGISTRATION.password);

    await profile.revokeSession(first.user.id, second.sessionId);

    expect(world.sessions.find((s) => s.id === second.sessionId)?.revokedAt).not.toBeNull();
    expect(world.sessions.find((s) => s.id === first.sessionId)?.revokedAt).toBeNull();
  });

  it('revokes every other session and keeps this one', async () => {
    const first = await auth.register(REGISTRATION);
    await auth.login(REGISTRATION.email, REGISTRATION.password);
    await auth.login(REGISTRATION.email, REGISTRATION.password);

    const result = await profile.revokeOtherSessions(first.user.id, first.sessionId);

    expect(result.revoked).toBe(2);
    expect(world.sessions.find((s) => s.id === first.sessionId)?.revokedAt).toBeNull();
  });

  it('does not touch another user when revoking the rest', async () => {
    const mine = await auth.register(REGISTRATION);
    const theirs = await auth.register({
      ...REGISTRATION,
      email: 'omar@northwind.travel',
      workspaceSlug: 'omar',
    });

    await profile.revokeOtherSessions(mine.user.id, mine.sessionId);

    expect(world.sessions.find((s) => s.id === theirs.sessionId)?.revokedAt).toBeNull();
  });
});

describe('reading a user agent', () => {
  it('names the two lines J5 prints', () => {
    const mac = describeUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    );
    expect(mac).toEqual({ device: 'Mac', kind: 'desktop', client: 'Chrome 129 · macOS' });
  });

  it('does not read Edge or Opera as Chrome', () => {
    // Both claim to be Chrome, which claims to be Safari. Order is the fix.
    const edge = describeUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
    );
    expect(edge.client).toBe('Edge 128 · Windows');
    expect(edge.device).toBe('Windows PC');
  });

  it('reads a phone as a phone', () => {
    const iphone = describeUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    );
    expect(iphone.kind).toBe('mobile');
    expect(iphone.device).toBe('iPhone');
    expect(iphone.client).toContain('iOS 17');
  });

  it('separates an Android tablet from an Android phone', () => {
    const phone = describeUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36');
    const tablet = describeUserAgent('Mozilla/5.0 (Linux; Android 14; SM-X200) Safari/537.36');
    expect(phone.device).toBe('Android phone');
    expect(tablet.device).toBe('Android tablet');
  });

  it('says so rather than guessing when it cannot tell', () => {
    // A wrong device name on a security screen is worse than none: the whole
    // point of the row is helping somebody recognise what is not theirs.
    expect(describeUserAgent(null)).toEqual({
      device: 'Unknown device',
      kind: 'unknown',
      client: 'Unknown browser',
    });
    expect(describeUserAgent('curl/8.4.0').device).toBe('Unknown device');
  });
});

describe('the last-active label', () => {
  const at = new Date('2026-09-19T12:00:00Z');
  const after = (ms: number) => new Date(at.getTime() + ms);

  it('calls a session refreshed in the last few minutes live', () => {
    // An access token lives fifteen minutes, so anything inside five is a
    // tab that is open right now.
    expect(relativeLabel(at, after(60_000))).toBe('Active now');
  });

  it('counts in minutes, hours and days', () => {
    expect(relativeLabel(at, after(20 * 60_000))).toBe('20 minutes ago');
    expect(relativeLabel(at, after(2 * 3_600_000))).toBe('2 hours ago');
    expect(relativeLabel(at, after(3 * 86_400_000))).toBe('3 days ago');
  });

  it('says one hour, not 1 hours', () => {
    expect(relativeLabel(at, after(3_600_000))).toBe('1 hour ago');
  });

  it('never counts backwards when the clocks disagree', () => {
    // Session rows are written by the API and read by the API, but a replica
    // a second behind would otherwise render "in 1 second".
    expect(relativeLabel(after(5_000), at)).toBe('Active now');
  });
});

describe('resending the verification email', () => {
  it('sends a fresh link for an unverified address', async () => {
    await auth.register(REGISTRATION);
    notifier.sendEmailVerification.mockClear();
    clock = new Date(clock.getTime() + 120_000);

    await auth.resendEmailVerification({ email: REGISTRATION.email });

    expect(notifier.sendEmailVerification).toHaveBeenCalledOnce();
  });

  it('SUPERSEDES THE PREVIOUS LINK', async () => {
    await auth.register(REGISTRATION);
    const [, first] = callArgs(notifier.sendEmailVerification);
    clock = new Date(clock.getTime() + 120_000);

    await auth.resendEmailVerification({ email: REGISTRATION.email });
    const [, second] = callArgs(notifier.sendEmailVerification, 1);

    await expect(auth.verifyEmail(first as string)).rejects.toMatchObject({ status: 404 });
    await expect(auth.verifyEmail(second as string)).resolves.toMatchObject({ verified: true });
  });

  it('THROTTLES ON THE SERVER CLOCK, NOT THE CLIENT COUNTDOWN', async () => {
    // The 30-second countdown in B3a is a courtesy. This is the control.
    await auth.register(REGISTRATION);
    notifier.sendEmailVerification.mockClear();

    await auth.resendEmailVerification({ email: REGISTRATION.email });
    await auth.resendEmailVerification({ email: REGISTRATION.email });

    expect(notifier.sendEmailVerification).not.toHaveBeenCalled();

    clock = new Date(clock.getTime() + 61_000);
    await auth.resendEmailVerification({ email: REGISTRATION.email });
    expect(notifier.sendEmailVerification).toHaveBeenCalledOnce();
  });

  it('is silent about an address with no account', async () => {
    await expect(
      auth.resendEmailVerification({ email: 'nobody@example.com' }),
    ).resolves.toBeUndefined();
    expect(notifier.sendEmailVerification).not.toHaveBeenCalled();
  });

  it('is silent about an address that is already verified', async () => {
    await auth.register(REGISTRATION);
    const [, token] = callArgs(notifier.sendEmailVerification);
    await auth.verifyEmail(token as string);
    notifier.sendEmailVerification.mockClear();
    clock = new Date(clock.getTime() + 120_000);

    await expect(
      auth.resendEmailVerification({ email: REGISTRATION.email }),
    ).resolves.toBeUndefined();
    expect(notifier.sendEmailVerification).not.toHaveBeenCalled();
  });

  it('identifies a signed-in caller by id, ignoring any address', async () => {
    const session = await auth.register(REGISTRATION);
    notifier.sendEmailVerification.mockClear();
    clock = new Date(clock.getTime() + 120_000);

    await auth.resendEmailVerification({ userId: session.user.id });

    const [to] = callArgs(notifier.sendEmailVerification);
    expect(to).toBe(REGISTRATION.email);
  });

  it('stores the token hashed, never in clear', async () => {
    await auth.register(REGISTRATION);
    clock = new Date(clock.getTime() + 120_000);
    await auth.resendEmailVerification({ email: REGISTRATION.email });

    const [, token] = callArgs(notifier.sendEmailVerification, 1);
    const live = world.tokens.filter((t) => t.consumedAt === null);
    expect(live.some((t) => t.tokenHash.equals(hashToken(token as string)))).toBe(true);
    expect(JSON.stringify(world.tokens)).not.toContain(token);
  });
});

describe('the session payload', () => {
  it('rides on register, login and refresh so a reload knows who you are', async () => {
    const registered = await auth.register(REGISTRATION);
    expect(registered.user).toMatchObject({ name: 'Dana Haddad', email: REGISTRATION.email });
    expect(registered.memberships[0]).toMatchObject({
      workspaceName: 'Northwind Voyages',
      workspaceSlug: 'northwind-voyages',
      role: 'owner',
    });

    const loggedIn = await auth.login(REGISTRATION.email, REGISTRATION.password);
    expect(loggedIn.user.id).toBe(registered.user.id);

    const refreshed = await auth.refresh(loggedIn.refreshToken);
    expect(refreshed.user.id).toBe(registered.user.id);
  });

  it('answers the same payload from /auth/session without rotating anything', async () => {
    const registered = await auth.register(REGISTRATION);
    const before = world.sessions.length;

    const summary = await auth.session(registered.user.id);

    expect(summary.user).toEqual(registered.user);
    expect(summary.memberships).toEqual(registered.memberships);
    // No new session row: reading who you are must not spend a refresh token.
    expect(world.sessions).toHaveLength(before);
  });

  it('carries no password hash', async () => {
    const registered = await auth.register(REGISTRATION);
    expect(JSON.stringify(registered.user)).not.toContain('argon2');
  });

  it('refuses a suspended account', async () => {
    const registered = await auth.register(REGISTRATION);
    const user = world.users[0];
    if (user !== undefined) user.status = 'suspended';

    await expect(auth.session(registered.user.id)).rejects.toMatchObject({ status: 401 });
    await expect(auth.refresh(registered.refreshToken)).rejects.toMatchObject({ status: 401 });
  });
});
