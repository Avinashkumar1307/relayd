import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { EntitlementsRepository } from '../src/repositories/entitlements.js';
import type { Executor } from '../src/repositories/executor.js';
import type { WorkspaceScope } from '../src/scope.js';

/**
 * The entitlements SQL (INVARIANTS R28).
 *
 * `FOR SHARE` is the one clause the whole invariant rests on, and it is one
 * word: dropped, every test above it still passes and a downgrade committing
 * mid-launch silently changes the limit the launch was checked against.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;

/** Captures the SQL each call would send, rendered through Drizzle's dialect. */
function capturing(results: { rows: unknown[] }[] = []) {
  const statements: { text: string; params: unknown[] }[] = [];
  let call = 0;

  const execute = vi.fn(async (query: unknown) => {
    const { sql: text, params } = new PgDialect().sqlToQuery(query as SQL);
    statements.push({ text, params });
    const result = results[call] ?? { rows: [] };
    call += 1;
    return { ...result, rowCount: result.rows.length };
  });

  return { statements, db: { execute } as unknown as Executor };
}

function record(over: Record<string, unknown> = {}) {
  return {
    featureKey: 'emails.sent',
    limitValue: 10_000,
    flagValue: null,
    sourceSubscriptionId: '0192aaaa-0000-7000-8000-000000000001',
    sourcePlanCode: 'growth',
    ...over,
  };
}

describe('R28: the share lock', () => {
  it('locks the rows it reads', async () => {
    const { statements, db } = capturing();

    await new EntitlementsRepository(db).readForShare(SCOPE);

    expect(statements[0]?.text).toContain('FOR SHARE');
  });

  it('does not take an exclusive lock', async () => {
    // Two launches in the same workspace should not serialise behind each
    // other. They only need to exclude a writer.
    const { statements, db } = capturing();

    await new EntitlementsRepository(db).readForShare(SCOPE);

    expect(statements[0]?.text).not.toContain('FOR UPDATE');
  });

  it('is scoped to the workspace', async () => {
    const { statements, db } = capturing();

    await new EntitlementsRepository(db).readForShare(SCOPE);

    expect(statements[0]?.params).toContain('ws-1');
  });

  it('has an unlocked twin for reads that gate nothing', async () => {
    // A billing page rendering the plan should not block a downgrade.
    const { statements, db } = capturing();

    await new EntitlementsRepository(db).readAll(SCOPE);

    expect(statements[0]?.text).not.toContain('FOR SHARE');
    expect(statements[0]?.params).toContain('ws-1');
  });
});

describe('reading the rows', () => {
  it('keeps unlimited distinct from zero', async () => {
    // `Number(null)` is 0, which is a plan including nothing — the opposite
    // of unlimited, and the kind of mistake that reads as a billing bug.
    const { db } = capturing([
      {
        rows: [
          {
            feature_key: 'emails.sent',
            limit_value: null,
            flag_value: null,
            source_subscription_id: null,
            source_plan_code: 'growth',
          },
        ],
      },
    ]);

    const rows = await new EntitlementsRepository(db).readAll(SCOPE);

    expect(rows[0]?.limitValue).toBe(null);
  });

  it('reads bigint limits as numbers', async () => {
    const { db } = capturing([
      {
        rows: [
          {
            feature_key: 'emails.sent',
            limit_value: '50000',
            flag_value: null,
            source_subscription_id: null,
            source_plan_code: 'growth',
          },
        ],
      },
    ]);

    expect((await new EntitlementsRepository(db).readAll(SCOPE))[0]?.limitValue).toBe(50_000);
  });

  it('keeps an absent flag distinct from a false one', async () => {
    // `false` is "in the plan, switched off". `null` is "this is a limit, not
    // a flag". `Boolean(null)` collapses them.
    const { db } = capturing([
      {
        rows: [
          {
            feature_key: 'api.access',
            limit_value: null,
            flag_value: null,
            source_subscription_id: null,
            source_plan_code: 'growth',
          },
        ],
      },
    ]);

    expect((await new EntitlementsRepository(db).readAll(SCOPE))[0]?.flagValue).toBe(null);
  });

  it('orders both reads the same way', async () => {
    // Not load-bearing for correctness — the projection sorts itself and the
    // comparison is order-insensitive — but the two reads returning rows in
    // different orders makes a diff between them unreadable, and the billing
    // page renders whatever order it is handed.
    const { statements, db } = capturing();
    const repo = new EntitlementsRepository(db);

    await repo.readAll(SCOPE);
    await repo.readForShare(SCOPE);

    expect(statements[0]?.text).toContain('ORDER BY feature_key');
    expect(statements[1]?.text).toContain('ORDER BY feature_key');
  });
});

