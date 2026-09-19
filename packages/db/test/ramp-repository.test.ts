import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { RampRepository } from '../src/repositories/ramp.js';
import type { Executor } from '../src/repositories/executor.js';
import type { WorkspaceScope } from '../src/scope.js';

/**
 * The ramp repository (docs/06 "Anti-abuse"; migration 0015).
 *
 * ## What is tested here and what is not
 *
 * These methods are built with Drizzle's query builder rather than a `sql`
 * template, so unlike `metering-repository.test.ts` there is no statement to
 * render without a driver. The repository's precedent for that case —
 * `pools-repository.test.ts` — is to test what runs *before* the query and
 * leave the rest to the integration suite. Same here.
 *
 * Three properties matter and only one of them is reachable without
 * Postgres:
 *
 *   The increment is an upsert that adds, not a read-modify-write. N send
 *   workers increment this concurrently, and a read-modify-write would lose
 *   increments under exactly the load the cap exists to limit — the failure
 *   would be a spammer sending more than 500 on the busiest day, which is
 *   the only day it matters.
 *
 *   The lift is guarded on `ramp_lifted_at IS NULL`, so the *first* lift is
 *   the one recorded. The nightly automatic job and an operator clicking at
 *   the same moment would otherwise overwrite each other's attribution.
 *
 *   An empty page writes no row, so "no row" and "a row saying zero" keep
 *   meaning the same thing.
 *
 * The third is a guard and is tested by running it. The first two are
 * asserted against the source, which is the repository's existing practice
 * for properties a functional test cannot see (the `SET LOCAL` grep, the
 * recipient-count grep). A `sent = 500` that should have been
 * `sent = sent + 500` passes every functional test written against a fake.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '../src/repositories/ramp.ts'), 'utf8');

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;

function executor() {
  const insert = vi.fn();
  const del = vi.fn();
  const select = vi.fn(() => ({
    from: () => ({
      leftJoin: () => ({
        leftJoin: () => ({
          where: async () => [],
        }),
      }),
    }),
  }));

  return { insert, del, select, db: { insert, delete: del, select } as unknown as Executor };
}

describe('an empty page writes nothing', () => {
  it('does not create a quota row for zero sends', async () => {
    // `readState` COALESCEs a missing row to zero. If a page that enqueued
    // nothing created a row, "no row" and "a row saying zero" would still
    // agree — but the write would be a contended upsert on the hottest row
    // in the table, executed once per empty poll, for no information.
    const { db, insert } = executor();

    await new RampRepository(db).recordSends(SCOPE, '2026-09-19', 0);

    expect(insert).not.toHaveBeenCalled();
  });

  it('does not write for a negative count either', async () => {
    // There is no legitimate negative increment, and the `CHECK (sent >= 0)`
    // in the migration would reject one — but it would reject it *after* a
    // round trip, inside whatever transaction the send path is holding.
    const { db, insert } = executor();

    await new RampRepository(db).recordSends(SCOPE, '2026-09-19', -5);

    expect(insert).not.toHaveBeenCalled();
  });

  it('still reports the current total', async () => {
    // Returning 0 unconditionally would be wrong in the one case a caller
    // uses this for: asking "how many so far" after a page that enqueued
    // nothing.
    const { db } = executor();

    await expect(new RampRepository(db).recordSends(SCOPE, '2026-09-19', 0)).resolves.toBe(0);
  });
});

describe('the increment adds rather than overwrites', () => {
  it('upserts with sent + count', () => {
    // The property, read from the source. A functional test against a fake
    // executor cannot tell `sent = count` from `sent = sent + count`,
    // because the fake is whatever it was told to return.
    expect(source).toMatch(/onConflictDoUpdate/u);
    expect(source).toMatch(/workspaceSendQuota\.sent\}\s*\+\s*\$\{count\}/u);
  });

  it('does not read the counter before writing it', () => {
    // A read-modify-write loses increments under concurrency. There is no
    // select in the write path.
    const recordSends = source.slice(
      source.indexOf('async recordSends'),
      source.indexOf('async lift'),
    );

    expect(recordSends).not.toContain('.select(');
  });
});

describe('the first lift is the one recorded', () => {
  it('guards the update on ramp_lifted_at being null', () => {
    expect(source).toMatch(/where:\s*sql`\$\{workspaceTrust\.rampLiftedAt\} is null`/u);
  });

  it('reports whether it actually lifted', () => {
    // `RETURNING` plus a length check, so a caller can tell "I lifted it"
    // from "somebody else already had". Without that the automatic job
    // would log a lift it did not perform, and the attribution column would
    // be contradicted by the log.
    const lift = source.slice(source.indexOf('async lift'), source.indexOf('async extend'));

    expect(lift).toContain('.returning(');
    expect(lift).toContain('rows.length > 0');
  });
});

describe('extending the ramp clears the lift', () => {
  it('nulls both attribution columns', () => {
    // "Keep this one capped", said about a workspace lifted last month, has
    // to actually cap it. Leaving the lift in place would make `isInRamp`
    // return true from `rampUntil` while the row still claimed the
    // workspace was trusted — and the next operator to read it would draw
    // the opposite conclusion from the same row.
    const extend = source.slice(source.indexOf('async extend'), source.indexOf('async pruneQuota'));

    expect(extend).toContain('rampLiftedAt: null');
    expect(extend).toContain('rampLiftedBy: null');
  });
});

describe('reading the state', () => {
  it('is one query, not three', () => {
    // Dispatch reads this on every page. Three separate reads could also
    // straddle UTC midnight and compare a count from one day against a cap
    // computed for another.
    const readState = source.slice(
      source.indexOf('async readState'),
      source.indexOf('async recordSends'),
    );

    expect(readState.match(/\.select\(/gu)).toHaveLength(1);
    expect(readState.match(/\.leftJoin\(/gu)).toHaveLength(2);
  });

  it('distinguishes a missing trust row from a null lift', () => {
    // A workspace with a trust row that has never been lifted and a
    // workspace with no row at all are both "in ramp" today — but the
    // second must stay in ramp after an operator sets `ramp_until`, and a
    // caller cannot tell them apart from null columns alone.
    expect(source).toContain('hasTrust');
  });
});
