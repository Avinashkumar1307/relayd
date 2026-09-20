import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { AuditQueryRepository } from '../src/repositories/audit.js';
import type { Executor } from '../src/repositories/executor.js';
import type { WorkspaceScope } from '../src/scope.js';

/**
 * The audit query repository, without a database.
 *
 * Docker is not available here, so the thing to prove without Postgres is the
 * shape of the SQL — and for this table the shape is the security boundary
 * twice over.
 *
 * **Every read filters on the workspace.** `audit_logs.workspace_id` is
 * nullable, because platform events belong to no workspace. RLS is an
 * equality and therefore excludes those rows, but RLS is the fourth layer;
 * the predicate is the one a reader can see, and a query that omits it is a
 * query relying entirely on a `SET LOCAL` somebody else remembered.
 *
 * **The join to `api_keys` carries the workspace too.** `users` is
 * cross-tenant by design, so joining it on an id is safe; `api_keys` is
 * tenant-owned, and an unscoped join there is a way for one workspace's key
 * name to appear in another's audit log.
 *
 * And one performance property that only exists in the text: the ordering
 * must match `ix_audit_ws_time (workspace_id, occurred_at DESC)`, or every
 * page of an append-only table becomes a sort.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const OTHER = { workspaceId: 'ws-2' } as unknown as WorkspaceScope;
const NOW = new Date('2026-09-20T12:00:00.000Z');

/**
 * Captures what would be sent, without sending it.
 *
 * `inspect` rather than `JSON.stringify`: a Drizzle `sql` fragment holds
 * references to its own chunks and stringify throws on the cycle. `inspect`
 * renders both the literal text and the bound parameters, which is all this
 * needs to see.
 */
function capturing(rows: Record<string, unknown>[][] = []) {
  const executed: string[] = [];
  const queue = [...rows];

  const execute = vi.fn(async (query: unknown) => {
    executed.push(inspect(query, { depth: 12, breakLength: Infinity }));
    const next = queue.shift() ?? [];
    return { rows: next, rowCount: next.length };
  });

  return { executed, db: { execute } as unknown as Executor };
}

const sqlOf = (executed: string[]) => executed.join(' ');

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    occurredAt: NOW,
    actorType: 'user',
    actorId: 'u1',
    actorName: 'Dana Haddad',
    action: 'campaign.launched',
    resourceType: 'campaign',
    resourceId: 'c1',
    before: null,
    after: { recipientCount: 42 },
    ...over,
  };
}

describe('every audit read is scoped to the workspace', () => {
  it('scopes the page read, and names the workspace it was given', async () => {
    const { db, executed } = capturing();

    await new AuditQueryRepository(db).list(SCOPE, {}, { limit: 10 });

    expect(sqlOf(executed)).toContain('al.workspace_id = ');
    expect(sqlOf(executed)).toContain('ws-1');
    expect(sqlOf(executed)).not.toContain('ws-2');
  });

  it('scopes the count', async () => {
    const { db, executed } = capturing();

    await new AuditQueryRepository(db).count(OTHER, {});

    expect(sqlOf(executed)).toContain('al.workspace_id = ');
    expect(sqlOf(executed)).toContain('ws-2');
  });

  it('scopes all three filter-option reads', async () => {
    const { db, executed } = capturing();

    await new AuditQueryRepository(db).filterOptions(SCOPE, { now: NOW });

    expect(executed).toHaveLength(3);
    for (const query of executed) {
      expect(query).toContain('al.workspace_id = ');
      expect(query).toContain('ws-1');
    }
  });

  it('scopes the export stream', async () => {
    const { db, executed } = capturing([[row()]]);

    const repository = new AuditQueryRepository(db);
    for await (const _ of repository.stream(SCOPE, {}, { chunkSize: 5 })) {
      // drain
    }

    expect(sqlOf(executed)).toContain('ws-1');
  });

  it('scopes the api_keys join, so another workspace cannot name an actor', async () => {
    const { db, executed } = capturing();

    await new AuditQueryRepository(db).list(SCOPE, {}, { limit: 10 });

    // Both halves: the id match and the workspace match. Without the second,
    // a key id is a global lookup.
    expect(sqlOf(executed)).toContain('k.id = al.actor_id');
    expect(sqlOf(executed)).toContain('k.workspace_id = al.workspace_id');
  });

  it('names the actor from users only for user rows', async () => {
    const { db, executed } = capturing();

    await new AuditQueryRepository(db).list(SCOPE, {}, { limit: 10 });

    expect(sqlOf(executed)).toContain("al.actor_type = 'user'");
    expect(sqlOf(executed)).toContain('u.id = al.actor_id');
  });
});