describe('rebuilding', () => {
  it('deletes before it inserts', async () => {
    // A feature dropped from a plan has to disappear. An upsert leaves it
    // behind, entitling the workspace to something it no longer pays for.
    const { statements, db } = capturing();

    await new EntitlementsRepository(db).rebuild(SCOPE, [record()]);

    expect(statements[0]?.text).toContain('DELETE FROM entitlements');
    expect(statements[1]?.text).toContain('INSERT INTO entitlements');
  });

  it('scopes the delete', async () => {
    // Unscoped, this empties the table for every tenant.
    const { statements, db } = capturing();

    await new EntitlementsRepository(db).rebuild(SCOPE, [record()]);

    expect(statements[0]?.text).toContain('workspace_id =');
    expect(statements[0]?.params).toEqual(['ws-1']);
  });

  it('leaves no rows for a workspace with no subscription', async () => {
    // No rows, not zeroed rows: "not entitled to send" and "entitled to send
    // zero" would otherwise be indistinguishable, and only the first is fixed
    // by subscribing.
    const { statements, db } = capturing();

    await new EntitlementsRepository(db).rebuild(SCOPE, []);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toContain('DELETE');
  });

  it('still deletes when there is nothing to insert', async () => {
    // The case that matters: a cancelled subscription. Skipping the delete
    // would leave the old plan in force forever.
    const { statements, db } = capturing();

    await new EntitlementsRepository(db).rebuild(SCOPE, []);

    expect(statements).toHaveLength(1);
  });

  it('inserts every row in one statement', async () => {
    const { statements, db } = capturing();

    await new EntitlementsRepository(db).rebuild(SCOPE, [
      record(),
      record({ featureKey: 'contacts.stored', limitValue: 5_000 }),
      record({ featureKey: 'api.access', limitValue: null, flagValue: true }),
    ]);

    expect(statements).toHaveLength(2);
    expect(statements[1]?.params).toContain('contacts.stored');
    expect(statements[1]?.params).toContain('api.access');
  });

  it('binds a null limit as null', async () => {
    const { statements, db } = capturing();

    await new EntitlementsRepository(db).rebuild(SCOPE, [record({ limitValue: null })]);

    expect(statements[1]?.params).toContain(null);
  });
});

describe('the billing state', () => {
  function stateRows(over: Record<string, unknown> = {}) {
    return [
      {
        rows: [
          {
            workspace_status: 'active',
            subscription_id: 'sub-1',
            plan_code: 'growth',
            subscription_status: 'active',
            current_period_start: new Date('2026-09-01T00:00:00.000Z'),
            current_period_end: new Date('2026-10-01T00:00:00.000Z'),
            ...over,
          },
        ],
      },
    ];
  }

  it('reads it in one query', async () => {
    // Three round trips per gated action is a gate somebody caches wrongly.
    const { statements, db } = capturing(stateRows());

    await new EntitlementsRepository(db).readBillingState(SCOPE);

    expect(statements).toHaveLength(1);
  });

  it('reports an active subscription', async () => {
    const { db } = capturing(stateRows());

    const state = await new EntitlementsRepository(db).readBillingState(SCOPE);

    expect(state).toMatchObject({
      hasSubscription: true,
      pastDue: false,
      subscriptionSuspended: false,
      workspaceSuspended: false,
      planCode: 'growth',
    });
  });

  it('reports past due', async () => {
    const { db } = capturing(stateRows({ subscription_status: 'past_due' }));

    const state = await new EntitlementsRepository(db).readBillingState(SCOPE);

    expect(state.pastDue).toBe(true);
    expect(state.hasSubscription).toBe(true);
  });

  it('treats unpaid as suspended, not as a subscription', async () => {
    // `unpaid` is a row that exists and grants nothing. Counted as a
    // subscription, the gate answers `subscription_suspended`, which is the
    // more accurate of the two denials.
    const { db } = capturing(stateRows({ subscription_status: 'unpaid' }));

    const state = await new EntitlementsRepository(db).readBillingState(SCOPE);

    expect(state.subscriptionSuspended).toBe(true);
    expect(state.hasSubscription).toBe(false);
  });

  it('reports no subscription when the join finds none', async () => {
    const { db } = capturing(
      stateRows({
        subscription_id: null,
        plan_code: null,
        subscription_status: null,
        current_period_start: null,
        current_period_end: null,
      }),
    );

    const state = await new EntitlementsRepository(db).readBillingState(SCOPE);

    expect(state.hasSubscription).toBe(false);
    expect(state.workspaceSuspended).toBe(false);
  });

  it('reports a suspended workspace', async () => {
    const { db } = capturing(stateRows({ workspace_status: 'suspended' }));

    expect((await new EntitlementsRepository(db).readBillingState(SCOPE)).workspaceSuspended).toBe(
      true,
    );
  });

  it('closes everything for a workspace that does not exist', async () => {
    // The safe direction for a row that should be there and is not.
    const { db } = capturing([{ rows: [] }]);

    const state = await new EntitlementsRepository(db).readBillingState(SCOPE);

    expect(state.workspaceSuspended).toBe(true);
    expect(state.hasSubscription).toBe(false);
  });

  it('joins only live subscriptions', async () => {
    // Without the status filter a workspace that cancelled and resubscribed
    // joins two rows, and which one wins is whatever the planner chose.
    const { statements, db } = capturing(stateRows());

    await new EntitlementsRepository(db).readBillingState(SCOPE);

    expect(statements[0]?.text).toContain("s.status IN ('trialing', 'active', 'past_due', 'unpaid')");
  });
});

describe('reading the subscription a rebuild projects from', () => {
  it('includes unpaid', async () => {
    // So a rebuild sees it and produces no rows, rather than seeing nothing
    // and leaving the old rows in place.
    const { statements, db } = capturing();

    await new EntitlementsRepository(db).activeSubscription(SCOPE);

    expect(statements[0]?.text).toContain('unpaid');
  });

  it('returns null when there is none', async () => {
    const { db } = capturing([{ rows: [] }]);

    expect(await new EntitlementsRepository(db).activeSubscription(SCOPE)).toBe(null);
  });

  it('is scoped', async () => {
    const { statements, db } = capturing();

    await new EntitlementsRepository(db).activeSubscription(SCOPE);

    expect(statements[0]?.params).toContain('ws-1');
  });
});
