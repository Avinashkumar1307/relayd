import { AppError } from '@relayd/types';
import type { SessionId, UserId, WorkspaceId, WorkspaceMemberId } from '@relayd/types';
import { generateToken, hashPassword, hashToken, verifyPassword } from '@relayd/utils';
import type {
  AuditLogRepository,
  GlobalInvitationRepository,
  GlobalMembershipRepository,
  MembershipSummary,
  SessionRepository,
  UserRepository,
  UserRow,
  UserTokenRepository,
  WorkspaceInvitationRepository,
  WorkspaceMemberRepository,
  WorkspaceRepository,
} from '@relayd/db';
import { workspaceScope } from '@relayd/db';
import type { TokenService } from './tokens.js';

export interface Repositories {
  users: UserRepository;
  sessions: SessionRepository;
  userTokens: UserTokenRepository;
  memberships: GlobalMembershipRepository;
  workspaces: WorkspaceRepository;
  members: WorkspaceMemberRepository;
  invitations: WorkspaceInvitationRepository;
  globalInvitations: GlobalInvitationRepository;
  auditLogs: AuditLogRepository;
}

/**
 * Runs a function inside one transaction, with repositories bound to it.
 *
 * docs/03 requires registration to be a single transaction across user,
 * workspace and membership: a half-registered account that owns no workspace
 * is unreachable through every code path and has to be repaired by hand.
 */
export type UnitOfWork = <T>(fn: (repos: Repositories) => Promise<T>) => Promise<T>;

/** Product email. Implemented by packages/notifications in checklist item 11. */
export interface AuthNotifier {
  sendEmailVerification(to: string, token: string): Promise<void>;
  sendPasswordReset(to: string, token: string): Promise<void>;
}

export interface AuthServiceOptions {
  unitOfWork: UnitOfWork;
  tokens: TokenService;
  notifier: AuthNotifier;
  newId: () => string;
  now: () => Date;
  refreshTtlDays: number;
  verificationTtlHours?: number;
  passwordResetTtlMinutes?: number;
  /** Server-side floor between two verification emails. Defaults to 60 s. */
  resendCooldownSeconds?: number;
}

export interface SessionContext {
  userAgent?: string;
  ip?: string;
}

/**
 * Who is signed in, as the SPA's shell, J5 and D6c's "Recorded as" line all
 * need it.
 *
 * Returned on every response that establishes a session rather than from a
 * separate lookup: the browser asks "who am I" exactly when it has just
 * logged in or refreshed, and answering then costs nothing. A second endpoint
 * would cost a round trip on every page load, and the window between the two
 * calls is a window in which the shell has a token and no name to render.
 */
export interface SessionUser {
  id: UserId;
  name: string;
  email: string;
  emailVerified: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: SessionId;
  user: SessionUser;
  /**
   * Every workspace the caller belongs to.
   *
   * Not authorization — `requireWorkspace` re-reads membership on every
   * request for that. This is what the workspace switcher is drawn from.
   */
  memberships: MembershipSummary[];
}

/** What `GET /auth/session` answers: the same payload without the tokens. */
export interface SessionSummary {
  user: SessionUser;
  memberships: MembershipSummary[];
}

