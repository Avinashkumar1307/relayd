import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsRepository } from '../src/repositories/analytics.js';
import { BillingCustomerRepository } from '../src/repositories/billing.js';
import { OutboundWebhookRepository } from '../src/repositories/outbound-webhooks.js';
import { SendingPoolRepository } from '../src/repositories/pools.js';
import type { Executor } from '../src/repositories/executor.js';
import type { CampaignId } from '@relayd/types';
import type { WorkspaceScope } from '../src/scope.js';

/**
 * The reads and writes behind the dashboard, the pool drawer, the billing
 * details form and the webhook replay — without a database.
 *
 * Three things are checkable here and nowhere else in the unit suite.
 *
 * **Every statement filters on the workspace.** RLS is the layer that
 * actually holds, but it is the last one; the scope predicate is the one a
 * reader can see, and a query without it is a query relying entirely on a
 * `SET LOCAL` somebody else remembered to do.
 *
 * **The dashboard reads rollups, not events and not recipients.** CLAUDE.md
 * section 12 turns on this, and the only mechanical way to check it without
 * Postgres is to look at which table names appear in the SQL.
 *
 * **A replay cannot re-send a delivered event.** The guard is the `status IN
 * ('failed','abandoned')` predicate, so asserting it is in the statement is
 * asserting the property.
 *
 * Actually running any of this is the Testcontainers suite, which cannot run
 * on a machine without Docker.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const CAMPAIGN = 'cmp-1' as CampaignId;

/**
 * Captures what would be sent, without sending it.
 *
 * `inspect` rather than `JSON.stringify`: a Drizzle condition holds a
 * reference to its column, which holds a reference back to its table, and
 * stringify throws on the cycle.
 */
function capturing(rows: Record<string, unknown>[] = []) {
  const executed: string[] = [];
  /** Every write's payload, by the builder method that received it. */
  const writes: { method: string; keys: string[]; value: Record<string, unknown> }[] = [];

  const record = (value: unknown): void => {
    executed.push(inspect(value, { depth: 12, breakLength: Infinity }));
  };

  /**
   * A write's own keys, not the table it names.
   *
   * `inspect` on an `onConflictDoUpdate` argument renders the whole Drizzle
   * table — every column, every index — so asserting "the statement does not
   * mention company" against it is asserting nothing. The payload's own keys
   * are the only readable evidence of what would actually be written.
   */
  const capture = (method: string, value: unknown) => {
    if (typeof value === 'object' && value !== null) {
      const own = value as Record<string, unknown>;
      const set = own['set'];
      const payload = (typeof set === 'object' && set !== null ? set : own) as Record<
        string,
        unknown
      >;

      writes.push({ method, keys: Object.keys(payload), value: payload });
    }
  };

  const execute = vi.fn(async (query: unknown) => {
    record(query);
    return { rows, rowCount: rows.length };
  });

  const builder: Record<string, unknown> = {
    select: () => builder,
    insert: () => builder,
    update: () => builder,
    delete: () => builder,
    from: () => builder,
    values: (value: unknown) => {
      capture('values', value);
      return builder;
    },
    set: (value: unknown) => {
      capture('set', value);
      return builder;
    },
    onConflictDoUpdate: (value: unknown) => {
      capture('onConflictDoUpdate', value);
      return builder;
    },
    where: (condition: unknown) => {
      record(condition);
      return builder;
    },
    orderBy: () => builder,
    limit: async () => rows,
    returning: async () => rows,
    execute,
  };

  return { executed, writes, db: builder as unknown as Executor };
}

const sql = (executed: readonly string[]): string => executed.join(' ');

