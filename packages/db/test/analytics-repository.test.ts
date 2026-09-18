import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsRepository } from '../src/repositories/analytics.js';
import type { Executor } from '../src/repositories/executor.js';
import type { CampaignId } from '@relayd/types';
import type { WorkspaceScope } from '../src/scope.js';

/**
 * The analytics repository, without a database.
 *
 * Two things are checkable here and nowhere else in the unit suite.
 *
 * **Every read filters on the workspace.** RLS is the layer that actually
 * holds, but it is the fourth layer — the scope predicate is the one a reader
 * can see, and a query that omits it is a query relying entirely on a
 * `SET LOCAL` somebody else remembered to do.
 *
 * **`botFilteredFor` cannot go negative.** It is a difference between two
 * columns written by two different passes of the rollup, and a negative
 * number there would render as "-4 automated opens removed", which is worse
 * than showing nothing.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const ID = 'c1' as CampaignId;

/**
 * Captures what a query builder would send, without sending it.
 *
 * `inspect` rather than `JSON.stringify`: a Drizzle condition holds a
 * reference to its column, which holds a reference back to its table, and
 * stringify throws on the cycle. `inspect` handles it and still renders the
 * column and table names, which is all this needs to see.
 */
function capturing() {
  const executed: string[] = [];
  const record = (value: unknown) => {
    executed.push(inspect(value, { depth: 8, breakLength: Infinity }));
  };

  const execute = vi.fn(async (query: unknown) => {
    record(query);
    return { rows: [], rowCount: 0 };
  });

  const builder = {
    select: () => builder,
    from: () => builder,
    where: (condition: unknown) => {
      record(condition);
      return builder;
    },
    orderBy: () => builder,
    limit: async () => [],
  };

  return { executed, db: { ...builder, execute } as unknown as Executor };
}

describe('every read is scoped to the workspace', () => {
  it('scopes the campaign stats read', async () => {
    const { db, executed } = capturing();

    await new AnalyticsRepository(db).campaignStats(SCOPE, ID);

    expect(executed.join(' ')).toContain('ws-1');
    expect(executed.join(' ')).toContain('workspace_id');
  });

  it('scopes the daily read', async () => {
    const { db, executed } = capturing();

    await new AnalyticsRepository(db).campaignDaily(SCOPE, {
      campaignId: ID,
      from: '2026-09-01',
      to: '2026-09-30',
    });

    expect(executed.join(' ')).toContain('workspace_id');
  });

  it('scopes the link read', async () => {
    const { db, executed } = capturing();

    await new AnalyticsRepository(db).campaignLinks(SCOPE, ID);

    // Both sides of the join: an unscoped `tracked_links` would let a link
    // row from another workspace supply the URL for our stats row.
    expect(executed.join(' ')).toContain('ls.workspace_id');
    expect(executed.join(' ')).toContain('tl.workspace_id');
  });

  it('scopes the device read', async () => {
    const { db, executed } = capturing();
    await new AnalyticsRepository(db).campaignDevices(SCOPE, ID);
    expect(executed.join(' ')).toContain('workspace_id');
  });

  it('scopes the provider breakdown', async () => {
    const { db, executed } = capturing();
    await new AnalyticsRepository(db).providerBreakdown(SCOPE, { from: '2026-09-01', to: '2026-09-30' });
    expect(executed.join(' ')).toContain('workspace_id');
  });

  it('scopes the workspace overview', async () => {
    const { db, executed } = capturing();
    await new AnalyticsRepository(db).workspaceOverview(SCOPE, { from: '2026-09-01', to: '2026-09-30' });
    expect(executed.join(' ')).toContain('workspace_id');
  });
});

describe('what the reads never touch', () => {
  it('never queries email_events', async () => {
    // The rollups exist so that no dashboard query grows with the events
    // table. One that slipped through would be fast today and unusable in a
    // year, which is the worst possible moment to discover it.
    const { db, executed } = capturing();
    const repository = new AnalyticsRepository(db);

    await repository.campaignLinks(SCOPE, ID);
    await repository.providerBreakdown(SCOPE, { from: '2026-09-01', to: '2026-09-30' });
    await repository.workspaceOverview(SCOPE, { from: '2026-09-01', to: '2026-09-30' });

    expect(executed.join(' ')).not.toContain('email_events');
  });

  it('bounds the link table', async () => {
    // A campaign with ten thousand tracked links would otherwise return all
    // of them to a table nobody scrolls past fifty rows of.
    const { db, executed } = capturing();
    await new AnalyticsRepository(db).campaignLinks(SCOPE, ID);
    expect(executed.join(' ')).toContain('LIMIT');
  });
});

describe('botFilteredFor', () => {
  function withStats(stats: Record<string, number>) {
    const repository = new AnalyticsRepository({} as unknown as Executor);
    vi.spyOn(repository, 'campaignStats').mockResolvedValue(stats as never);
    return repository;
  }

  it('adds the opens and the clicks the filter removed', async () => {
    const repository = withStats({
      opensUnique: 600, opensUniqueNonbot: 420,
      clicksUnique: 180, clicksUniqueNonbot: 175,
    });

    expect(await repository.botFilteredFor(SCOPE, ID)).toBe(180 + 5);
  });

  it('never goes negative', async () => {
    // The two columns are written by two different passes of the rollup. A
    // moment where the non-bot count is briefly higher is not impossible, and
    // "-4 automated opens removed" is worse than showing nothing.
    const repository = withStats({
      opensUnique: 400, opensUniqueNonbot: 420,
      clicksUnique: 100, clicksUniqueNonbot: 175,
    });

    expect(await repository.botFilteredFor(SCOPE, ID)).toBe(0);
  });

  it('floors each term separately, not the sum', async () => {
    // Otherwise a large genuine open filter would mask a negative click one
    // and the total would still look plausible.
    const repository = withStats({
      opensUnique: 600, opensUniqueNonbot: 420,
      clicksUnique: 100, clicksUniqueNonbot: 175,
    });

    expect(await repository.botFilteredFor(SCOPE, ID)).toBe(180);
  });

  it('is zero when there are no stats at all', async () => {
    const repository = new AnalyticsRepository({} as unknown as Executor);
    vi.spyOn(repository, 'campaignStats').mockResolvedValue(null);

    expect(await repository.botFilteredFor(SCOPE, ID)).toBe(0);
  });
});
