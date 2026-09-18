import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readMigrations } from '../src/migrate.js';
import { DELIVERY_RANK } from '../src/schema/campaigns.js';

/**
 * Physical shape of the campaign tables (INVARIANTS R14, R27).
 *
 * These read the committed SQL rather than a live catalogue. The behaviour of
 * the trigger and the effect of the storage parameters need a database and are
 * asserted in the Testcontainers suite; what is checked here is that the
 * migration still *declares* them, which is what stops a later edit quietly
 * dropping one.
 */

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

async function migrationSql(): Promise<string> {
  const files = await readMigrations(directory);
  return files.map((file) => file.sql).join('\n');
}

describe('metered is write-once (R14)', () => {
  it('declares the guard function', async () => {
    const sql = await migrationSql();

    expect(sql).toContain('FUNCTION guard_metered()');
    // The condition that matters: true going to false, not any change.
    expect(sql).toMatch(/OLD\.metered\s*=\s*true\s+AND\s+NEW\.metered\s*=\s*false/iu);
  });

  it('attaches it to campaign_recipients before every update', async () => {
    const sql = await migrationSql();

    expect(sql).toMatch(/CREATE TRIGGER trg_guard_metered\s+BEFORE UPDATE ON campaign_recipients/u);
    expect(sql).toContain('FOR EACH ROW EXECUTE FUNCTION guard_metered()');
  });

  it('raises rather than silently ignoring the write', async () => {
    // Returning OLD would make the update a no-op, which hides the bug
    // instead of surfacing it.
    const sql = await migrationSql();
    expect(sql).toMatch(/metered is write-once/u);
    expect(sql).toContain('RAISE EXCEPTION');
  });
});

describe('campaign_recipients physical shape (R27)', () => {
  it('sets fillfactor to 80', async () => {
    // Leaves room for HOT updates on the same page. Each row is updated three
    // or four times in its life.
    const sql = await migrationSql();
    expect(sql).toMatch(/ALTER TABLE campaign_recipients SET \([\s\S]*?fillfactor = 80/u);
  });

  it('tunes autovacuum aggressively', async () => {
    const sql = await migrationSql();

    expect(sql).toMatch(/autovacuum_vacuum_scale_factor = 0\.02/u);
    expect(sql).toMatch(/autovacuum_analyze_scale_factor = 0\.01/u);
  });

  it('indexes state only partially, on the active states', async () => {
    // Terminal rows carry no entry, so their updates become HOT (F27).
    const sql = await migrationSql();

    expect(sql).toMatch(
      /CREATE INDEX ix_cr_active[\s\S]*?WHERE state IN \('pending','queued','sending'\)/u,
    );
  });

  it('has no index on state alone', async () => {
    // The thing R27 forbids: an unqualified state index means no update can
    // be HOT and the table bloats fast.
    const sql = await migrationSql();

    const stateIndexes = [...sql.matchAll(/CREATE INDEX (\w+) ON campaign_recipients \(([^)]*)\)(?!\s*WHERE)/gu)];
    for (const match of stateIndexes) {
      expect(match[2], match[1]).not.toMatch(/^\s*state\s*$/u);
    }
  });

  it('indexes stale attempts, which is what the sweeper reads', async () => {
    const sql = await migrationSql();
    expect(sql).toMatch(/ix_cr_stale_attempt[\s\S]*?WHERE state = 'sending'/u);
  });

  it('keeps one recipient per contact per campaign', async () => {
    // The durable guard against a snapshot running twice.
    const sql = await migrationSql();
    expect(sql).toContain('uq_cr_campaign_contact ON campaign_recipients (campaign_id, contact_id)');
  });
});

