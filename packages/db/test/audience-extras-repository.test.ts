import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { TagId } from '@relayd/types';
import {
  AudienceStatsRepository,
  ExportJobRepository,
  SavedViewRepository,
  TagMergeRepository,
} from '../src/repositories/audience-extras.js';
import { contactSearchPredicate } from '../src/helpers.js';
import type { Executor } from '../src/repositories/executor.js';
import type { WorkspaceScope } from '../src/scope.js';

/**
 * The audience-extras repositories, without a database.
 *
 * Three things are checkable here and nowhere else in the unit suite.
 *
 * **Every statement carries the workspace.** RLS is the layer that actually
 * holds, but it is the last one, and a query that omits the predicate is a
 * query relying entirely on a `SET LOCAL` somebody else remembered to do.
 * These are aggregates and set operations, which is exactly where a missing
 * predicate produces a plausible-looking number rather than an error.
 *
 * **The merge happens in the right order.** Collapse, then move, then
 * rewrite, then delete. Moving first collides with the `(contact_id,
 * tag_id)` primary key on every contact that already carried both tags, and
 * the failure would arrive as a constraint violation halfway through a
 * merge somebody had already confirmed.
 *
 * **Nothing that is not a UUID reaches the SQL text.** The `= ANY(...)`
 * array is the one place in this file that is interpolated rather than
 * bound, and the grammar check is the only thing making that safe.
 *
 * Applying any of it needs Postgres and lands with the integration suite.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const KEEP = '11111111-1111-4111-8111-111111111111' as TagId;
const LOSE = '22222222-2222-4222-8222-222222222222' as TagId;

/**
 * Captures what a query builder would send, without sending it.
 *
 * `inspect` rather than `JSON.stringify`: a Drizzle condition holds a
 * reference to its column, which holds a reference back to its table, and
 * stringify throws on the cycle.
 */
function capturing(rows: Record<string, unknown>[] = []) {
  const executed: string[] = [];
  const record = (value: unknown) => {
    executed.push(inspect(value, { depth: 10, breakLength: Infinity }));
  };

  const execute = vi.fn(async (query: unknown) => {
    record(query);
    return { rows, rowCount: rows.length };
  });

  const builder = {
    select: () => builder,
    from: () => builder,
    insert: () => builder,
    values: (value: unknown) => {
      record(value);
      return builder;
    },
    onConflictDoNothing: () => builder,
    update: () => builder,
    set: (value: unknown) => {
      record(value);
      return builder;
    },
    delete: () => builder,
    where: (condition: unknown) => {
      record(condition);
      return builder;
    },
    orderBy: () => builder,
    returning: async () => rows,
    limit: async () => rows,
    // A Drizzle query is a thenable, and these chains end on whichever
    // clause the repository happened to write last. Without this, a query
    // that ends at `orderBy` awaits the builder itself.
    then: (resolve: (value: Record<string, unknown>[]) => unknown) => resolve(rows),
  };

  return { executed, db: { ...builder, execute } as unknown as Executor };
}

/** The SQL text a captured `sql` template rendered, with its parameters. */
const text = (executed: string[]) => executed.join(' ');