describe('the dashboard reads rollups only', () => {
  it('reads campaign rows from the counters and the stats rollup, never with COUNT(*)', async () => {
    const { db, executed } = capturing();

    await new AnalyticsRepository(db).dashboardCampaigns(SCOPE, { limit: 8 });

    const statement = sql(executed);
    expect(statement).toContain('campaign_counters');
    expect(statement).toContain('campaign_stats');
    // The whole point of F13. A COUNT over recipients here is the thing
    // CLAUDE.md section 12 forbids by name.
    expect(statement).not.toContain('count(');
    expect(statement).not.toContain('email_events');
    expect(statement).toContain('ws-1');
  });

  it('sums uncertain sends from the counters, not from the recipient rows', async () => {
    const { db, executed } = capturing([{ uncertain: 412 }]);

    const total = await new AnalyticsRepository(db).uncertainSince(
      SCOPE,
      new Date('2026-09-01T00:00:00.000Z'),
    );

    expect(total).toBe(412);
    expect(sql(executed)).toContain('campaign_counters');
    expect(sql(executed)).not.toContain('campaign_recipients');
  });

  it('splits soft from hard bounces out of provider_stats', async () => {
    // campaign_daily_stats carries one combined `bounced` column, so the
    // two-tone meter has to come from somewhere else. This is the somewhere.
    const { db, executed } = capturing([
      { sent: 100, delivered: 96, bouncedSoft: 3, bouncedHard: 1, complained: 0 },
    ]);

    const split = await new AnalyticsRepository(db).bounceSplit(SCOPE, {
      from: '2026-09-01',
      to: '2026-09-19',
    });

    expect(split.bouncedSoft).toBe(3);
    expect(split.bouncedHard).toBe(1);
    expect(sql(executed)).toContain('provider_stats');
    expect(sql(executed)).toContain('ws-1');
  });

  it('returns zeroes rather than undefined when a workspace has sent nothing', async () => {
    // A workspace with no provider_stats rows gets one row of nulls from the
    // aggregate, or no row at all depending on the plan. Either way the
    // caller divides by `sent`, and an undefined there is a NaN on screen.
    const { db } = capturing([]);

    const split = await new AnalyticsRepository(db).bounceSplit(SCOPE, {
      from: '2026-09-01',
      to: '2026-09-19',
    });

    expect(split).toEqual({
      sent: 0,
      delivered: 0,
      bouncedSoft: 0,
      bouncedHard: 0,
      complained: 0,
    });
  });
});

describe('the campaign provider breakdown', () => {
  it('groups the campaign’s recipients by the connection that carried them', async () => {
    const { db, executed } = capturing();

    await new AnalyticsRepository(db).campaignProviderTotals(SCOPE, CAMPAIGN);

    const statement = sql(executed);
    expect(statement).toContain('campaign_recipients');
    expect(statement).toContain('GROUP BY provider_connection_id');
    // Both halves of the identity. Without the campaign predicate this is
    // every campaign in the workspace; without the workspace predicate it
    // relies on RLS alone.
    expect(statement).toContain('ws-1');
    expect(statement).toContain('cmp-1');
  });

  it('counts delivery_uncertain separately from failed', async () => {
    // D3: an uncertain recipient is terminal and unbilled, and merging it
    // into failures would make the report claim sends that never happened
    // and hide ones that may have.
    const { db, executed } = capturing();

    await new AnalyticsRepository(db).campaignProviderTotals(SCOPE, CAMPAIGN);

    expect(sql(executed)).toContain("state = 'delivery_uncertain'");
    expect(sql(executed)).toContain("state = 'failed'");
  });
});

describe('the pool drawer’s sender list', () => {
  it('joins the connection and its quota, scoped to the workspace', async () => {
    const { db, executed } = capturing();

    await new SendingPoolRepository(db).listEligibleSenders(SCOPE, { day: '2026-09-19' });

    const statement = sql(executed);
    expect(statement).toContain('provider_connections');
    expect(statement).toContain('sender_identities');
    expect(statement).toContain('provider_stats');
    expect(statement).toContain('ws-1');
  });

  it('reads today’s sends per connection, not per sender', async () => {
    // Two senders on one SES account share one bucket. Joining
    // sender_daily_usage instead would count that bucket twice and tell the
    // customer their capacity doubled, which is the exact claim docs/07
    // spends a page refusing.
    const { db, executed } = capturing();

    await new SendingPoolRepository(db).listEligibleSenders(SCOPE, { day: '2026-09-19' });

    expect(sql(executed)).toContain('ps.provider_connection_id = pc.id');
    expect(sql(executed)).not.toContain('sender_daily_usage');
  });

  it('reads the member list through sender_accounts.provider_id', async () => {
    // The column is provider_id (0006). It was written here as
    // provider_connection_id — the name it has on campaign_recipients — and
    // no fake executor resolves a column, so nothing caught it.
    const { db, executed } = capturing();

    await new SendingPoolRepository(db).listMembers(SCOPE, 'pool-1' as never);

    expect(sql(executed)).toContain('sa.provider_id');
    expect(sql(executed)).not.toContain('sa.provider_connection_id');
  });
});

