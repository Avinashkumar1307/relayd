import { AppError } from '@relayd/types';
import type { SessionId, UserId } from '@relayd/types';
import { generateToken, hashPassword, hashToken, verifyPassword } from '@relayd/utils';
import type { SessionRow } from '@relayd/db';
import type { Repositories, UnitOfWork } from './auth.js';

/**
 * The signed-in person: J5 `/settings/profile`.
 *
 * ## Why there is no WorkspaceScope in this file
 *
 * CLAUDE.md section 6.2 puts a branded `WorkspaceScope` first on every
 * repository method, and this service calls none that take one. That is not an
 * exemption, it is the same rule applied to a different owner: a person is not
 * owned by a workspace. They exist before any workspace, may belong to several,
 * and a suspended workspace must not stop somebody changing their own password.
 * A scope parameter here would be a lie, and `packages/db/repositories/global/`
 * is where CLAUDE.md puts exactly this case.
 *
 * What replaces it is narrower, not weaker. **Every method takes the `UserId`
 * from the verified access token and nothing else.** No id in a path, no id in
 * a body: `DELETE /me/sessions/:id` carries a session id, and the service
 * checks that session is in the caller's own live list before touching it —
 * and answers 404 when it is not, never 403, so the id space cannot be probed
 * (CLAUDE.md section 11). The scope is the authenticated subject, and it comes
 * from the one place a caller cannot forge.
 *
 * The routes reinforce it: `/me` is mounted without the API-key path, so a key
 * — which has a workspace and no person behind it — cannot reach any of this.
 */

export interface ProfileServiceOptions {
  unitOfWork: UnitOfWork;
  newId: () => string;
  now: () => Date;
  /** Emails the confirmation link to the proposed address. */
  notifier: { sendEmailVerification(to: string, token: string): Promise<void> };
  emailChangeTtlHours?: number;
}

export interface Profile {
  id: UserId;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
}

/**
 * One row of J5's session table.
 *
 * `device`, `client` and `lastActiveLabel` are rendered server-side because
 * they are derived from two things the browser does not have: the stored
 * user-agent of a session that is not the current one, and the clock that
 * decides whether "now" means now.
 */
export interface AccountSession {
  id: SessionId;
  device: string;
  deviceKind: DeviceKind;
  client: string;
  location: string;
  ip: string;
  lastActiveLabel: string;
  /** The raw instant behind the label, for a client that wants to reformat. */
  lastActiveAt: string;
  current: boolean;
}

const HOUR_MS = 60 * 60 * 1000;

export class ProfileService {
  constructor(private readonly options: ProfileServiceOptions) {}

