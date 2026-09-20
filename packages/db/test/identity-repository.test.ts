import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { SessionId, UserId } from '@relayd/types';
import { SessionRepository } from '../src/repositories/global/sessions.js';
import { UserRepository } from '../src/repositories/global/users.js';
import { UserTokenRepository } from '../src/repositories/global/user-tokens.js';
import type { Executor } from '../src/repositories/executor.js';

/**
 * The per-user repositories, without a database.
 *
 * These three are the exception CLAUDE.md section 6.2 names: cross-tenant by
 * necessity, living under `repositories/global/`, and therefore NOT carrying a
 * `WorkspaceScope`. A person is not owned by a workspace — they exist before
 * any workspace and may belong to several — so a scope parameter here would be
 * a lie, and the CI reflection test exempts this directory for that reason.
 *
 * The exemption removes the check; it does not remove the property. What these
 * tests assert is the narrower predicate that replaces it: **every read and
 * every write names the user id**, which is the value the caller takes from a
 * verified access token and cannot forge. A query here that omitted it would
 * read or revoke across accounts with nothing above it to notice, because
 * `users`, `sessions` and `user_tokens` deliberately have no RLS policy
 * (migration 0003) — the fourth layer that catches a workspace mistake does
 * not exist for these tables.
 *
 * Testcontainers is not available on this machine, so the SQL is inspected
 * rather than executed. That is weaker than running it and far stronger than
 * not checking at all.
 */

const USER = 'user-1' as UserId;
const OTHER = 'user-2' as UserId;
const SESSION = 'session-1' as SessionId;

/**
 * Captures what a query builder would send, without sending it.
 *
 * `inspect` rather than `JSON.stringify`, for the reason the analytics
 * repository test gives: a Drizzle condition holds a reference to its column,
 * which references its table, and stringify throws on the cycle.
 */
function capturing(rows: unknown[] = []) {
  const executed: string[] = [];
  const record = (value: unknown) => {
    executed.push(inspect(value, { depth: 8, breakLength: Infinity }));
  };

  const builder = {
    select: () => builder,
    from: () => builder,
    update: () => builder,
    insert: () => builder,
    set: (value: unknown) => {
      record(value);
      return builder;
    },
    values: async (value: unknown) => {
      record(value);
      return rows;
    },
    where: (condition: unknown) => {
      record(condition);
      return builder;
    },
    /**
     * Chainable AND awaitable: a query can end at `orderBy` (the session
     * list) or continue into `limit` (the token lookups), and the double
     * shape is what lets one fake serve both.
     */
    orderBy: (order: unknown) => {
      record(order);
      return Object.assign(Object.create(builder) as typeof builder, {
        then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
      });
    },
    limit: async () => rows,
    returning: async () => rows,
  };

  return { executed, sql: () => executed.join(' '), db: builder as unknown as Executor };
}

describe('every user write names the user', () => {
  it('scopes updateName to one id and skips deleted accounts', async () => {
    const { db, sql } = capturing([{ id: USER, name: 'Dana', email: 'd@example.com' }]);

    await new UserRepository(db).updateName(USER, 'Dana Haddad');

    expect(sql()).toContain('user-1');
    expect(sql()).toContain('deleted');
  });

  it('scopes updateEmail to one id', async () => {
    const { db, sql } = capturing([{ id: USER }]);

    await new UserRepository(db).updateEmail(USER, 'new@example.com');

    expect(sql()).toContain('user-1');
    expect(sql()).toContain('new@example.com');
  });

  it('verifies the new address in the same statement that writes it', async () => {
    // Two statements would leave a window in which the account is on the new
    // address and marked unverified — one click AFTER verifying it.
    const { db, sql } = capturing([{ id: USER }]);

    await new UserRepository(db).updateEmail(USER, 'new@example.com');

    expect(sql()).toContain('emailVerifiedAt');
  });

  it('reports a unique-index collision as taken rather than throwing', async () => {
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              throw Object.assign(new Error('duplicate key'), { code: '23505' });
            },
          }),
        }),
      }),
    } as unknown as Executor;

    await expect(new UserRepository(db).updateEmail(USER, 'taken@example.com')).resolves.toBe(
      'taken',
    );
  });

  it('lets any other failure through', async () => {
    // A connection loss must not be reported to somebody as "that address is
    // taken". Narrow catch, deliberately.
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              throw Object.assign(new Error('connection terminated'), { code: '57P01' });
            },
          }),
        }),
      }),
    } as unknown as Executor;

    await expect(new UserRepository(db).updateEmail(USER, 'a@example.com')).rejects.toThrow(
      'connection terminated',
    );
  });
});

describe('session reads and revocations name the user', () => {
  it('lists only live sessions, newest first', async () => {
    const { db, sql } = capturing([]);

    await new SessionRepository(db).listActiveForUser(USER);

    expect(sql()).toContain('user-1');
    expect(sql()).toContain('revoked_at');
    expect(sql()).toContain('expires_at');
    expect(sql()).toContain('desc');
  });

  it('revokes every other session of ONE user, keeping the named one', async () => {
    const { db, sql } = capturing([]);

    await new SessionRepository(db).revokeAllForUserExcept(USER, SESSION);

    expect(sql()).toContain('user-1');
    // The kept session is named, and it is named as an exclusion.
    expect(sql()).toContain('session-1');
    expect(sql()).toContain('<>');
    // Already-revoked rows are left alone, so revoked_at keeps meaning "when".
    expect(sql()).toContain('revoked_at');
  });

  it('does not name another user anywhere in the revocation', async () => {
    const { db, sql } = capturing([]);

    await new SessionRepository(db).revokeAllForUserExcept(USER, SESSION);

    expect(sql()).not.toContain(OTHER);
  });
});

describe('token lookups', () => {
  it('finds a live token by hash alone, and only a live one', async () => {
    // The hash IS the credential here: the row is reached from an emailed
    // link by someone who may not be signed in at all. Consumed and expired
    // must both look like "no such token".
    const { db, sql } = capturing([]);

    await new UserTokenRepository(db).findLiveByHash(Buffer.from('abc'));

    expect(sql()).toContain('consumed_at');
    expect(sql()).toContain('expires_at');
  });

  it('reads the cooldown from the newest token of that purpose for that user', async () => {
    const { db, sql } = capturing([{ createdAt: new Date() }]);

    await new UserTokenRepository(db).lastIssuedAt(USER, 'email_verification');

    expect(sql()).toContain('user-1');
    expect(sql()).toContain('email_verification');
    expect(sql()).toContain('desc');
  });

  it('writes the proposed address only when one is supplied', async () => {
    const withAddress = capturing([]);
    await new UserTokenRepository(withAddress.db).issue({
      id: 't1',
      userId: USER,
      purpose: 'email_change',
      tokenHash: Buffer.from('abc'),
      expiresAt: new Date(),
      newEmail: 'new@example.com',
    });
    expect(withAddress.sql()).toContain('new@example.com');

    const without = capturing([]);
    await new UserTokenRepository(without.db).issue({
      id: 't2',
      userId: USER,
      purpose: 'password_reset',
      tokenHash: Buffer.from('abc'),
      expiresAt: new Date(),
    });
    // The CHECK in migration 0019 rejects a new_email on any other purpose,
    // so the key must be absent rather than explicitly null.
    expect(without.sql()).not.toContain('newEmail');
  });
});