describe('the page walks ix_audit_ws_time', () => {
  it('orders newest first on occurred_at, with a stable tiebreak', async () => {
    const { db, executed } = capturing();

    await new AuditQueryRepository(db).list(SCOPE, {}, { limit: 10 });

    // (workspace_id, occurred_at DESC) is the index; the id tiebreak costs an
    // incremental sort within one timestamp and buys a cursor that cannot
    // skip or repeat a row.
    expect(sqlOf(executed)).toContain('ORDER BY al.occurred_at DESC, al.id DESC');
  });

  it('asks for one row more than the page, rather than counting twice', async () => {
    const { db, executed } = capturing([Array.from({ length: 11 }, (_, i) => row({ id: `a${i}` }))]);

    const page = await new AuditQueryRepository(db).list(SCOPE, {}, { limit: 10 });

    expect(sqlOf(executed)).toContain('11');
    expect(page.rows).toHaveLength(10);
    expect(page.nextCursor).toBeDefined();
  });

  it('offers no cursor when the page was the last one', async () => {
    const { db } = capturing([[row(), row({ id: 'a2' })]]);

    const page = await new AuditQueryRepository(db).list(SCOPE, {}, { limit: 10 });

    expect(page.nextCursor).toBeUndefined();
  });

  it('carries the range lower bound, so partitions outside it can be pruned', async () => {
    const { db, executed } = capturing();

    await new AuditQueryRepository(db).list(
      SCOPE,
      { since: new Date('2026-08-21T00:00:00.000Z') },
      { limit: 10 },
    );

    expect(sqlOf(executed)).toContain('al.occurred_at >= ');
    expect(sqlOf(executed)).toContain('2026-08-21T00:00:00.000Z');
  });

  it('resumes strictly after the cursor, comparing both columns at once', async () => {
    // A full page, so the repository hands back a cursor to resume from.
    const { db: first } = capturing([[row({ id: 'x' }), row({ id: 'y' })]]);
    const page = await new AuditQueryRepository(first).list(SCOPE, {}, { limit: 1 });
    const cursor = page.nextCursor;
    expect(cursor).toBeDefined();

    const { db, executed } = capturing();
    await new AuditQueryRepository(db).list(SCOPE, {}, { limit: 1, cursor: cursor as string });

    // A row comparison, not two independent ones: `occurred_at < t OR id < i`
    // would drop every row sharing the cursor's timestamp, and an audit log
    // writes several rows a second.
    expect(sqlOf(executed)).toContain('(al.occurred_at, al.id) < (');
    expect(sqlOf(executed)).toContain(NOW.toISOString());
    expect(sqlOf(executed)).toContain("'x'");
  });

  it('ignores an unreadable cursor rather than guessing a position', async () => {
    const { db, executed } = capturing();

    await new AuditQueryRepository(db).list(SCOPE, {}, { limit: 10, cursor: 'not-a-cursor' });

    // The route refuses this with a 400 before it gets here; the repository
    // simply must not invent a predicate out of it.
    expect(sqlOf(executed)).not.toContain('(al.occurred_at, al.id) < (');
  });
});