export interface RegisterInput {
  email: string;
  name: string;
  password: string;
  workspaceName: string;
  workspaceSlug: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export class AuthService {
  constructor(private readonly options: AuthServiceOptions) {}

  /**
   * Creates the user, their first workspace and the owner membership in one
   * transaction, then issues an email-verification token.
   *
   * The workspace scope is constructed from the new workspace's own id, so
   * creation runs under the same RLS discipline as every other write rather
   * than as a special unscoped case.
   */
  async register(input: RegisterInput, context: SessionContext = {}): Promise<AuthTokens> {
    const passwordHash = await hashPassword(input.password);
    const verificationToken = generateToken();

    const { user, membership } = await this.options.unitOfWork(async (repos) => {
      const existing = await repos.users.findByEmail(input.email);
      if (existing !== null) {
        // Registration is the one flow where the address must be revealed as
        // taken, because the user has to be told to log in instead. docs/06
        // requires identical responses for login, reset and invite
        // acceptance; registration is not on that list.
        throw new AppError('conflict', 'An account with that email already exists', 409);
      }

      const userId = this.options.newId() as UserId;
      const created = await repos.users.create({
        id: userId,
        email: input.email,
        name: input.name,
        passwordHash,
      });

      const newWorkspaceId = this.options.newId() as WorkspaceId;
      const scope = workspaceScope(newWorkspaceId);

      await repos.workspaces.create(scope, {
        id: newWorkspaceId,
        name: input.workspaceName,
        slug: input.workspaceSlug,
        ownerUserId: userId,
      });

      await repos.members.create(scope, {
        id: this.options.newId() as WorkspaceMemberId,
        userId,
        role: 'owner',
      });

      await repos.userTokens.issue({
        id: this.options.newId(),
        userId,
        purpose: 'email_verification',
        tokenHash: hashToken(verificationToken),
        expiresAt: new Date(
          this.options.now().getTime() + (this.options.verificationTtlHours ?? 24) * HOUR_MS,
        ),
      });

      return {
        user: created,
        membership: {
          workspaceId: newWorkspaceId,
          workspaceName: input.workspaceName,
          workspaceSlug: input.workspaceSlug,
          role: 'owner',
        } satisfies MembershipSummary,
      };
    });

    // Outside the transaction: an email provider is a network call, and
    // docs/03 is explicit that a transaction must never be held across one.
    await this.options.notifier.sendEmailVerification(user.email, verificationToken);

    return this.#startSession(user, [membership], context);
  }

  /**
   * Password login.
   *
   * A missing user and a wrong password produce the same error, and the
   * password is verified against a dummy hash when the user does not exist so
   * the two paths take comparable time. docs/06: identical responses and
   * timing whether or not the account exists.
   */
  async login(
    email: string,
    password: string,
    context: SessionContext = {},
  ): Promise<AuthTokens> {
    const invalid = (): never => {
      throw new AppError('unauthenticated', 'Email or password is incorrect', 401);
    };

    const { user, memberships } = await this.options.unitOfWork(async (repos) => {
      const found = await repos.users.findByEmail(email);

      if (found === null || found.passwordHash === null) {
        // Spend comparable time so absence is not measurably faster.
        await verifyPassword(DUMMY_HASH, password);
        return invalid();
      }

      if (!(await verifyPassword(found.passwordHash, password))) return invalid();
      if (found.status !== 'active') {
        throw new AppError('unauthenticated', 'This account is not active', 401);
      }

      await repos.users.recordLogin(found.id);

      return { user: found, memberships: await repos.memberships.listForUser(found.id) };
    });

    return this.#startSession(user, memberships, context);
  }

  /**
   * Refresh-token rotation with theft detection.
   *
   * Presenting a token that was already consumed is the signal that it leaked:
   * the legitimate holder would have received the replacement. The response is
   * to revoke the entire rotation family, not just the token presented, so an
   * attacker who stole one token cannot keep a parallel session alive
   * (docs/06 s15).
   */
  async refresh(refreshToken: string, context: SessionContext = {}): Promise<AuthTokens> {
    const hash = hashToken(refreshToken);

    const { user, memberships, familyId } = await this.options.unitOfWork(async (repos) => {
      const session = await repos.sessions.findByRefreshTokenHash(hash);

      if (session === null) {
        throw new AppError('unauthenticated', 'Refresh token is not valid', 401);
      }

      if (session.revokedAt !== null) {
        // Reuse of a consumed token. Burn the whole family.
        await repos.sessions.revokeFamily(session.familyId);
        throw new AppError('unauthenticated', 'Refresh token is not valid', 401);
      }

      if (session.expiresAt.getTime() <= this.options.now().getTime()) {
        throw new AppError('token_expired', 'Session has expired', 401);
      }

      // Re-read rather than trusted from the session row: a name change, an
      // email change or a suspension between two refreshes must be visible on
      // the next one, not fifteen minutes later.
      const found = await repos.users.findById(session.userId);
      if (found === null || found.status !== 'active') {
        throw new AppError('unauthenticated', 'Refresh token is not valid', 401);
      }

      return {
        user: found,
        memberships: await repos.memberships.listForUser(session.userId),
        familyId: session.familyId,
      };
    });

    return this.#startSession(user, memberships, context, familyId, hash);
  }

  /**
   * Who is signed in, without rotating anything.
   *
   * `/auth/refresh` answers the same question, but it answers it by consuming
   * one refresh token and minting another — which is correct when the browser
   * needs a new access token and wasteful when it only wants to re-read who it
   * is. A client that already holds a valid access token uses this.
   */
  async session(userId: UserId): Promise<SessionSummary> {
    return this.options.unitOfWork(async (repos) => {
      const user = await repos.users.findById(userId);
      if (user === null || user.status !== 'active') {
        throw new AppError('unauthenticated', 'Authentication required', 401);
      }

      return {
        user: toSessionUser(user),
        memberships: await repos.memberships.listForUser(userId),
      };
    });
  }

  async logout(refreshToken: string): Promise<void> {
    const hash = hashToken(refreshToken);
    await this.options.unitOfWork(async (repos) => {
      const session = await repos.sessions.findByRefreshTokenHash(hash);
      if (session !== null && session.revokedAt === null) {
        await repos.sessions.revoke(session.id);
      }
    });
  }

  /**
   * Redeems an emailed "prove you read this inbox" link.
   *
   * One endpoint, two meanings, decided by the purpose on the row: confirming
   * the address an account registered with, and confirming an address it is
   * moving to. The client cannot tell them apart — it has an opaque token from
   * a query string — so the server must, and a second public endpoint would
   * only move the guess to the browser.
   *
   * Returns the address that ended up verified, which is what B3b prints.
   */
  async verifyEmail(token: string): Promise<{ verified: true; email: string }> {
    return this.options.unitOfWork(async (repos) => {
      const record = await repos.userTokens.findLiveByHash(hashToken(token));
      if (record === null || record.purpose === 'password_reset') {
        // A reset token is refused here rather than treated as a verification:
        // they are issued by different flows and one must never stand in for
        // the other.
        throw new AppError('not_found', 'This verification link is not valid', 404);
      }

      // Consumed first. Two clicks on the same link race here, and the guarded
      // update is what makes exactly one of them do the work.
      if (!(await repos.userTokens.consume(record.id))) {
        throw new AppError('conflict', 'This verification link has already been used', 409);
      }

      const user = await repos.users.findById(record.userId);
      if (user === null) {
        throw new AppError('not_found', 'This verification link is not valid', 404);
      }

      if (record.purpose === 'email_verification') {
        await repos.users.markEmailVerified(record.userId);
        return { verified: true as const, email: user.email };
      }

      // email_change. The CHECK on user_tokens guarantees the address is
      // present; the null branch is here because the type cannot know that.
      const newEmail = record.newEmail;
      if (newEmail === null) {
        throw new AppError('internal_error', 'Email change token has no address', 500);
      }

      const result = await repos.users.updateEmail(record.userId, newEmail);
      if (result === 'taken') {
        throw new AppError(
          'conflict',
          'That address now belongs to another account',
          409,
        );
      }
      if (result === 'not_found') {
        throw new AppError('not_found', 'This verification link is not valid', 404);
      }

      // Every other outstanding change and every session but none: the address
      // is the recovery channel, and a link issued before this one must not
      // still be able to move the account somewhere else.
      await repos.userTokens.consumeAllFor(record.userId, 'email_change');

      return { verified: true as const, email: newEmail };
    });
  }

  /**
   * Sends the verification link again.
   *
   * Two rules, both from docs/06. It never reveals whether an address has an
   * account — the answer is the same 202 for a live address, an unknown one
   * and an already-verified one — and it is throttled on the server, because
   * B3a's 30-second countdown is a courtesy to the person, not a control on
   * the caller.
   *
   * The throttle is a Postgres read, not the Redis limiter: that one fails
   * open by design, and "unlimited resends whenever the cache blinks" is a
   * mail cannon aimed at whichever inbox the caller names.
   */
  async resendEmailVerification(input: { userId?: UserId; email?: string }): Promise<void> {
    const token = generateToken();
    const cooldownMs = (this.options.resendCooldownSeconds ?? 60) * 1000;

    const recipient = await this.options.unitOfWork(async (repos) => {
      const user =
        input.userId !== undefined
          ? await repos.users.findById(input.userId)
          : input.email === undefined
            ? null
            : await repos.users.findByEmail(input.email);

      // Nothing to do, and the caller is told nothing either way.
      if (user === null || user.status !== 'active' || user.emailVerifiedAt !== null) {
        return null;
      }

      const last = await repos.userTokens.lastIssuedAt(user.id, 'email_verification');
      if (last !== null && this.options.now().getTime() - last.getTime() < cooldownMs) {
        // Silently declined. A 429 here would say "this address exists and is
        // unverified", which is the thing this endpoint must not say.
        return null;
      }

      await repos.userTokens.consumeAllFor(user.id, 'email_verification');
      await repos.userTokens.issue({
        id: this.options.newId(),
        userId: user.id,
        purpose: 'email_verification',
        tokenHash: hashToken(token),
        expiresAt: new Date(
          this.options.now().getTime() + (this.options.verificationTtlHours ?? 24) * HOUR_MS,
        ),
      });

      return user.email;
    });

    if (recipient !== null) {
      await this.options.notifier.sendEmailVerification(recipient, token);
    }
  }

  /**
   * Always resolves, whether or not the address exists.
   *
   * Telling the caller that an address is unknown turns this endpoint into an
   * account-enumeration oracle (docs/06).
   */
  async requestPasswordReset(email: string): Promise<void> {
    const token = generateToken();

    const recipient = await this.options.unitOfWork(async (repos) => {
      const user = await repos.users.findByEmail(email);
      if (user === null) return null;

      // Supersede outstanding resets so only the newest link works.
      await repos.userTokens.consumeAllFor(user.id, 'password_reset');
      await repos.userTokens.issue({
        id: this.options.newId(),
        userId: user.id,
        purpose: 'password_reset',
        tokenHash: hashToken(token),
        expiresAt: new Date(
          this.options.now().getTime() +
            (this.options.passwordResetTtlMinutes ?? 60) * 60 * 1000,
        ),
      });

      return user.email;
    });

    if (recipient !== null) {
      await this.options.notifier.sendPasswordReset(recipient, token);
    }
  }

  /**
   * Consumes the token, sets the new password and revokes every session.
   *
   * Revoking sessions is the point: a reset is what a user does when they
   * believe someone else has access, and leaving existing sessions alive
   * would make it useless.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const passwordHash = await hashPassword(newPassword);

    await this.options.unitOfWork(async (repos) => {
      const record = await repos.userTokens.findLive(hashToken(token), 'password_reset');
      if (record === null) {
        throw new AppError('not_found', 'This reset link is not valid', 404);
      }
      if (!(await repos.userTokens.consume(record.id))) {
        throw new AppError('conflict', 'This reset link has already been used', 409);
      }

      await repos.users.updatePasswordHash(record.userId, passwordHash);
      await repos.userTokens.consumeAllFor(record.userId, 'password_reset');
      await repos.sessions.revokeAllForUser(record.userId);
    });
  }

  /**
   * Issues a session and its token pair.
   *
   * When continuing a rotation family, the previous session is marked
   * replaced in the same transaction as the successor is created, so there is
   * no window in which both are live.
   */
  async #startSession(
    user: UserRow,
    memberships: MembershipSummary[],
    context: SessionContext,
    familyId?: string,
    previousHash?: Buffer,
  ): Promise<AuthTokens> {
    const refreshToken = generateToken();
    const sessionId = this.options.newId() as SessionId;
    const family = familyId ?? this.options.newId();
    const userId = user.id;

    await this.options.unitOfWork(async (repos) => {
      if (previousHash !== undefined) {
        const previous = await repos.sessions.findByRefreshTokenHash(previousHash);
        if (previous !== null) {
          await repos.sessions.markReplacedBy(previous.id, sessionId);
        }
      }

      await repos.sessions.create({
        id: sessionId,
        userId,
        refreshTokenHash: hashToken(refreshToken),
        familyId: family,
        expiresAt: new Date(this.options.now().getTime() + this.options.refreshTtlDays * DAY_MS),
        ...(context.userAgent === undefined ? {} : { userAgent: context.userAgent }),
        ...(context.ip === undefined ? {} : { ip: context.ip }),
      });
    });

    const accessToken = await this.options.tokens.issueAccessToken({
      sub: userId,
      sid: sessionId,
      wsIds: memberships.map((m) => m.workspaceId),
      ver: 1,
    });

    return {
      accessToken,
      refreshToken,
      sessionId,
      user: toSessionUser(user),
      memberships,
    };
  }
}

/**
 * The public shape of a user.
 *
 * Narrow deliberately: the row carries a password hash and an MFA envelope,
 * and a serialiser that starts from the row and removes fields is one added
 * column away from leaking one. This starts from nothing and adds four.
 */
function toSessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
  };
}

/**
 * A real argon2id hash of a value nobody knows, verified against when the
 * account does not exist so that absence costs the same time as a wrong
 * password.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZS1zYWx0LXZhbHVl$JDJhJDEwJGFiY2RlZmdoaWprbG1ub3A';
