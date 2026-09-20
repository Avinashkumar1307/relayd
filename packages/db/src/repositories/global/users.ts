import { and, eq, ne } from 'drizzle-orm';
import type { UserId } from '@relayd/types';
import { users } from '../../schema/identity.js';
import type { Executor } from '../executor.js';

/**
 * CROSS-TENANT BY NECESSITY.
 *
 * CLAUDE.md section 6.2 allows exactly one exception to the
 * WorkspaceScope-first rule: explicitly named cross-tenant repositories under
 * packages/db/repositories/global/. This is one of them.
 *
 * Reason: a user is not owned by a workspace. They exist before any workspace
 * is created, may belong to several, and every path that touches this table —
 * register, login, refresh, verify email, reset password — runs before a
 * workspace is in context. A WorkspaceScope parameter here would be a lie.
 *
 * Safety comes from above instead: nothing reaches these methods without
 * passing the auth layer, and `users` deliberately has no RLS policy for the
 * same reason (migration 0003).
 */

export type UserStatus = 'active' | 'suspended' | 'deleted';

export interface UserRow {
  id: UserId;
  email: string;
  name: string;
  emailVerifiedAt: Date | null;
  passwordHash: string | null;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface CreateUserInput {
  id: UserId;
  email: string;
  name: string;
  passwordHash: string;
}

export class UserRepository {
  constructor(private readonly db: Executor) {}

  async create(input: CreateUserInput): Promise<UserRow> {
    const [row] = await this.db
      .insert(users)
      .values({
        id: input.id,
        email: input.email,
        name: input.name,
        passwordHash: input.passwordHash,
      })
      .returning();

    if (row === undefined) throw new Error('createUser: insert returned no row');
    return toRow(row);
  }

  /**
   * Deleted accounts are excluded, matching the partial unique index on email
   * — so a deleted account's address is free to register again.
   */
  async findByEmail(email: string): Promise<UserRow | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, email), ne(users.status, 'deleted')))
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  async findById(id: UserId): Promise<UserRow | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), ne(users.status, 'deleted')))
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  /** Guarded: verifying an already-verified address is a no-op, not an error. */
  async markEmailVerified(id: UserId): Promise<boolean> {
    const rows = await this.db
      .update(users)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning({ id: users.id });

    return rows.length > 0;
  }

  async updatePasswordHash(id: UserId, passwordHash: string): Promise<boolean> {
    const rows = await this.db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning({ id: users.id });

    return rows.length > 0;
  }

  async recordLogin(id: UserId): Promise<void> {
    await this.db
      .update(users)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, id));
  }

  /** J5's "Full name". Returns the updated row, or null if the id is gone. */
  async updateName(id: UserId, name: string): Promise<UserRow | null> {
    const [row] = await this.db
      .update(users)
      .set({ name, updatedAt: new Date() })
      .where(and(eq(users.id, id), ne(users.status, 'deleted')))
      .returning();

    return row === undefined ? null : toRow(row);
  }

  /**
   * Moves the account to an address that has just been proved.
   *
   * `emailVerifiedAt` is set in the same statement, not left for a second
   * write: the only caller is the redemption of a token that was emailed to
   * this address and clicked, which is the proof. Leaving it null would put
   * the account in the "unverified" state one click after verifying it.
   *
   * The partial unique index on `email` is the real guard against two people
   * holding one address, and it is the reason this reports `taken` rather
   * than throwing: the check the service does before calling is advisory, and
   * the window between that check and this write is exactly where a race
   * lives.
   */
  async updateEmail(id: UserId, email: string): Promise<'updated' | 'not_found' | 'taken'> {
    try {
      const rows = await this.db
        .update(users)
        .set({ email, emailVerifiedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(users.id, id), ne(users.status, 'deleted')))
        .returning({ id: users.id });

      return rows.length > 0 ? 'updated' : 'not_found';
    } catch (error) {
      if (isUniqueViolation(error)) return 'taken';
      throw error;
    }
  }
}

/**
 * A Postgres unique-index violation, and nothing else.
 *
 * Narrow on purpose. Treating any failure as "that address is taken" would
 * report a connection loss as a user error, and the caller would show
 * somebody a message about their email when the database is down.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  );
}

function toRow(row: typeof users.$inferSelect): UserRow {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    emailVerifiedAt: row.emailVerifiedAt,
    passwordHash: row.passwordHash,
    status: row.status,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  };
}
