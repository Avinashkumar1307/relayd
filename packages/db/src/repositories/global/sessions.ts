import { and, eq, gt, isNull } from 'drizzle-orm';
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
      );

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
