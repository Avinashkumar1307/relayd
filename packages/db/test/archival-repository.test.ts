import { describe, expect, it, vi } from 'vitest';
import { CampaignRepository } from '../src/repositories/campaigns.js';
import { TemplateRepository } from '../src/repositories/templates.js';
import type { Executor } from '../src/repositories/executor.js';
import type { CampaignId, TemplateId } from '@relayd/types';
import type { WorkspaceScope } from '../src/scope.js';

/**
 * Archival and the campaign timeline, without a database.
 *
 * Three things are checkable here and nowhere else in the unit suite.
 *
 * **Every statement filters on the workspace.** RLS is the layer that
 * actually holds; the scope predicate is the one a reader can see. A write
 * that omits it is a write relying entirely on a `SET LOCAL` somebody else
 * remembered to do.
 *
 * **Archiving is a guarded UPDATE, not a read-then-write.** `archive` must
 * carry `archived_at IS NULL` so a second call reports honestly, and the
 * campaign one must carry the terminal-status list so a campaign that is
 * still sending can never be hidden from the list that is watching it.
 *
 * **The timeline reads `campaign_events` only.** R13 forbids counting
 * `campaign_recipients` in a request path, and a timeline is a request path.
 *
 * The same idea as `analytics-repository.test.ts` — capture what the builder
 * would send without sending it — but with a narrower renderer. `inspect`
 * cannot be used here: a Drizzle column carries a reference to its whole
 * table, so inspecting one condition prints every column name in the table
 * and a negative assertion like "this statement does not mention
 * `campaign_recipients`" passes or fails for reasons that have nothing to do
 * with the statement. `render` below walks the tree and emits the table
 * name, the column names and the bound values, and stops at a column rather
 * than descending into its table.
 */

const DRIZZLE_NAME = Symbol.for('drizzle:Name');
const IS_TABLE = Symbol.for('drizzle:IsDrizzleTable');

function render(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '';
  seen.add(value);

  if (Array.isArray(value)) return value.map((entry) => render(entry, seen)).join(' ');

  const record = value as Record<PropertyKey, unknown>;

  // A table: its name, and nothing else. Descending would print the whole
  // schema and make every negative assertion meaningless.
  if (record[IS_TABLE] === true) return String(record[DRIZZLE_NAME] ?? '');

  // A column: its name, not its table.
  if (typeof record['columnType'] === 'string' && typeof record['name'] === 'string') {
    return record['name'];
  }

  return Object.entries(record)
    .filter(([key]) => key !== 'table')
    .map(([key, entry]) => {
      const rendered = render(entry, seen);
      return rendered === '' ? '' : `${key}=${rendered}`;
    })
    .filter((part) => part !== '')
    .join(' ');
}

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const CAMPAIGN = 'c1' as CampaignId;
const TEMPLATE = 't1' as TemplateId;

function capturing(rows: unknown[] = []) {
  const executed: string[] = [];
  const record = (value: unknown) => {
    executed.push(render(value));
  };

  const builder: Record<string, unknown> = {};

  const chain = (name: string) => (value?: unknown) => {
    if (value !== undefined) record({ [name]: value });
    return builder;
  };

  Object.assign(builder, {
    select: chain('select'),
    from: chain('from'),
    update: chain('update'),
    set: chain('set'),
    leftJoin: (table: unknown, on: unknown) => {
      record({ leftJoin: [table, on] });
      return builder;
    },
    where: chain('where'),
    orderBy: chain('orderBy'),
    returning: async () => rows,
    limit: async (value: number) => {
      record({ limit: value });
      return rows;
    },
    execute: vi.fn(async (query: unknown) => {
      record(query);
      return { rows: [], rowCount: 0 };
    }),
  });

  return { executed, db: builder as unknown as Executor, sql: () => executed.join(' ') };
}

/* ------------------------------------------------------------- templates -- */

describe('archiving a template', () => {
  it('is a guarded update scoped to the workspace', async () => {
    const { db, sql } = capturing();

    await new TemplateRepository(db).archive(SCOPE, TEMPLATE);

    expect(sql()).toContain('ws-1');
    expect(sql()).toContain('workspace_id');
    // Guarded: a second archive must match nothing rather than move the
    // timestamp, so the service can answer 409 instead of pretending.
    expect(sql()).toContain('archived_at');
    // Never a soft-deleted row.
    expect(sql()).toContain('deleted_at');
  });

  it('unarchives only a row that is archived', async () => {
    const { db, sql } = capturing();

    await new TemplateRepository(db).unarchive(SCOPE, TEMPLATE);

    expect(sql()).toContain('archived_at');
    expect(sql()).toContain('ws-1');
  });

  it('answers null when the guard matched nothing', async () => {
    const { db } = capturing([]);
    expect(await new TemplateRepository(db).archive(SCOPE, TEMPLATE)).toBeNull();
  });

  it('reports the row as archived once the column is set', async () => {
    const row = {
      id: TEMPLATE,
      workspaceId: 'ws-1',
      name: 'Autumn escapes',
      category: null,
      currentVersionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: new Date(),
    };

    const { db } = capturing([row]);
    const result = await new TemplateRepository(db).archive(SCOPE, TEMPLATE);

    // A boolean, not the timestamp: nothing above this layer has a use for
    // when, and a nullable date read as a flag is a bug waiting to happen.
    expect(result?.archived).toBe(true);
  });

  it('reports an unarchived row as not archived', async () => {
    const row = {
      id: TEMPLATE,
      workspaceId: 'ws-1',
      name: 'Autumn escapes',
      category: null,
      currentVersionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
    };

    const { db } = capturing([row]);
    expect((await new TemplateRepository(db).unarchive(SCOPE, TEMPLATE))?.archived).toBe(false);
  });
});

