import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { UserId } from '@relayd/types';
import { userTokens } from '../../schema/identity.js';
import type { Executor } from '../executor.js';

/**
 * CROSS-TENANT BY NECESSITY.
 *
 * Email verification, password reset and email change act on a person, not a
 * workspace, and all three run before or outside any workspace context — a
 * password reset is performed by someone who cannot log in at all. See
 * global/users.ts for the full reasoning on this exception.
 */

export type TokenPurpose = 'email_verification' | 'password_reset' | 'email_change';

export interface UserTokenRow {
  id: string;
  userId: UserId;
  purpose: TokenPurpose;
  expiresAt: Date;
  /** The proposed address, on an `email_change` row and nowhere else. */
  newEmail: string | null;
}

export interface IssueTokenInput {
  id: string;
  userId: UserId;
  purpose: TokenPurpose;
  tokenHash: Buffer;
  expiresAt: Date;
  /** Required for `email_change`, refused by a CHECK for anything else. */
  newEmail?: string;
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
      ...(input.newEmail === undefined ? {} : { newEmail: input.newEmail }),
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
      : {
          id: row.id,
          userId: row.userId,
          purpose: row.purpose,
          expiresAt: row.expiresAt,
          newEmail: row.newEmail,
        };
  }

  /**
   * A live token by hash, whatever it is for.
   *
   * One emailed link, two things it can mean: confirming the address an
   * account registered with, and confirming an address it is moving to. Both
   * arrive at /auth/verify-email because both are "prove you read this
   * inbox", and the purpose on the row is what decides which happened. The
   * alternative — a second public endpoint whose only job is to be told apart
   * from this one by a client that cannot tell them apart either — is worse.
   *
   * Still live-only, for the same reason `findLive` is: expired, consumed and
   * never-existed must be one answer.
   */
  async findLiveByHash(tokenHash: Buffer): Promise<UserTokenRow | null> {
    const [row] = await this.db
      .select()
      .from(userTokens)
      .where(
        and(
          eq(userTokens.tokenHash, tokenHash),
          isNull(userTokens.consumedAt),
          gt(userTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);

    return row === undefined
      ? null
      : {
          id: row.id,
          userId: row.userId,
          purpose: row.purpose,
          expiresAt: row.expiresAt,
          newEmail: row.newEmail,
        };
  }

  /**
   * When this user last had a token of this purpose issued.
   *
   * The durable half of the resend cooldown. A Redis rate limiter is the
   * wrong instrument here: this one fails open by design (see the note in
   * apps/api middleware/rate-limit.ts), and a resend button that becomes
   * unlimited whenever the cache blinks is a free mail cannon pointed at
   * somebody else's inbox. `created_at` on the last issued row costs one
   * indexed read and cannot fail open.
   */
  async lastIssuedAt(userId: UserId, purpose: TokenPurpose): Promise<Date | null> {
    const [row] = await this.db
      .select({ createdAt: userTokens.createdAt })
      .from(userTokens)
      .where(and(eq(userTokens.userId, userId), eq(userTokens.purpose, purpose)))
      .orderBy(desc(userTokens.createdAt))
      .limit(1);

    return row?.createdAt ?? null;
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