  async get(userId: UserId): Promise<Profile> {
    return this.options.unitOfWork(async (repos) => toProfile(await this.#require(repos, userId)));
  }

  /**
   * Changes the display name, and only that.
   *
   * Email is not patchable here on purpose — see `startEmailChange`.
   */
  async updateName(userId: UserId, name: string): Promise<Profile> {
    return this.options.unitOfWork(async (repos) => {
      const updated = await repos.users.updateName(userId, name);
      if (updated === null) {
        throw new AppError('not_found', 'Account not found', 404);
      }
      return toProfile(updated);
    });
  }

  /**
   * Changes the password, keeping the caller signed in and nobody else.
   *
   * Three things happen together, and the order is the point:
   *
   *   The current password is re-proved. A session token says this browser
   *   signed in at some point; it does not say the person at the keyboard is
   *   the account holder, and an unattended laptop is the ordinary case.
   *
   *   Every outstanding password-reset link is consumed. One sitting in an
   *   inbox after a password change is a standing takeover primitive.
   *
   *   Every OTHER session is revoked, which is what J5 promises in as many
   *   words. The caller's own survives: signing somebody out of the browser
   *   they just used to secure their account reads as a failure, and they
   *   would log straight back in — which teaches them to ignore it.
   */
  async changePassword(input: {
    userId: UserId;
    sessionId: SessionId;
    currentPassword: string;
    newPassword: string;
  }): Promise<{ otherSessionsRevoked: number }> {
    const newHash = await hashPassword(input.newPassword);

    return this.options.unitOfWork(async (repos) => {
      const user = await this.#require(repos, input.userId);

      if (user.passwordHash === null) {
        // SSO-only account: there is no current password to prove.
        throw new AppError('conflict', 'This account has no password set', 409);
      }

      if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
        throw new AppError('unauthenticated', 'Your current password is incorrect', 401);
      }

      await repos.users.updatePasswordHash(input.userId, newHash);
      await repos.userTokens.consumeAllFor(input.userId, 'password_reset');

      const otherSessionsRevoked = await repos.sessions.revokeAllForUserExcept(
        input.userId,
        input.sessionId,
      );

      return { otherSessionsRevoked };
    });
  }

  /**
   * Starts an email change. Nothing moves until the new address is proved.
   *
   * The address is the account's recovery channel: whoever controls it can
   * reset the password. Writing it on request would mean an unattended
   * session, or a CSRF that slipped past, permanently takes the account. So
   * this only issues a token, and `AuthService.verifyEmail` is what actually
   * writes the column when the link in the new inbox is clicked.
   *
   * The current password is re-proved for the same reason it is on a password
   * change, and the taken-address check is deliberately made BEFORE the email
   * goes out: sending a confirmation for an address that can never be applied
   * is a dead end the person cannot debug.
   */
  async startEmailChange(input: {
    userId: UserId;
    newEmail: string;
    currentPassword: string;
  }): Promise<{ pending: true; email: string }> {
    const token = generateToken();

    await this.options.unitOfWork(async (repos) => {
      const user = await this.#require(repos, input.userId);

      if (user.passwordHash === null) {
        throw new AppError('conflict', 'This account has no password set', 409);
      }
      if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
        throw new AppError('unauthenticated', 'Your current password is incorrect', 401);
      }
      if (user.email === input.newEmail) {
        throw new AppError('conflict', 'That is already your address', 409);
      }

      // Advisory: the partial unique index is what actually holds, and
      // `updateEmail` reports the race when it loses.
      if ((await repos.users.findByEmail(input.newEmail)) !== null) {
        throw new AppError('conflict', 'That address already has an account', 409);
      }

      // Supersede outstanding changes so only the newest link works.
      await repos.userTokens.consumeAllFor(input.userId, 'email_change');
      await repos.userTokens.issue({
        id: this.options.newId(),
        userId: input.userId,
        purpose: 'email_change',
        tokenHash: hashToken(token),
        newEmail: input.newEmail,
        expiresAt: new Date(
          this.options.now().getTime() + (this.options.emailChangeTtlHours ?? 24) * HOUR_MS,
        ),
      });
    });

    // Outside the transaction: never hold one across a network call. To the
    // NEW address, because the point is to prove the caller reads it.
    await this.options.notifier.sendEmailVerification(input.newEmail, token);

    return { pending: true, email: input.newEmail };
  }

  /** J5's session table. The caller's own session is marked, never revocable. */
  async listSessions(userId: UserId, currentSessionId: SessionId): Promise<AccountSession[]> {
    const now = this.options.now();

    return this.options.unitOfWork(async (repos) => {
      const rows = await repos.sessions.listActiveForUser(userId);
      return rows.map((row) => toAccountSession(row, currentSessionId, now));
    });
  }

  /**
   * Revokes one session of the caller's own.
   *
   * A session id that is not in the caller's live list gets 404 whether it
   * belongs to somebody else, was already revoked, or never existed. All three
   * must be one answer, or this becomes an oracle for other people's session
   * ids (CLAUDE.md section 11).
   */
  async revokeSession(userId: UserId, sessionId: SessionId): Promise<void> {
    await this.options.unitOfWork(async (repos) => {
      const rows = await repos.sessions.listActiveForUser(userId);
      if (!rows.some((row) => row.id === sessionId)) {
        throw new AppError('not_found', 'Session not found', 404);
      }
      await repos.sessions.revoke(sessionId);
    });
  }

  /** J5's "Sign out all other sessions". The caller keeps theirs. */
  async revokeOtherSessions(
    userId: UserId,
    currentSessionId: SessionId,
  ): Promise<{ revoked: number }> {
    return this.options.unitOfWork(async (repos) => ({
      revoked: await repos.sessions.revokeAllForUserExcept(userId, currentSessionId),
    }));
  }

  /**
   * The caller's own row, or 401.
   *
   * 401 rather than 404: the token verified, so this is a session outliving
   * the account it was minted for — a deleted or suspended user — and the
   * honest answer is "you are not signed in", not "your profile is missing".
   */
  async #require(repos: Repositories, userId: UserId) {
    const user = await repos.users.findById(userId);
    if (user === null || user.status !== 'active') {
      throw new AppError('unauthenticated', 'Authentication required', 401);
    }
    return user;
  }
}

