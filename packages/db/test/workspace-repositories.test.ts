import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import type { UserId, WorkspaceId, WorkspaceInvitationId } from '@relayd/types';
import { WorkspaceRepository } from '../src/repositories/workspaces.js';
import { WorkspaceInvitationRepository } from '../src/repositories/workspace-invitations.js';
import { GlobalInvitationRepository } from '../src/repositories/global/cross-tenant-lookups.js';
import type { Executor } from '../src/repositories/executor.js';
import type { WorkspaceScope } from '../src/scope.js';

/**
 * The workspace-lifecycle repositories, without a database.
 *
 * Docker is not available here, so this renders the SQL each call would send
 * through Drizzle's own dialect and reads it. That is weaker than running it
 * and far stronger than trusting the builder, and it catches the three things
 * that are invisible at the service layer:
 *
 *   every read and write names the workspace, so a missing `SET LOCAL` would
 *   be a bug rather than a leak;
 *
 *   the guards are in the WHERE clause rather than in a preceding read — a
 *   check-then-write cannot survive two callers;
 *
 *   zero rows is answered, not thrown. Every one of these statements can
 *   legitimately match nothing, and each answer means something different to
 *   the caller.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const OWNER = 'user-owner' as UserId;
const SUCCESSOR = 'user-next' as UserId;

/** Captures the SQL each call would send, rendered through Drizzle. */
function capturing(rows: Record<string, unknown>[] = []) {
  const statements: { text: string; params: unknown[] }[] = [];

  const client = {
    async query(config: string | { text: string }, params: unknown[] = []) {
      statements.push({
        text: typeof config === 'string' ? config : config.text,
        params,
      });
      return { rows, rowCount: rows.length, command: '', fields: [], oid: 0 };
    },
  };

  return { statements, db: drizzle(client as never) as unknown as Executor };
}

const sql = (statements: { text: string }[]): string =>
  statements.map((statement) => statement.text).join(' ');

describe('creating a workspace', () => {
  it('lets the unique index decide whether the slug is free', async () => {
    // Read-then-insert would let two requests both see "free". The partial
    // index is the only thing that can actually answer it.
    const { db, statements } = capturing();

    await new WorkspaceRepository(db).createIfSlugAvailable(SCOPE, {
      id: 'ws-1' as WorkspaceId,
      name: 'Acme',
      slug: 'acme',
      ownerUserId: OWNER,
    });

    expect(statements).toHaveLength(1);
    expect(sql(statements)).toContain('insert into "workspaces"');
    expect(sql(statements)).toContain('on conflict do nothing');
  });

  it('answers null when the slug is taken rather than throwing', async () => {
    const { db } = capturing([]);

    const created = await new WorkspaceRepository(db).createIfSlugAvailable(SCOPE, {
      id: 'ws-1' as WorkspaceId,
      name: 'Acme',
      slug: 'acme',
      ownerUserId: OWNER,
    });

    expect(created).toBeNull();
  });

  it('refuses a scope that names a different workspace', async () => {
    // The scope is what RLS will check the INSERT against. Creating ws-2
    // inside ws-1's scope is a bug in the caller, not a row to write.
    const { db } = capturing();

    await expect(
      new WorkspaceRepository(db).createIfSlugAvailable(SCOPE, {
        id: 'ws-2' as WorkspaceId,
        name: 'Acme',
        slug: 'acme',
        ownerUserId: OWNER,
      }),
    ).rejects.toThrow(/scope must name/u);
  });
});

describe('transferring ownership', () => {
  it('guards on who holds ownership now', async () => {
    const { db, statements } = capturing();

    await new WorkspaceRepository(db).transferOwnership(SCOPE, {
      fromUserId: OWNER,
      toUserId: SUCCESSOR,
    });

    expect(sql(statements)).toContain('update "workspaces"');
    expect(sql(statements)).toContain('"owner_user_id"');
    // Both halves of the guard: this workspace, and the owner we read.
    expect(statements[0]?.params).toContain('ws-1');
    expect(statements[0]?.params).toContain(OWNER);
    expect(sql(statements)).toContain('"deleted_at" is null');
  });

  it('answers false when someone else transferred first', async () => {
    const { db } = capturing([]);

    await expect(
      new WorkspaceRepository(db).transferOwnership(SCOPE, {
        fromUserId: OWNER,
        toUserId: SUCCESSOR,
      }),
    ).resolves.toBe(false);
  });
});

describe('resending an invitation', () => {
  const id = 'inv-1' as WorkspaceInvitationId;
  const cutoff = new Date('2026-09-24T11:00:00.000Z');

  const resend = async (db: Executor) =>
    new WorkspaceInvitationRepository(db).resendIfCooledDown(SCOPE, id, {
      tokenHash: Buffer.from('new-hash'),
      expiresAt: new Date('2026-09-24T12:00:00.000Z'),
      resendableIfExpiringAtOrBefore: cutoff,
    });

  it('updates the invitation in place rather than creating a second one', async () => {
    // Two rows would mean two live tokens for one offer, and revoking the
    // invitation would leave one of them working.
    const { db, statements } = capturing();

    await resend(db);

    expect(sql(statements)).toContain('update "workspace_invitations"');
    expect(sql(statements)).not.toContain('insert into');
    expect(sql(statements)).toContain('"token_hash"');
  });

  it('carries the cooldown, the workspace and the pending guard in one WHERE', async () => {
    const { db, statements } = capturing();

    await resend(db);

    const text = sql(statements);
    expect(text).toContain('"workspace_id" = ');
    expect(text).toContain('"accepted_at" is null');
    expect(text).toContain('"revoked_at" is null');
    expect(text).toContain('"expires_at" <= ');
    expect(statements[0]?.params).toContain('ws-1');
    expect(statements[0]?.params).toContain(cutoff.toISOString());
  });

  it('answers null when the cooldown has not elapsed', async () => {
    // Which is how two clicks a second apart send one email: the second
    // statement matches nothing.
    const { db } = capturing([]);

    await expect(resend(db)).resolves.toBeNull();
  });
});

describe('previewing an invitation by its token', () => {
  it('looks up the hash and joins the workspace and the inviter', async () => {
    const { db, statements } = capturing();

    await new GlobalInvitationRepository(db).previewByTokenHash(Buffer.from('hash'));

    const text = sql(statements);
    expect(text).toContain('"workspace_invitations"');
    expect(text).toContain('inner join "workspaces"');
    expect(text).toContain('inner join "users"');
    expect(text).toContain('"token_hash" = ');
  });

  it('returns nothing for an expired, revoked or accepted invitation', async () => {
    // All three predicates live in the query, so every dead invitation is
    // indistinguishable from an invented token to the caller above.
    const { db, statements } = capturing([]);

    const preview = await new GlobalInvitationRepository(db).previewByTokenHash(
      Buffer.from('hash'),
    );

    const text = sql(statements);
    expect(text).toContain('"accepted_at" is null');
    expect(text).toContain('"revoked_at" is null');
    expect(text).toContain('"expires_at" > ');
    expect(text).toContain('"deleted_at" is null');
    expect(preview).toBeNull();
  });

  it('never selects the token hash back out', async () => {
    // Nothing above it needs the hash, and a preview that returned it would
    // hand the credential to an unauthenticated response.
    const { db, statements } = capturing();

    await new GlobalInvitationRepository(db).previewByTokenHash(Buffer.from('hash'));

    expect(statements[0]?.text.split(' from ')[0]).not.toContain('token_hash');
  });
});