describe('listing templates', () => {
  it('does not filter archived rows out', async () => {
    // F1 draws Active and Archived as two tabs over one list and splits in
    // the browser. Filtering here would empty the second tab.
    const { db, sql } = capturing();

    await new TemplateRepository(db).list(SCOPE);

    expect(sql()).not.toContain('archived_at');
    expect(sql()).toContain('ws-1');
  });
});

describe('finding a free name for a duplicate', () => {
  it('scopes the read and escapes LIKE metacharacters', async () => {
    const { db, sql } = capturing();

    await new TemplateRepository(db).listNamesLike(SCOPE, '50% off (copy)');

    expect(sql()).toContain('ws-1');
    // Without the escape, "50%" turns the customer's own name into a
    // wildcard and the read returns the whole workspace.
    expect(sql()).toContain('50\\% off (copy)%');
    expect(sql()).toContain('ESCAPE');
  });
});

/* ------------------------------------------------------------- campaigns -- */

describe('archiving a campaign', () => {
  it('only matches a terminal campaign', async () => {
    // The guard, not a prior read: a campaign can finish between a read and
    // a write, and — the case that matters — one that is still sending must
    // never be hidden from the list that is watching it.
    const { db, sql } = capturing();

    await new CampaignRepository(db).archive(SCOPE, CAMPAIGN);

    for (const status of ['completed', 'completed_with_errors', 'cancelled', 'failed']) {
      expect(sql()).toContain(status);
    }

    expect(sql()).not.toContain('sending');
    expect(sql()).not.toContain('draft');
  });

  it('is scoped and guarded on archived_at', async () => {
    const { db, sql } = capturing();

    await new CampaignRepository(db).archive(SCOPE, CAMPAIGN);

    expect(sql()).toContain('ws-1');
    expect(sql()).toContain('archived_at');
    expect(sql()).toContain('deleted_at');
  });

  it('unarchives without a status guard', async () => {
    // Whatever state it was archived in is the state it comes back to.
    const { db, sql } = capturing();

    await new CampaignRepository(db).unarchive(SCOPE, CAMPAIGN);

    expect(sql()).toContain('archived_at');
    expect(sql()).not.toContain('completed_with_errors');
  });
});

describe('listing campaigns', () => {
  const list = (archived?: 'active' | 'archived' | 'all') => {
    const captured = capturing();
    return {
      ...captured,
      run: () =>
        new CampaignRepository(captured.db).list(SCOPE, {
          limit: 25,
          ...(archived === undefined ? {} : { archived }),
        }),
    };
  };

  it('hides archived campaigns by default', async () => {
    const { run, sql } = list();
    await run();
    expect(sql()).toContain('archived_at');
  });

  it('still hides them when asked for active explicitly', async () => {
    const { run, sql } = list('active');
    await run();
    expect(sql()).toContain('archived_at');
  });

  it('shows only archived ones when asked', async () => {
    const { run, sql } = list('archived');
    await run();
    expect(sql()).toContain('archived_at');
  });

  it('applies no archival predicate for all', async () => {
    // An export that silently omitted rows would be worse than a slow one.
    const { run, sql } = list('all');
    await run();
    expect(sql()).not.toContain('archived_at');
  });
});

describe('the campaign timeline', () => {
  it('reads campaign_events, scoped to the workspace and the campaign', async () => {
    const { db, sql } = capturing();

    await new CampaignRepository(db).listEvents(SCOPE, CAMPAIGN);

    expect(sql()).toContain('campaign_events');
    expect(sql()).toContain('ws-1');
    expect(sql()).toContain('c1');
  });

  it('never touches campaign_recipients (R13)', async () => {
    // A timeline is a request path, and R13 forbids counting recipients in
    // one. Every number a timeline row quotes came out of the event's own
    // detail blob.
    const { db, sql } = capturing();

    await new CampaignRepository(db).listEvents(SCOPE, CAMPAIGN);

    expect(sql()).not.toContain('campaign_recipients');
    expect(sql().toLowerCase()).not.toContain('count(');
  });

  it('joins users on the left, so system events survive', async () => {
    // Most entries have no actor. An inner join would drop every one of
    // them, which is most of the timeline.
    const { db, sql } = capturing();

    await new CampaignRepository(db).listEvents(SCOPE, CAMPAIGN);

    expect(sql()).toContain('leftJoin');
    expect(sql()).toContain('users');
  });

  it('is bounded, and the bound cannot be raised past 200', async () => {
    const { db, executed } = capturing();

    await new CampaignRepository(db).listEvents(SCOPE, CAMPAIGN, { limit: 100_000 });

    expect(executed.join(' ')).toContain('limit=200');
  });

  it('renders the bigserial id as a string', async () => {
    // A bigint does not survive JSON.stringify — it throws — and the client
    // declares the id as a string.
    const { db } = capturing([
      {
        id: 9007199254740993n,
        eventType: 'launch.queued',
        actorType: 'user',
        actorId: 'u1',
        actorName: 'Farah Al-Mansoori',
        detail: {},
        createdAt: new Date(),
      },
    ]);

    const [row] = await new CampaignRepository(db).listEvents(SCOPE, CAMPAIGN);

    expect(row?.id).toBe('9007199254740993');
    expect(() => JSON.stringify(row)).not.toThrow();
  });
});
