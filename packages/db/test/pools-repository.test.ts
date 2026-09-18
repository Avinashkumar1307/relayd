import { describe, expect, it, vi } from 'vitest';
import { CampaignRepository } from '../src/repositories/campaigns.js';
import { SendingPoolRepository } from '../src/repositories/pools.js';
import type { Executor } from '../src/repositories/executor.js';
import type { SendingPoolId } from '@relayd/types';
import type { WorkspaceScope } from '../src/scope.js';

/**
 * The repository parts that do not need a database.
 *
 * `previewAudienceCount` is the only method here that interpolates a value
 * rather than parameterising it — Postgres cannot parameterise the contents
 * of an array literal in the shape this query wants — so its guard is worth
 * testing directly, and it is testable because it runs before any query.
 *
 * What the query *returns* needs Postgres and lands with the integration
 * suite: whether the two FILTER clauses count the right contacts is a
 * question only the database can answer.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const POOL = 'p1' as SendingPoolId;

function executor() {
  const execute = vi.fn(async (_query: unknown) => ({
    rows: [{ eligible: '0', suppressed: '0' }],
    rowCount: 1,
  }));

  return { execute, db: { execute } as unknown as Executor };
}

describe('the audience preview guard', () => {
  it('runs no query for an empty list', async () => {
    // A campaign with no lists is not a query returning zero — it is a query
    // that should never have been built. `ARRAY[]` with nothing in it is also
    // not valid without a cast, so this is correctness as well as thrift.
    const { db, execute } = executor();

    const result = await new CampaignRepository(db).previewAudienceCount(SCOPE, {
      listIds: [],
    });

    expect(result).toEqual({ eligible: 0, suppressed: 0 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a list id that is not a plain identifier', async () => {
    // The one interpolated value in this file. It refuses rather than
    // escapes, because refusing is checkable and escaping is a thing one gets
    // subtly wrong.
    const { db, execute } = executor();
    const repository = new CampaignRepository(db);

    for (const bad of [
      "l1'; DROP TABLE contacts; --",
      'l1 OR 1=1',
      'l1)',
      'l1,l2',
      "'",
      'a'.repeat(65),
    ]) {
      await expect(
        repository.previewAudienceCount(SCOPE, { listIds: [bad] }),
        bad,
      ).rejects.toThrow(/unexpected list id/u);
    }

    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses when only one id in the list is bad', async () => {
    // Validating the first and trusting the rest is the natural mistake.
    const { db, execute } = executor();

    await expect(
      new CampaignRepository(db).previewAudienceCount(SCOPE, {
        listIds: ['aaaaaaaa-1111-2222-3333-444444444444', "bad'"],
      }),
    ).rejects.toThrow(/unexpected list id/u);

    expect(execute).not.toHaveBeenCalled();
  });

  it('accepts a real uuid', async () => {
    const { db, execute } = executor();

    await new CampaignRepository(db).previewAudienceCount(SCOPE, {
      listIds: ['aaaaaaaa-1111-2222-3333-444444444444'],
    });

    expect(execute).toHaveBeenCalledOnce();
  });

  it('parameterises the workspace id rather than interpolating it', async () => {
    // The scope must never be part of the literal: it is the one value whose
    // compromise crosses a tenant boundary.
    const { db, execute } = executor();

    await new CampaignRepository(db).previewAudienceCount(SCOPE, {
      listIds: ['aaaaaaaa-1111-2222-3333-444444444444'],
    });

    const query = execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] } | undefined;
    const rendered = JSON.stringify(query ?? {});

    expect(rendered).not.toContain("'ws-1'");
  });
});

describe('listMembers', () => {
  it('asks for the provider connection id', async () => {
    // Without it the shared-account warning cannot be computed at all, and
    // the pool silently becomes a quota-evasion tool.
    const execute = vi.fn(async (_query: unknown) => ({ rows: [], rowCount: 0 }));
    const db = { execute } as unknown as Executor;

    await new SendingPoolRepository(db).listMembers(SCOPE, POOL);

    const query = JSON.stringify(execute.mock.calls[0]?.[0] ?? {});
    expect(query).toContain('provider_connection_id');
  });

  it('asks for the cooldown the router filters on', async () => {
    const execute = vi.fn(async (_query: unknown) => ({ rows: [], rowCount: 0 }));
    const db = { execute } as unknown as Executor;

    await new SendingPoolRepository(db).listMembers(SCOPE, POOL);

    expect(JSON.stringify(execute.mock.calls[0]?.[0] ?? {})).toContain('cooldown_until');
  });
});
