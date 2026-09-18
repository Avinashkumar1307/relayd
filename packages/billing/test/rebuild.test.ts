import { describe, expect, it } from 'vitest';
import {
  rebuildEntitlements,
  rebuildMany,
  type RebuildPort,
} from '../src/entitlements/rebuild.js';
import { projectEntitlements, type ActiveSubscription, type EntitlementRow } from '../src/entitlements/project.js';

/**
 * Rebuilding the projection.
 *
 * The Phase 8 gate is "entitlements dropped and rebuilt with byte-identical
 * output". The determinism lives in `projectEntitlements`; what is tested
 * here is the ordering around it, and one property that reads as an
 * optimisation and is not: an unchanged workspace is not rewritten, because a
 * `computed_at` that moves every night cannot answer when a workspace's
 * entitlements last actually changed.
 */

const SUBSCRIPTION: ActiveSubscription = {
  id: 'sub-1',
  workspaceId: 'ws-1',
  planCode: 'growth',
  status: 'active',
};

function harness(
  over: {
    subscription?: ActiveSubscription | null;
    current?: EntitlementRow[];
    port?: Partial<RebuildPort>;
  } = {},
) {
  const calls: string[] = [];
  const written: EntitlementRow[][] = [];

  const port: RebuildPort = {
    async activeSubscription() {
      calls.push('read-subscription');
      return over.subscription === undefined ? SUBSCRIPTION : over.subscription;
    },
    async readEntitlements() {
      calls.push('read-entitlements');
      return over.current ?? [];
    },
    async writeEntitlements(_workspaceId, rows) {
      calls.push('write');
      written.push([...rows]);
    },
    async invalidate() {
      calls.push('invalidate');
    },
    ...over.port,
  };

  return { port, calls, written };
}

describe('rebuilding one workspace', () => {
  it('writes the projection', async () => {
    const { port, written } = harness();

    const result = await rebuildEntitlements('ws-1', port);

    expect(result.changed).toBe(true);
    expect(written[0]).toEqual(projectEntitlements(SUBSCRIPTION));
  });

  it('writes nothing when the rows already match', async () => {
    // Not an optimisation: `computed_at` is what an operator reads when a
    // customer says they lost a feature, and a column rewritten nightly
    // answers nothing.
    const { port, calls } = harness({ current: projectEntitlements(SUBSCRIPTION) });

    const result = await rebuildEntitlements('ws-1', port);

    expect(result.changed).toBe(false);
    expect(calls).not.toContain('write');
  });

  it('does not invalidate a cache it did not change', async () => {
    const { port, calls } = harness({ current: projectEntitlements(SUBSCRIPTION) });

    await rebuildEntitlements('ws-1', port);

    expect(calls).not.toContain('invalidate');
  });

  it('invalidates after the write, never before', async () => {
    // Before, any read arriving in the gap repopulates the cache from the old
    // rows — which looks exactly like the write never happening.
    const { port, calls } = harness();

    await rebuildEntitlements('ws-1', port);

    expect(calls.indexOf('write')).toBeLessThan(calls.indexOf('invalidate'));
  });

  it('reads the subscription before the rows', async () => {
    const { port, calls } = harness();

    await rebuildEntitlements('ws-1', port);

    expect(calls.indexOf('read-subscription')).toBeLessThan(calls.indexOf('read-entitlements'));
  });
});

describe('a workspace with nothing to be entitled to', () => {
  it('is left with no rows', async () => {
    // No rows, not zeroed rows. "Not entitled to send" and "entitled to send
    // zero" would otherwise be indistinguishable.
    const { port, written } = harness({ subscription: null, current: projectEntitlements(SUBSCRIPTION) });

    const result = await rebuildEntitlements('ws-1', port);

    expect(result.revoked).toBe(true);
    expect(written[0]).toEqual([]);
  });

  it('still writes, so a cancelled plan stops applying', async () => {
    // The failure this catches: skipping the write because there is nothing
    // to insert leaves the old plan in force forever.
    const { port, calls } = harness({
      subscription: null,
      current: projectEntitlements(SUBSCRIPTION),
    });

    await rebuildEntitlements('ws-1', port);

    expect(calls).toContain('write');
  });

  it('is unchanged when it already had none', async () => {
    const { port, calls } = harness({ subscription: null, current: [] });

    const result = await rebuildEntitlements('ws-1', port);

    expect(result.changed).toBe(false);
    expect(result.revoked).toBe(true);
    expect(calls).not.toContain('write');
  });

  it('revokes for a subscription that grants nothing', async () => {
    // `unpaid`. The row exists; it entitles the workspace to nothing.
    const { port, written } = harness({
      subscription: { ...SUBSCRIPTION, status: 'unpaid' },
      current: projectEntitlements(SUBSCRIPTION),
    });

    await rebuildEntitlements('ws-1', port);

    expect(written[0]).toEqual([]);
  });
});

describe('rebuilding a batch', () => {
  it('counts what it did', async () => {
    const { port } = harness();

    const result = await rebuildMany(['ws-1', 'ws-2', 'ws-3'], port);

    expect(result).toMatchObject({ checked: 3, changed: 3, revoked: 0 });
  });

  it('does not stop at the first failure', async () => {
    // One workspace whose plan was deleted from the catalogue must not
    // prevent the other four thousand from being corrected.
    let seen = 0;
    const { port } = harness({
      port: {
        async activeSubscription() {
          seen += 1;
          if (seen === 2) throw new Error('plan missing');
          return SUBSCRIPTION;
        },
      },
    });

    const result = await rebuildMany(['ws-1', 'ws-2', 'ws-3'], port);

    expect(result.checked).toBe(2);
    expect(result.failed).toEqual([{ workspaceId: 'ws-2', error: 'plan missing' }]);
  });

  it('names the failures rather than letting the count run short', async () => {
    const { port } = harness({
      port: {
        async activeSubscription() {
          throw new Error('boom');
        },
      },
    });

    const result = await rebuildMany(['ws-1'], port);

    expect(result.failed[0]?.workspaceId).toBe('ws-1');
    expect(result.checked).toBe(0);
  });

  it('counts an unchanged workspace as checked', async () => {
    const { port } = harness({ current: projectEntitlements(SUBSCRIPTION) });

    const result = await rebuildMany(['ws-1', 'ws-2'], port);

    expect(result).toMatchObject({ checked: 2, changed: 0 });
  });

  it('handles an empty batch', async () => {
    const { port } = harness();

    expect(await rebuildMany([], port)).toEqual({
      checked: 0,
      changed: 0,
      revoked: 0,
      failed: [],
    });
  });
});

describe('the gate property', () => {
  it('produces identical rows on a second rebuild', async () => {
    // "Dropped and rebuilt with byte-identical output", which is the Phase 8
    // gate and the only reason a bug in the webhook path is recoverable.
    let stored: EntitlementRow[] = [];

    const port: RebuildPort = {
      async activeSubscription() {
        return SUBSCRIPTION;
      },
      async readEntitlements() {
        return stored;
      },
      async writeEntitlements(_workspaceId, rows) {
        stored = [...rows];
      },
      async invalidate() {
        /* no cache in this harness */
      },
    };

    await rebuildEntitlements('ws-1', port);
    const first = JSON.stringify(stored);

    stored = [];
    await rebuildEntitlements('ws-1', port);

    expect(JSON.stringify(stored)).toBe(first);
  });
});