describe('every read and write is scoped to the workspace', () => {
  it('scopes the saved-view list', async () => {
    const { db, executed } = capturing();
    await new SavedViewRepository(db).list(SCOPE);
    expect(text(executed)).toContain('workspace_id');
    expect(text(executed)).toContain('ws-1');
  });

  it('scopes the saved-view lookup by key', async () => {
    const { db, executed } = capturing();
    await new SavedViewRepository(db).findByKey(SCOPE, 'recent');

    // Both halves: a lookup on the key alone would return another
    // workspace's view, and the key is not unique across the table.
    expect(text(executed)).toContain('workspace_id');
    expect(text(executed)).toContain('recent');
  });

  it('writes the workspace from the scope, never from the caller', async () => {
    const { db, executed } = capturing([{ id: 'v1', workspaceId: 'ws-1', key: 'k', label: 'L', filters: {}, createdAt: new Date() }]);

    await new SavedViewRepository(db).create(SCOPE, {
      id: 'v1',
      key: 'recent',
      label: 'Recent',
      filters: { status: 'subscribed' },
    });

    expect(text(executed)).toContain('ws-1');
  });

  it('scopes the export insert and read', async () => {
    const row = {
      id: 'e1',
      workspaceId: 'ws-1',
      resource: 'contacts',
      status: 'pending',
      filters: {},
      rowCount: null,
      createdAt: new Date(),
    };

    const created = capturing([row]);
    await new ExportJobRepository(created.db).create(SCOPE, {
      id: 'e1',
      resource: 'contacts',
      filters: {},
    });
    expect(text(created.executed)).toContain('ws-1');

    const found = capturing([row]);
    await new ExportJobRepository(found.db).findById(SCOPE, 'e1');
    expect(text(found.executed)).toContain('workspace_id');
  });

  it('scopes every aggregate', async () => {
    const repository = (rows: Record<string, unknown>[] = []) => {
      const captured = capturing(rows);
      return { repository: new AudienceStatsRepository(captured.db), captured };
    };

    const stats = repository([{ contacts: 0, subscribed: 0, suppressed: 0, matching: 0 }]);
    await stats.repository.contactStats(SCOPE, {});
    expect(text(stats.captured.executed)).toContain('workspace_id');

    const counts = repository();
    await counts.repository.tagCounts(SCOPE);
    expect(text(counts.captured.executed)).toContain('workspace_id');

    const summary = repository();
    await summary.repository.suppressionSummary(SCOPE);
    expect(text(summary.captured.executed)).toContain('workspace_id');

    const sources = repository();
    await sources.repository.suppressionSources(SCOPE);
    expect(text(sources.captured.executed)).toContain('workspace_id');
  });

  it('scopes both sides of every join', async () => {
    // An unscoped join is the subtle one: the driving table is filtered, the
    // joined one is not, and the answer is a number that looks right.
    const segments = capturing();
    await new AudienceStatsRepository(segments.db).segmentsByTag(SCOPE);
    expect(text(segments.executed)).toContain('s.workspace_id = t.workspace_id');

    const sources = capturing();
    await new AudienceStatsRepository(sources.db).suppressionSources(SCOPE);
    expect(text(sources.executed)).toContain('c.workspace_id = s.workspace_id');
  });

  it('scopes every statement the merge runs', async () => {
    const { db, executed } = capturing([{ contacts: 7 }]);
    await new TagMergeRepository(db).merge(SCOPE, KEEP, [LOSE]);

    // Six statements: collapse, move, rewrite, delete, recount — and every
    // one of them names the workspace. One that did not would reach across
    // tenants with a tag id that RLS would have caught only by luck.
    const statements = executed.filter((entry) => entry.includes('workspace_id'));
    expect(statements.length).toBe(executed.length);
    expect(executed.length).toBeGreaterThanOrEqual(5);
  });
});

describe('the counts answer the question the header asks', () => {
  it('counts suppressions from suppressions, not from contacts', async () => {
    // D1 says "suppressed and never sent to". An address can be suppressed
    // without ever having been a contact, so counting contacts with
    // status = 'unsubscribed' would understate it.
    const { db, executed } = capturing([{ contacts: 3, subscribed: 2, suppressed: 1, matching: 3 }]);
    await new AudienceStatsRepository(db).contactStats(SCOPE, {});

    expect(text(executed)).toContain('FROM suppressions');
    expect(text(executed)).toContain('FROM contacts');
  });

  it('excludes soft-deleted contacts from every count', async () => {
    const { db, executed } = capturing([{ contacts: 0, subscribed: 0, suppressed: 0, matching: 0 }]);
    await new AudienceStatsRepository(db).contactStats(SCOPE, {});
    expect(text(executed)).toContain('deleted_at IS NULL');
  });

  it('applies the page filter to matching only', async () => {
    const { db, executed } = capturing([{ contacts: 9, subscribed: 9, suppressed: 0, matching: 4 }]);
    await new AudienceStatsRepository(db).contactStats(SCOPE, { status: 'bounced' });

    // "48,213 contacts" is the whole audience however the page is filtered;
    // only the footer's count narrows.
    expect(text(executed)).toContain('bounced');
    expect(text(executed)).toContain('FILTER');
  });

  it('reads zero from an empty result rather than undefined', async () => {
    const { db } = capturing([]);
    const stats = await new AudienceStatsRepository(db).contactStats(SCOPE, {});
    expect(stats).toEqual({ contacts: 0, subscribed: 0, suppressed: 0, matching: 0 });
  });

  it('answers a merge preview for no tags without touching the database', async () => {
    const { db, executed } = capturing();
    const preview = await new AudienceStatsRepository(db).mergePreview(SCOPE, []);
    expect(preview).toEqual({ total: 0, overlap: 0 });
    expect(executed).toEqual([]);
  });

  it('counts a contact carrying both tags once, and as an overlap', async () => {
    const { db, executed } = capturing([{ total: 5, overlap: 2 }]);
    const preview = await new AudienceStatsRepository(db).mergePreview(SCOPE, [KEEP, LOSE]);

    expect(preview).toEqual({ total: 5, overlap: 2 });
    // The GROUP BY is what makes `total` distinct contacts rather than
    // memberships, and `tags_held > 1` is what makes overlap mean "had both".
    expect(text(executed)).toContain('GROUP BY contact_id');
    expect(text(executed)).toContain('tags_held > 1');
  });
});

