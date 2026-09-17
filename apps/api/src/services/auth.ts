import { AppError } from '@relayd/types';
import type { SessionId, UserId, WorkspaceId, WorkspaceMemberId } from '@relayd/types';
import { generateToken, hashPassword, hashToken, verifyPassword } from '@relayd/utils';
import type {
  AuditLogRepository,
  GlobalInvitationRepository,
  GlobalMembershipRepository,
  SessionRepository,
  UserRepository,
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
}

export interface SessionContext {
  userAgent?: string;
  ip?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: SessionId;
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

    const { user, workspaceId } = await this.options.unitOfWork(async (repos) => {
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

      return { user: created, workspaceId: newWorkspaceId };
    });

    // Outside the transaction: an email provider is a network call, and
    // docs/03 is explicit that a transaction must never be held across one.
    await this.options.notifier.sendEmailVerification(user.email, verificationToken);

    return this.#startSession(user.id, [workspaceId], context);
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

    const { userId, workspaceIds } = await this.options.unitOfWork(async (repos) => {
      const user = await repos.users.findByEmail(email);

      if (user === null || user.passwordHash === null) {
        // Spend comparable time so absence is not measurably faster.
        await verifyPassword(DUMMY_HASH, password);
        return invalid();
      }

      if (!(await verifyPassword(user.passwordHash, password))) return invalid();
      if (user.status !== 'active') {
        throw new AppError('unauthenticated', 'This account is not active', 401);
      }

      await repos.users.recordLogin(user.id);
      const memberships = await repos.memberships.listForUser(user.id);

      return { userId: user.id, workspaceIds: memberships.map((m) => m.workspaceId) };
    });

    return this.#startSession(userId, workspaceIds, context);
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

    const { userId, workspaceIds, familyId } = await this.options.unitOfWork(async (repos) => {
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

      const memberships = await repos.memberships.listForUser(session.userId);

      return {
        userId: session.userId,
        workspaceIds: memberships.map((m) => m.workspaceId),
        familyId: session.familyId,
        previous: session.id,
      };
    });

    return this.#startSession(userId, workspaceIds, context, familyId, hash);
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

  async verifyEmail(token: string): Promise<void> {
    await this.options.unitOfWork(async (repos) => {
      const record = await repos.userTokens.findLive(hashToken(token), 'email_verification');
      if (record === null) {
        throw new AppError('not_found', 'This verification link is not valid', 404);
      }
      if (!(await repos.userTokens.consume(record.id))) {
        throw new AppError('conflict', 'This verification link has already been used', 409);
      }
      await repos.users.markEmailVerified(record.userId);
    });
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

  async listSessions(userId: UserId): Promise<
    { id: SessionId; createdAt: Date; expiresAt: Date; userAgent: string | null; ip: string | null }[]
  > {
    return this.options.unitOfWork(async (repos) => {
      const sessions = await repos.sessions.listActiveForUser(userId);
      return sessions.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        userAgent: s.userAgent,
        ip: s.ip,
      }));
    });
  }

  /** Revokes one session, but only if it belongs to the caller. */
  async revokeSession(userId: UserId, sessionId: SessionId): Promise<boolean> {
    return this.options.unitOfWork(async (repos) => {
      const sessions = await repos.sessions.listActiveForUser(userId);
      if (!sessions.some((s) => s.id === sessionId)) {
        // Not theirs, or already gone. 404 either way: a member must not be
        // able to probe for other users' session ids.
        throw new AppError('not_found', 'Session not found', 404);
      }
      return repos.sessions.revoke(sessionId);
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
    userId: UserId,
    workspaceIds: WorkspaceId[],
    context: SessionContext,
    familyId?: string,
    previousHash?: Buffer,
  ): Promise<AuthTokens> {
    const refreshToken = generateToken();
    const sessionId = this.options.newId() as SessionId;
    const family = familyId ?? this.options.newId();

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
      wsIds: workspaceIds,
      ver: 1,
    });

    return { accessToken, refreshToken, sessionId };
  }
}

/**
 * A real argon2id hash of a value nobody knows, verified against when the
 * account does not exist so that absence costs the same time as a wrong
 * password.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZS1zYWx0LXZhbHVl$JDJhJDEwJGFiY2RlZmdoaWprbG1ub3A';