describe('the delivery lattice (F16)', () => {
  it('ranks states so a bounce cannot be overwritten by a later delivery', () => {
    // SNS gives no ordering guarantee, so a `delivered` arriving after a
    // `bounced` is routine. Overwriting would leave the contact unsuppressed,
    // which is a correctness failure and a compliance one.
    expect(DELIVERY_RANK.delivered).toBeLessThan(DELIVERY_RANK.hard_bounced);
    expect(DELIVERY_RANK.delivered).toBeLessThan(DELIVERY_RANK.complained);
    expect(DELIVERY_RANK.sent).toBeLessThan(DELIVERY_RANK.delivered);
  });

  it('puts a soft bounce below a hard one, so it can still be superseded', () => {
    expect(DELIVERY_RANK.soft_bounced).toBeLessThan(DELIVERY_RANK.hard_bounced);
  });

  it('is strictly ordered, with no two states sharing a rank', () => {
    const ranks = Object.values(DELIVERY_RANK);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('starts at queued', () => {
    expect(DELIVERY_RANK.queued).toBe(0);
  });

  it('is pinned exactly, because packages/campaigns carries its own copy', () => {
    // `packages/campaigns` has no dependency on this package — the engine is
    // expressed against ports — so its `events.ts` repeats this table. The
    // two cannot be made to share one definition without an edge that does
    // not otherwise exist, so instead both are pinned to the same literal and
    // a change to either fails here or there.
    expect(DELIVERY_RANK).toEqual({
      queued: 0,
      sent: 1,
      delivered: 2,
      soft_bounced: 3,
      hard_bounced: 4,
      complained: 5,
    });
  });

  it('has no rank for an engagement event', () => {
    // Opens and clicks are additive and never participate in the lattice.
    expect(Object.keys(DELIVERY_RANK)).not.toContain('open');
    expect(Object.keys(DELIVERY_RANK)).not.toContain('click');
  });
});

describe('partitioned tables', () => {
  it('partitions email_events by range from the start', async () => {
    // Retro-fitting partitioning to a table with hundreds of millions of rows
    // is the one migration nobody wants to run (F25).
    const sql = await migrationSql();

    expect(sql).toMatch(/CREATE TABLE email_events[\s\S]*?PARTITION BY RANGE \(occurred_at\)/u);
    expect(sql).toContain('PARTITION OF email_events');
  });

  it('partitions usage_records too', async () => {
    const sql = await migrationSql();
    expect(sql).toMatch(/CREATE TABLE usage_records[\s\S]*?PARTITION BY RANGE \(occurred_at\)/u);
  });

  it('puts RLS on the partitioned parents', async () => {
    // Postgres applies a parent's policies to every partition, so a partition
    // the scheduler creates later is covered without anybody remembering.
    const sql = await migrationSql();

    expect(sql).toContain('ALTER TABLE email_events ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY');
  });

  it('gives usage_records a unique idempotency key per partition (R15)', async () => {
    // send:{campaignRecipientId}, so a retried recipient can never be billed
    // twice.
    const sql = await migrationSql();

    expect(sql).toMatch(
      /CREATE UNIQUE INDEX uq_ur_idem_\d+_\d+ ON usage_records_\d+_\d+\s*\(workspace_id, feature_key, idempotency_key\)/u,
    );
  });

  it('creates more than one partition, so a month boundary is not a cliff', async () => {
    const sql = await migrationSql();
    expect([...sql.matchAll(/PARTITION OF email_events/gu)].length).toBeGreaterThanOrEqual(2);
  });
});

describe('what the campaign state set allows', () => {
  it('includes every state BUILD-PLAN Phase 6 names', async () => {
    const sql = await migrationSql();

    for (const state of [
      'draft',
      'scheduled',
      'validating',
      'queueing',
      'sending',
      'pausing',
      'paused',
      'cancelling',
      'cancelled',
      'completed',
      'completed_with_errors',
      'held',
      'failed',
    ]) {
      expect(sql, state).toContain(`'${state}'`);
    }
  });

  it('gives recipients a delivery_uncertain state', async () => {
    // D3: the provider may have accepted it, so it is terminal and unmetered
    // rather than resent.
    const sql = await migrationSql();
    expect(sql).toMatch(/CHECK \(state IN \([^)]*'delivery_uncertain'/u);
  });
});