describe('filters', () => {
  it('filters an action by equality, not by prefix', async () => {
    const { db, executed } = capturing();

    await new AuditQueryRepository(db).list(SCOPE, { action: 'campaign.launched' }, { limit: 10 });

    expect(sqlOf(executed)).toContain('al.action = ');
    expect(sqlOf(executed)).toContain('campaign.launched');
  });

  it('matches a resource by id or by type, casting the column and never the value', async () => {
    const { db, executed } = capturing();

    await new AuditQueryRepository(db).list(SCOPE, { resource: 'campaign' }, { limit: 10 });

    // `'campaign'::uuid` would raise; `resource_id::text` cannot.
    expect(sqlOf(executed)).toContain('al.resource_id::text = ');
    expect(sqlOf(executed)).toContain('al.resource_type = ');
  });

  it('reads the system actor as a type, since those rows carry no actor id', async () => {
    const { db, executed } = capturing();

    await new AuditQueryRepository(db).list(SCOPE, { systemActor: true }, { limit: 10 });

    expect(sqlOf(executed)).toContain("al.actor_type IN ('system','provider')");
    expect(sqlOf(executed)).not.toContain('al.actor_id = ');
  });

  it('filters a named actor by id', async () => {
    const { db, executed } = capturing();

    await new AuditQueryRepository(db).list(SCOPE, { actorId: 'u-7' }, { limit: 10 });

    expect(sqlOf(executed)).toContain('al.actor_id = ');
    expect(sqlOf(executed)).toContain('u-7');
  });

  it('searches the action, the resource and both payloads', async () => {
    const { db, executed } = capturing();

    await new AuditQueryRepository(db).list(SCOPE, { search: 'northwind' }, { limit: 10 });

    const text = sqlOf(executed);
    expect(text).toContain('al.action ILIKE ');
    expect(text).toContain('al.resource_type ILIKE ');
    expect(text).toContain('al.before::text');
    expect(text).toContain('al.after::text');
  });

  it('makes a wildcard the user typed a literal', async () => {
    const { db, executed } = capturing();

    await new AuditQueryRepository(db).list(SCOPE, { search: '100%_off' }, { limit: 10 });

    // Unescaped, `%` matches everything and `_` matches any character — not
    // an injection, but a filter that lies about what it matched.
    expect(sqlOf(executed)).toContain('100\\\\%\\\\_off');
    expect(sqlOf(executed)).toContain("ESCAPE '\\\\'");
  });

  it('counts without the joins, which narrow nothing', async () => {
    const { db, executed } = capturing([[{ total: 3412 }]]);

    const total = await new AuditQueryRepository(db).count(SCOPE, {});

    expect(total).toBe(3412);
    expect(sqlOf(executed)).not.toContain('LEFT JOIN');
  });

  it('counts zero rather than undefined when the count comes back empty', async () => {
    const { db } = capturing([[]]);

    expect(await new AuditQueryRepository(db).count(SCOPE, {})).toBe(0);
  });
});

describe('the export stream', () => {
  it('pages with a cursor rather than a deepening offset', async () => {
    // Two full chunks of one row, then an empty one.
    const { db, executed } = capturing([
      [row({ id: 'a1' }), row({ id: 'a2' })],
      [row({ id: 'a2' })],
    ]);

    const seen: string[] = [];
    for await (const item of new AuditQueryRepository(db).stream(SCOPE, {}, { chunkSize: 1 })) {
      seen.push(item.id);
    }

    expect(seen).toEqual(['a1', 'a2']);
    expect(sqlOf(executed)).toContain('(al.occurred_at, al.id) < (');
    expect(sqlOf(executed)).not.toContain('OFFSET $');
  });

  it('stops at the row cap instead of streaming a whole history', async () => {
    // Always one more than asked for, so the stream would never end on its own.
    const endless = { execute: vi.fn(async () => ({ rows: [row(), row()], rowCount: 2 })) };

    const seen: unknown[] = [];
    for await (const item of new AuditQueryRepository(endless as unknown as Executor).stream(
      SCOPE,
      {},
      { chunkSize: 1, maxRows: 3 },
    )) {
      seen.push(item);
    }

    expect(seen).toHaveLength(3);
  });
});