describe('the merge', () => {
  it('collapses before it moves', async () => {
    const { db, executed } = capturing([{ contacts: 1 }]);
    await new TagMergeRepository(db).merge(SCOPE, KEEP, [LOSE]);

    const collapse = executed.findIndex((entry) => entry.includes('DELETE FROM contact_tags'));
    const move = executed.findIndex((entry) => entry.includes('UPDATE contact_tags'));

    expect(collapse).toBeGreaterThanOrEqual(0);
    expect(move).toBeGreaterThan(collapse);
  });

  it('deletes the losing tags only after their memberships have moved', async () => {
    const { db, executed } = capturing([{ contacts: 1 }]);
    await new TagMergeRepository(db).merge(SCOPE, KEEP, [LOSE]);

    const move = executed.findIndex((entry) => entry.includes('UPDATE contact_tags'));
    const drop = executed.findIndex((entry) => entry.includes('DELETE FROM tags'));

    expect(drop).toBeGreaterThan(move);
  });

  it('rewrites the segments that name a losing tag', async () => {
    const { db, executed } = capturing([{ contacts: 1 }]);
    await new TagMergeRepository(db).merge(SCOPE, KEEP, [LOSE]);

    const rewrite = executed.find((entry) => entry.includes('UPDATE segments'));
    expect(rewrite).toBeDefined();
    expect(rewrite).toContain(LOSE);
    expect(rewrite).toContain(KEEP);
  });

  it('does nothing at all when there is nothing to merge', async () => {
    const { db, executed } = capturing();
    const result = await new TagMergeRepository(db).merge(SCOPE, KEEP, []);

    expect(result).toEqual({ moved: 0, collapsed: 0, segmentsRewritten: 0, contacts: 0 });
    expect(executed).toEqual([]);
  });

  it('refuses an id that is not a UUID rather than interpolating it', async () => {
    // The `= ANY(ARRAY[...])` literal is the one interpolated string in the
    // file. The grammar check is the whole reason it is allowed to be.
    const { db, executed } = capturing([{ contacts: 0 }]);

    await expect(
      new TagMergeRepository(db).merge(SCOPE, KEEP, ["') OR true --" as TagId]),
    ).rejects.toThrow(/not a UUID/u);

    expect(executed).toEqual([]);
  });

  it('refuses a non-UUID in a merge preview too', async () => {
    const { db } = capturing();
    await expect(
      new AudienceStatsRepository(db).mergePreview(SCOPE, ['not-a-uuid' as TagId]),
    ).rejects.toThrow(/not a UUID/u);
  });
});

/** The bound parameters of a `sql` template, as the driver would receive them. */
function boundParameters(statement: unknown): string[] {
  const chunks = (statement as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.filter((chunk): chunk is string => typeof chunk === 'string');
}

describe('the search predicate', () => {
  it('matches the address and both names', () => {
    const rendered = inspect(contactSearchPredicate('kha'), { depth: 10 });
    expect(rendered).toContain('email');
    expect(rendered).toContain('first_name');
    expect(rendered).toContain('last_name');
  });

  it('escapes the wildcards, so a stray % is not a full scan', () => {
    // The user's own % and _ arrive escaped; only the surrounding wildcards
    // are live. Unescaped, a search for "%" matches the entire audience and
    // a search for "a_b" quietly matches "axb".
    const parameters = boundParameters(contactSearchPredicate('50%_off'));

    expect(parameters.length).toBe(3);
    for (const parameter of parameters) {
      expect(parameter).toBe('%50\\%\\_off%');
    }
  });

  it('binds the pattern rather than inlining it', () => {
    // A search box is user input arriving straight from a URL; it reaches
    // the database as a parameter or not at all.
    expect(boundParameters(contactSearchPredicate("'; drop table contacts --"))).toEqual([
      "%'; drop table contacts --%",
      "%'; drop table contacts --%",
      "%'; drop table contacts --%",
    ]);
  });

  it('is a no-op for an empty search, not a match on empty string', () => {
    for (const value of [undefined, null, '']) {
      expect(inspect(contactSearchPredicate(value), { depth: 10 })).toContain('TRUE');
      expect(boundParameters(contactSearchPredicate(value))).toEqual([]);
    }
  });
});