function toProfile(user: {
  id: UserId;
  name: string;
  email: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}): Profile {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * Turns a session row into the row J5 draws.
 *
 * `created_at` is the last-active instant, and that is not a shortcut: refresh
 * rotates, so the live row of a family was created at the last refresh, and an
 * open tab refreshes on the access token's fifteen-minute cadence.
 *
 * `location` is empty because nothing in this system does GeoIP. It is left
 * empty rather than filled with "Unknown": the IP is printed directly beneath
 * it, and a fabricated city is worse than a blank.
 */
function toAccountSession(
  row: SessionRow,
  currentSessionId: SessionId,
  now: Date,
): AccountSession {
  const agent = describeUserAgent(row.userAgent);

  return {
    id: row.id,
    device: agent.device,
    deviceKind: agent.kind,
    client: agent.client,
    location: '',
    ip: row.ip ?? '',
    lastActiveLabel: relativeLabel(row.createdAt, now),
    lastActiveAt: row.createdAt.toISOString(),
    current: row.id === currentSessionId,
  };
}

/* ------------------------------------------------------------------ */
/* User-agent reading                                                  */
/* ------------------------------------------------------------------ */

/** What J5's icon column can draw. */
export type DeviceKind = 'desktop' | 'mobile' | 'unknown';

export interface AgentDescription {
  device: string;
  kind: DeviceKind;
  client: string;
}

/**
 * Reads a stored user-agent into the two lines J5 prints.
 *
 * Deliberately small and deliberately not a library. A UA database is a
 * dependency that needs updating forever to answer a question whose only
 * consumer is "is this the laptop or the phone I signed in on" — and the
 * person reading the row already knows the answer. Anything unrecognised
 * says so rather than guessing, because "Unknown device · Berlin" is a
 * usable security signal and a wrong device name is not.
 */
export function describeUserAgent(userAgent: string | null): AgentDescription {
  if (userAgent === null || userAgent.trim() === '') {
    return { device: 'Unknown device', kind: 'unknown', client: 'Unknown browser' };
  }

  const browser = readBrowser(userAgent);
  const platform = readPlatform(userAgent);

  return {
    device: platform.device,
    kind: platform.kind,
    client: platform.os === null ? browser : `${browser} · ${platform.os}`,
  };
}

function readBrowser(ua: string): string {
  // Order matters: Edge and Opera both claim to be Chrome, and Chrome claims
  // to be Safari. Most specific first, or every browser reads as Safari.
  const patterns: [RegExp, string][] = [
    [/Edg(?:e|A|iOS)?\/(\d+)/u, 'Edge'],
    [/OPR\/(\d+)/u, 'Opera'],
    [/Firefox\/(\d+)/u, 'Firefox'],
    [/Chrome\/(\d+)/u, 'Chrome'],
    [/Version\/(\d+)[^)]*Safari/u, 'Safari'],
  ];

  for (const [pattern, name] of patterns) {
    const match = pattern.exec(ua);
    if (match !== null) return `${name} ${match[1] ?? ''}`.trim();
  }

  return 'Unknown browser';
}

function readPlatform(ua: string): { device: string; kind: DeviceKind; os: string | null } {
  if (/iPhone/u.test(ua)) return { device: 'iPhone', kind: 'mobile', os: iosVersion(ua) };
  if (/iPad/u.test(ua)) return { device: 'iPad', kind: 'mobile', os: iosVersion(ua) };

  if (/Android/u.test(ua)) {
    const version = /Android (\d+)/u.exec(ua)?.[1];
    return {
      // Google's own rule: an Android UA without "Mobile" is a tablet.
      device: /Mobile/u.test(ua) ? 'Android phone' : 'Android tablet',
      kind: 'mobile',
      os: version === undefined ? 'Android' : `Android ${version}`,
    };
  }

  if (/Macintosh|Mac OS X/u.test(ua)) return { device: 'Mac', kind: 'desktop', os: 'macOS' };

  if (/Windows/u.test(ua)) {
    // Windows 11 reports itself as "Windows NT 10.0", exactly like Windows
    // 10. Printing a version we cannot know would be a confident lie.
    return { device: 'Windows PC', kind: 'desktop', os: 'Windows' };
  }

  if (/Linux|X11|CrOS/u.test(ua)) return { device: 'Linux PC', kind: 'desktop', os: 'Linux' };

  return { device: 'Unknown device', kind: 'unknown', os: null };
}

function iosVersion(ua: string): string {
  const version = /OS (\d+)[_\d]*/u.exec(ua)?.[1];
  return version === undefined ? 'iOS' : `iOS ${version}`;
}

/**
 * "Active now", "2 hours ago", "3 days ago".
 *
 * Rendered here rather than in the browser because the instant it describes
 * comes from the server's clock, and a client whose clock is twenty minutes
 * fast would print "in 20 minutes" for a session that is live right now.
 */
export function relativeLabel(at: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));

  // An access token lives fifteen minutes, so a session refreshed inside the
  // last five is certainly a tab that is open.
  if (seconds < 300) return 'Active now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');

  const days = Math.floor(hours / 24);
  if (days < 30) return plural(days, 'day');

  const months = Math.floor(days / 30);
  return plural(months, 'month');
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}
