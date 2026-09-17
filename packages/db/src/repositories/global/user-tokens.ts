import { and, eq, gt, isNull } from 'drizzle-orm';
import type { UserId } from '@relayd/types';
import { userTokens } from '../../schema/identity.js';
import type { Executor } from '../executor.js';

/**
 * CROSS-TENANT BY NECESSITY.
 *
 * Email verification and password reset act on a person, not a workspace, and
 * both run before any workspace is in context — a password reset is performed
 * by someone who cannot log in at all. See global/users.ts for the full
 * reasoning on this exception.
 */

export type TokenPurpose = 'email_verification' | 'password_reset';

export interface UserTokenRow {
  id: string;
  userId: UserId;
  purpose: TokenPurpose;
  expiresAt: Date;
}

export interface IssueTokenInput {
  id: string;
  userId: UserId;
  purpose: TokenPurpose;
  tokenHash: Buffer;
  expiresAt: Date;
}

export class UserTokenRepository {
  constructor(private readonly db: Executor) {}

  async issue(input: IssueTokenInput): Promise<void> {
    await this.db.insert(userTokens).values({
      id: input.id,
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    });
  }

  /**
   * Live tokens only: unconsumed and unexpired.
   *
   * An expired or already-used token must be indistinguishable from one that
   * never existed, so this returns null for all three and the caller cannot
   * accidentally tell them apart.
   */
  async findLive(tokenHash: Buffer, purpose: TokenPurpose): Promise<UserTokenRow | null> {
    const [row] = await this.db
      .select()
      .from(userTokens)
      .where(
        and(
          eq(userTokens.tokenHash, tokenHash),
          eq(userTokens.purpose, purpose),
          isNull(userTokens.consumedAt),
          gt(userTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);

    return row === undefined
      ? null
      : { id: row.id, userId: row.userId, purpose: row.purpose, expiresAt: row.expiresAt };
  }

  /**
   * Guarded single-use consumption.
   *
   * Zero rows means someone already redeemed it. The caller must treat that
   * as a failure rather than proceeding, or a reset link forwarded to a third
   * party works twice.
   */
  async consume(id: string): Promise<boolean> {
    const rows = await this.db
      .update(userTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(userTokens.id, id), isNull(userTokens.consumedAt)))
      .returning({ id: userTokens.id });

    return rows.length > 0;
  }

  /**
   * Invalidates every outstanding token of a purpose for a user.
   *
   * Run after a successful reset and after any password change: an
   * outstanding reset link issued before the change must stop working, or a
   * stale email in an inbox is a standing account-takeover primitive.
   */
  async consumeAllFor(userId: UserId, purpose: TokenPurpose): Promise<number> {
    const rows = await this.db
      .update(userTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(userTokens.userId, userId),
          eq(userTokens.purpose, purpose),
          isNull(userTokens.consumedAt),
        ),
      )
      .returning({ id: userTokens.id });

    return rows.length;
  }
}
