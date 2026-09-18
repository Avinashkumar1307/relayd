import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@relayd/db';
import { requireContainers, startPostgres } from '../src/containers.js';
import type { StartedPostgres } from '../src/containers.js';

/**
 * `metered` is write-once (INVARIANTS R14, review finding F14).
 *
 * The static test in packages/db asserts the migration declares the trigger.
 * This asserts the trigger actually refuses, which is the only thing that
 * matters — a declaration nobody enforces is a comment.
 *
 * The trace it prevents: a campaign has 10,000 failures from a provider
 * outage, the customer clicks retry-failed, and an implementation that resets
 * `metered` alongside `state` — which is the natural thing to write — bills
 * every successful retry a second time.
 */

const gate = await requireContainers();
const describeIntegration = gate.available ? describe : describe.skip;

if (!gate.available) {
  process.stdout.write(`\n[metered] SKIPPED: ${gate.reason}\n`);
}

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../db/migrations',
);

describeIntegration('the metered guard', () => {
  let postgres: StartedPostgres;
  let client: pg.Client;
  let recipientId: string;

  beforeAll(async () => {
    postgres = await startPostgres();
    await runMigrations({ connectionString: postgres.url, directory: migrationsDir });

    client = new pg.Client({ connectionString: postgres.url });
    await client.connect();

    // The minimum graph a recipient needs to exist at all.
    const ids = await client.query<{ id: string }>(`
      WITH w AS (
        INSERT INTO workspaces (id, name, slug)
        VALUES (gen_random_uuid(), 'Acme', 'acme') RETURNING id
      ), c AS (
        INSERT INTO contacts (id, workspace_id, email)
        SELECT gen_random_uuid(), w.id, 'a@example.com' FROM w RETURNING id, workspace_id
      ), camp AS (
        INSERT INTO campaigns (id, workspace_id, name)
        SELECT gen_random_uuid(), w.id, 'Launch' FROM w RETURNING id, workspace_id
      )
      INSERT INTO campaign_recipients
        (id, workspace_id, campaign_id, contact_id, email, message_token, state, metered)
      SELECT gen_random_uuid(), camp.workspace_id, camp.id, c.id, 'a@example.com',
             gen_random_bytes(16), 'sent', true
      FROM camp JOIN c ON c.workspace_id = camp.workspace_id
      RETURNING id
    `);

    recipientId = ids.rows[0]?.id ?? '';
    expect(recipientId).not.toBe('');
  }, 240_000);

  afterAll(async () => {
    await client?.end().catch(() => undefined);
    await postgres?.stop();
  });

  it('refuses to clear metered', async () => {
    await expect(
      client.query('UPDATE campaign_recipients SET metered = false WHERE id = $1', [recipientId]),
    ).rejects.toThrow(/write-once/u);
  });

  it('refuses even as part of a larger update', async () => {
    // The realistic shape of the bug: retry-failed resetting several columns
    // at once, with metered swept along.
    await expect(
      client.query(
        `UPDATE campaign_recipients
         SET state = 'pending', attempt_count = 0, error_code = NULL, metered = false
         WHERE id = $1`,
        [recipientId],
      ),
    ).rejects.toThrow(/write-once/u);
  });

  it('leaves the row untouched when it refuses', async () => {
    // A trigger that raised after a partial write would be worse than none.
    const { rows } = await client.query<{ state: string; metered: boolean }>(
      'SELECT state, metered FROM campaign_recipients WHERE id = $1',
      [recipientId],
    );

    expect(rows[0]).toEqual({ state: 'sent', metered: true });
  });

  it('allows the update retry-failed actually needs', async () => {
    // Resetting state and attempt_count is legitimate; metered is what must
    // not move.
    await client.query(
      `UPDATE campaign_recipients
       SET state = 'pending', attempt_count = 0, error_code = NULL
       WHERE id = $1`,
      [recipientId],
    );

    const { rows } = await client.query<{ state: string; metered: boolean }>(
      'SELECT state, metered FROM campaign_recipients WHERE id = $1',
      [recipientId],
    );

    expect(rows[0]).toEqual({ state: 'pending', metered: true });
  });

  it('allows setting metered true, which is the one write it has', async () => {
    await client.query('UPDATE campaign_recipients SET metered = true WHERE id = $1', [recipientId]);

    const { rows } = await client.query<{ metered: boolean }>(
      'SELECT metered FROM campaign_recipients WHERE id = $1',
      [recipientId],
    );

    expect(rows[0]?.metered).toBe(true);
  });

  it('allows false to stay false on a row that was never metered', async () => {
    // The guard is about clearing a true, not about the column being
    // immutable — an unsent recipient is updated many times.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO campaign_recipients
         (id, workspace_id, campaign_id, contact_id, email, message_token, state)
       SELECT gen_random_uuid(), workspace_id, campaign_id, contact_id, 'b@example.com',
              gen_random_bytes(16), 'pending'
       FROM campaign_recipients WHERE id = $1
       RETURNING id`,
      [recipientId],
    );

    const other = rows[0]?.id ?? '';
    await client.query('UPDATE campaign_recipients SET state = $2, metered = false WHERE id = $1', [
      other,
      'queued',
    ]);

    const check = await client.query<{ state: string }>(
      'SELECT state FROM campaign_recipients WHERE id = $1',
      [other],
    );

    expect(check.rows[0]?.state).toBe('queued');
  });
});

describeIntegration('the physical shape Postgres actually applied (R27)', () => {
  let postgres: StartedPostgres;
  let client: pg.Client;

  beforeAll(async () => {
    postgres = await startPostgres();
    await runMigrations({ connectionString: postgres.url, directory: migrationsDir });

    client = new pg.Client({ connectionString: postgres.url });
    await client.connect();
  }, 240_000);

  afterAll(async () => {
    await client?.end().catch(() => undefined);
    await postgres?.stop();
  });

  it('stored fillfactor and the autovacuum settings', async () => {
    const { rows } = await client.query<{ reloptions: string[] | null }>(
      "SELECT reloptions FROM pg_class WHERE relname = 'campaign_recipients'",
    );

    const options = (rows[0]?.reloptions ?? []).join(',');
    expect(options).toContain('fillfactor=80');
    expect(options).toContain('autovacuum_vacuum_scale_factor=0.02');
  });

  it('has no unqualified index on state', async () => {
    // What R27 forbids: with one, no update to a recipient can be HOT.
    const { rows } = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'campaign_recipients'",
    );

    const stateOnly = rows
      .map((row) => row.indexdef)
      .filter((def) => /\(state\)/u.test(def) && !/WHERE/u.test(def));

    expect(stateOnly).toEqual([]);
  });

  it('made the active index partial', async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'campaign_recipients' AND indexname = 'ix_cr_active'",
    );

    expect(rows[0]?.indexdef).toMatch(/WHERE .*state/u);
  });
});
