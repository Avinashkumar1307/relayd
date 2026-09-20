import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { SessionId, UserId } from '@relayd/types';
import { sessions } from '../../schema/identity.js';
import type { Executor } from '../executor.js';

/**
 * CROSS-TENANT BY NECESSITY.
 *
 * A session belongs to a user, not a workspace. Refresh happens before any
 * workspace header is read, and one session is used across every workspace
 * the user belongs to. See global/users.ts for the full reasoning.
 */

export interface SessionRow {
  id: SessionId;
  userId: UserId;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  userAgent: string | null;
  ip: string | null;
}

export interface CreateSessionInput {
  id: SessionId;
  userId: UserId;
  refreshTokenHash: Buffer;
  /** Rotation family. A new login starts a family; a refresh continues one. */
  familyId: string;
  expiresAt: Date;
  userAgent?: string;
  ip?: string;
}

export class SessionRepository {
  constructor(private readonly db: Executor) {}

  async create(input: CreateSessionInput): Promise<SessionRow> {
    const [row] = await this.db
      .insert(sessions)
      .values({
        id: input.id,
        userId: input.userId,
        refreshTokenHash: input.refreshTokenHash,
        familyId: input.familyId,
        expiresAt: input.expiresAt,
        ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
        ...(input.ip === undefined ? {} : { ip: input.ip }),
      })
      .returning();

    if (row === undefined) throw new Error('createSession: insert returned no row');
    return toRow(row);
  }

  /**
   * Looks up by token hash regardless of revocation, deliberately.
   *
   * Rotation theft detection needs to see a REVOKED row: presenting a token
   * that was already consumed is the signal that it leaked, and the response
   * is to revoke the whole family (docs/06 s15). Filtering revoked rows out
   * here would silently turn a detected theft into an ordinary failed login.
   */
  async findByRefreshTokenHash(hash: Buffer): Promise<SessionRow | null> {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, hash))
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  /**
   * The live sessions of one user, newest first.
   *
   * Refresh rotates: the successor row is created and the predecessor revoked
   * in the same transaction, so there is exactly one live row per rotation
   * family and `created_at` on it is the moment of the last refresh — which
   * is as close to "last seen" as this schema gets, and close enough, because
   * an access token lives fifteen minutes and an open tab refreshes on that
   * cadence. J5's "Last active" column is built from it.
   */
  async listActiveForUser(userId: UserId): Promise<SessionRow[]> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(sessions.createdAt));

    return rows.map(toRow);
  }

  /**
   * Guarded revoke. Zero rows means it was already revoked, which the caller
   * must be able to distinguish from a successful revocation.
   */
  async revoke(id: SessionId): Promise<boolean> {
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    return rows.length > 0;
  }

  /**
   * Revokes an entire rotation family.
   *
   * This is the theft response: one leaked refresh token invalidates every
   * session descended from the same login, not just the one presented.
   */
  async revokeFamily(familyId: string): Promise<number> {
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    return rows.length;
  }

  /**
   * Revokes every live session of a user except one.
   *
   * This is J5's "Sign out all other sessions", and it is also what a password
   * change does. Keeping the caller's own session is the whole point: signing
   * somebody out of the browser they just used to secure their account reads
   * as a failure, and they would log straight back in — training them to
   * ignore the thing that was supposed to be a security event.
   *
   * Excluding by id rather than deleting-then-recreating means the current
   * session's refresh token is untouched, so there is no window where the
   * caller holds a revoked credential.
   */
  async revokeAllForUserExcept(userId: UserId, keep: SessionId): Promise<number> {
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(sessions.userId, userId), ne(sessions.id, keep), isNull(sessions.revokedAt)),
      )
      .returning({ id: sessions.id });

    return rows.length;
  }

  async revokeAllForUser(userId: UserId): Promise<number> {
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    return rows.length;
  }

  /** Links a rotated session to its successor, for audit and theft tracing. */
  async markReplacedBy(id: SessionId, successor: SessionId): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date(), replacedBy: successor })
      .where(eq(sessions.id, id));
  }
}

function toRow(row: typeof sessions.$inferSelect): SessionRow {
  return {
    id: row.id,
    userId: row.userId,
    familyId: row.familyId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    userAgent: row.userAgent,
    ip: row.ip,
  };
}