describe('a webhook replay cannot double-deliver', () => {
  it('only moves rows that failed, and never one that was delivered', async () => {
    const { db, executed } = capturing([{ id: '1' }, { id: '2' }]);

    const moved = await new OutboundWebhookRepository(db).replayFailed(SCOPE, {
      endpointId: 'wh-1',
      since: new Date('2026-09-12T00:00:00.000Z'),
      now: new Date('2026-09-19T00:00:00.000Z'),
      limit: 5_000,
    });

    expect(moved).toBe(2);

    const statement = sql(executed);
    // The guard. A `delivered` row is not matched, so nothing that arrived
    // can be sent again; a `pending` row is not matched either, so nothing
    // in flight is queued twice.
    expect(statement).toContain("status IN ('failed', 'abandoned')");
    expect(statement).toContain('ws-1');
    expect(statement).toContain('wh-1');
  });

  it('bounds the scan by created_at so it does not visit every partition', async () => {
    const { db, executed } = capturing([]);

    await new OutboundWebhookRepository(db).replayFailed(SCOPE, {
      endpointId: 'wh-1',
      since: new Date('2026-09-12T00:00:00.000Z'),
      now: new Date('2026-09-19T00:00:00.000Z'),
      limit: 10,
    });

    expect(sql(executed)).toContain('created_at >=');
  });

  it('does not reset the attempt counter', async () => {
    // The delivery worker's backoff reads `attempt`. Zeroing it would hand
    // an endpoint that has already failed nine times a fresh set of nine
    // retries every time somebody pressed the button.
    const { db, executed } = capturing([]);

    await new OutboundWebhookRepository(db).replayFailed(SCOPE, {
      endpointId: 'wh-1',
      since: new Date('2026-09-12T00:00:00.000Z'),
      now: new Date('2026-09-19T00:00:00.000Z'),
      limit: 10,
    });

    expect(sql(executed)).not.toContain('attempt = 0');
  });
});

describe('billing details', () => {
  it('reads the billing customer scoped to the workspace and the provider', async () => {
    const { db, executed } = capturing([]);

    await new BillingCustomerRepository(db).find(SCOPE);

    const statement = sql(executed);
    expect(statement).toContain('workspace_id');
    expect(statement).toContain('ws-1');
    // Half of uq_bc_workspace. Without it a second provider's row could be
    // returned as this workspace's billing identity.
    expect(statement).toContain('stripe');
  });

  it('upserts on the workspace, so two tabs saving at once do not collide', async () => {
    const { db, writes } = capturing([
      {
        id: 'bc-1',
        workspaceId: 'ws-1',
        provider: 'stripe',
        providerCustomerId: null,
        status: 'pending',
        email: 'owner@example.com',
        company: 'Northwind',
        address: 'Dubai',
        taxId: 'AE1234',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const row = await new BillingCustomerRepository(db).upsertDetails(SCOPE, {
      id: 'bc-1',
      email: 'owner@example.com',
      company: 'Northwind',
      address: 'Dubai',
      taxId: 'AE1234',
    });

    expect(row.taxId).toBe('AE1234');
    // The conflict target is uq_bc_workspace, so a second tab saving the
    // same form updates the row rather than hitting a unique violation.
    expect(writes.map((write) => write.method)).toContain('onConflictDoUpdate');
  });

  it('leaves a field alone when the patch does not mention it', async () => {
    // "Not supplied" and "cleared to empty" are different requests, and only
    // the first is a partial update. A spread that always wrote every key
    // would blank the company every time somebody changed their VAT id.
    const { db, writes } = capturing([
      {
        id: 'bc-1',
        workspaceId: 'ws-1',
        provider: 'stripe',
        providerCustomerId: null,
        status: 'pending',
        email: null,
        company: null,
        address: null,
        taxId: 'AE1234',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await new BillingCustomerRepository(db).upsertDetails(SCOPE, { id: 'bc-1', taxId: 'AE1234' });

    const update = writes.find((write) => write.method === 'onConflictDoUpdate');

    expect(update?.value['taxId']).toBe('AE1234');
    expect(update?.keys).not.toContain('company');
    expect(update?.keys).not.toContain('address');
    expect(update?.keys).not.toContain('email');
  });
});
