import { describe, expect, it } from 'vitest';
import {
  RECONCILE_WINDOW_HOURS,
  compareSubscription,
  isAutoCorrectable,
  reconcileBilling,
  reconcileSince,
  revokesEntitlements,
  type LocalSubscription,
  type ReconcilePort,
} from '../src/reconcile/reconcile.js';
import { PLANS } from '../src/plans/catalogue.js';
import type { BillingProviderAdapter, ProviderSubscription } from '../src/port.js';

/**
 * Nightly reconciliation (INVARIANTS R19, review finding F19).
 *
 * The webhook path is convergent and still not sufficient: Stripe gives up
 * retrying after about three days, so an endpoint disabled over a weekend
 * loses events permanently. Every one of those is a subscription whose local
 * status is wrong in a way nothing else will ever notice.
 */

const NOW = new Date('2026-09-19T03:00:00.000Z');
const PERIOD_START = new Date('2026-09-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-10-01T00:00:00.000Z');

function local(over: Partial<LocalSubscription> = {}): LocalSubscription {
  return {
    id: 'sub-row',
    workspaceId: 'ws-1',
    providerSubscriptionId: 'sub_stripe',
    planCode: PLANS.growth,
    status: 'active',
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    providerStateVersion: 5,
    ...over,
  };
}

function remote(over: Partial<ProviderSubscription> = {}): ProviderSubscription {
  return {
    id: 'sub_stripe',
    customerId: 'cus_1',
    status: 'active',
    priceIds: ['price_growth'],
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    trialEnd: null,
    stateVersion: 9,
    items: [],
    ...over,
  };
}

const PLAN_FOR_PRICE = (priceId: string): string | null =>
  priceId === 'price_growth' ? PLANS.growth : priceId === 'price_business' ? PLANS.business : null;

describe('the window', () => {
  it('reaches back forty-eight hours', () => {
    // Not twenty-four: a job that fails once must not open a gap, and
    // "modified recently" is the provider's clock rather than ours.
    expect(RECONCILE_WINDOW_HOURS).toBe(48);
    expect(reconcileSince(NOW).getTime()).toBe(NOW.getTime() - 48 * 3_600_000);
  });

  it('falls back to the default for a nonsense window', () => {
    for (const bad of [0, -1, Number.NaN]) {
      expect(reconcileSince(NOW, bad).getTime()).toBe(NOW.getTime() - 48 * 3_600_000);
    }
  });
});

describe('comparing one subscription', () => {
  it('finds nothing when they agree', () => {
    expect(compareSubscription(local(), remote(), PLAN_FOR_PRICE)).toEqual([]);
  });

  it('finds a status drift', () => {
    const found = compareSubscription(local(), remote({ status: 'past_due' }), PLAN_FOR_PRICE);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'status', local: 'active', remote: 'past_due' });
  });

  it('finds a plan drift through the price', () => {
    const found = compareSubscription(
      local(),
      remote({ priceIds: ['price_business'] }),
      PLAN_FOR_PRICE,
    );

    expect(found[0]).toMatchObject({ kind: 'plan', local: PLANS.growth, remote: PLANS.business });
  });

  it('finds a period drift', () => {
    const found = compareSubscription(
      local(),
      remote({ currentPeriodEnd: new Date('2026-11-01T00:00:00.000Z') }),
      PLAN_FOR_PRICE,
    );

    expect(found[0]?.kind).toBe('period');
  });

  it('finds a cancel-at-period-end drift', () => {
    const found = compareSubscription(local(), remote({ cancelAtPeriodEnd: true }), PLAN_FOR_PRICE);

    expect(found[0]).toMatchObject({
      kind: 'cancel_at_period_end',
      local: 'false',
      remote: 'true',
    });
  });

  it('returns every difference, not the first', () => {
    // One event in Stripe, two corrections here. Reporting one would leave
    // the other to be found by a customer.
    const found = compareSubscription(
      local(),
      remote({ status: 'past_due', priceIds: ['price_business'] }),
      PLAN_FOR_PRICE,
    );

    expect(found.map((d) => d.kind).sort()).toEqual(['plan', 'status']);
  });

  it('reports no plan drift for a price it does not recognise', () => {
    // A price created by hand in the dashboard. Correcting to null would
    // wipe the customer's plan.
    const found = compareSubscription(
      local(),
      remote({ priceIds: ['price_handmade'] }),
      PLAN_FOR_PRICE,
    );

    expect(found).toEqual([]);
  });
});

describe('what may be corrected automatically', () => {
  it('allows the mirrored fields', () => {
    // The provider owns all four; our copy is a mirror and overwriting a
    // mirror involves no judgement.
    for (const kind of ['status', 'plan', 'period', 'cancel_at_period_end'] as const) {
      expect(isAutoCorrectable(kind)).toBe(true);
    }
  });

  it('refuses a subscription we have no row for', () => {
    // Inventing one means guessing which workspace it belongs to, and
    // guessing wrong attaches somebody else's card to a workspace.
    expect(isAutoCorrectable('missing_locally')).toBe(false);
  });
});

function harness(
  over: {
    remote?: ProviderSubscription[];
    locals?: LocalSubscription[];
    port?: Partial<ReconcilePort>;
    listThrows?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const emitted: { kind: string; corrected: boolean }[] = [];
  const applied: unknown[] = [];
  const rebuilt: string[] = [];
  let finished: Record<string, unknown> | null = null;

  const port: ReconcilePort = {
    async findByProviderIds() {
      calls.push('find-local');
      return over.locals ?? [local()];
    },
    async applyRemote(input) {
      calls.push('apply');
      applied.push(input);
      return true;
    },
    async rebuildEntitlements(workspaceId) {
      calls.push('rebuild');
      rebuilt.push(workspaceId);
    },
    planForPrice: PLAN_FOR_PRICE,
    async startRun() {
      calls.push('start-run');
      return 'run-1';
    },
    async finishRun(input) {
      calls.push('finish-run');
      finished = input as unknown as Record<string, unknown>;
    },
    emitDivergence(divergence) {
      calls.push('metric');
      emitted.push({ kind: divergence.kind, corrected: divergence.corrected });
    },
    ...over.port,
  };

  const provider = {
    async listRecentlyChangedSubscriptions() {
      calls.push('list-remote');
      if (over.listThrows === true) throw new Error('stripe down');
      return over.remote ?? [remote()];
    },
  } as unknown as BillingProviderAdapter;

  return {
    port,
    provider,
    calls,
    emitted,
    applied,
    rebuilt,
    get finished() {
      return finished;
    },
  };
}

describe('the nightly run', () => {
  it('records the run before it starts work', async () => {
    const { port, provider, calls } = harness();

    await reconcileBilling({ now: NOW }, port, provider);

    expect(calls[0]).toBe('start-run');
    expect(calls).toContain('finish-run');
  });

  it('does nothing to a subscription that agrees', async () => {
    const { port, provider, calls } = harness();

    const result = await reconcileBilling({ now: NOW }, port, provider);

    expect(result.objectsChecked).toBe(1);
    expect(result.divergences).toEqual([]);
    expect(calls).not.toContain('apply');
  });

  it('corrects a drifted status', async () => {
    const { port, provider, applied } = harness({ remote: [remote({ status: 'past_due' })] });

    const result = await reconcileBilling({ now: NOW }, port, provider);

    expect(result.corrected).toBe(1);
    expect(applied[0]).toMatchObject({ status: 'past_due', stateVersion: 9 });
  });

  it('writes the whole row in one call', async () => {
    // The fields came from one remote object; applying them separately would
    // leave the row in a state the provider never had.
    const { port, provider, applied } = harness({
      remote: [remote({ status: 'past_due', priceIds: ['price_business'] })],
    });

    await reconcileBilling({ now: NOW }, port, provider);

    expect(applied).toHaveLength(1);
  });

  it('emits a metric for every divergence', async () => {
    // R19. A reconciler that silently fixes things every night is a
    // reconciler nobody knows is load-bearing.
    const { port, provider, emitted } = harness({
      remote: [remote({ status: 'past_due', cancelAtPeriodEnd: true })],
    });

    await reconcileBilling({ now: NOW }, port, provider);

    expect(emitted).toHaveLength(2);
    expect(emitted.every((e) => e.corrected)).toBe(true);
  });

  it('rebuilds entitlements once when the plan moves', async () => {
    const { port, provider, rebuilt } = harness({
      remote: [remote({ priceIds: ['price_business'], status: 'past_due' })],
    });

    await reconcileBilling({ now: NOW }, port, provider);

    expect(rebuilt).toEqual(['ws-1']);
  });

  it('does not rebuild for a period-only drift', async () => {
    // A renewal moved the dates. Nothing the workspace may do has changed.
    const { port, provider, calls } = harness({
      remote: [remote({ currentPeriodEnd: new Date('2026-11-01T00:00:00.000Z') })],
    });

    await reconcileBilling({ now: NOW }, port, provider);

    expect(calls).not.toContain('rebuild');
  });

  it('counts a subscription it has no row for, and corrects nothing', async () => {
    const { port, provider, calls, emitted } = harness({ locals: [] });

    const result = await reconcileBilling({ now: NOW }, port, provider);

    expect(result.missingLocally).toBe(1);
    expect(result.corrected).toBe(0);
    expect(calls).not.toContain('apply');
    expect(emitted).toEqual([{ kind: 'missing_locally', corrected: false }]);
  });

  it('keeps going past one it cannot place', async () => {
    const { port, provider } = harness({
      remote: [remote({ id: 'sub_unknown' }), remote({ status: 'past_due' })],
      locals: [local()],
    });

    const result = await reconcileBilling({ now: NOW }, port, provider);

    expect(result.objectsChecked).toBe(2);
    expect(result.missingLocally).toBe(1);
    expect(result.corrected).toBe(1);
  });

  it('records what it found', async () => {
    const h = harness({ remote: [remote({ status: 'past_due' })] });

    await reconcileBilling({ now: NOW }, h.port, h.provider);

    expect(h.finished).toMatchObject({
      runId: 'run-1',
      objectsChecked: 1,
      divergencesFound: 1,
      divergencesCorrected: 1,
    });
  });

  it('records a failed run rather than leaving no trace', async () => {
    // A reconciler whose failures leave no trace is a reconciler that has
    // been broken for a month.
    const h = harness({ listThrows: true });

    await expect(reconcileBilling({ now: NOW }, h.port, h.provider)).rejects.toThrow('stripe down');

    expect(h.finished).toMatchObject({ runId: 'run-1', error: 'stripe down' });
  });

  it('counts nothing corrected when the write did not apply', async () => {
    // `applyRemote` is version-guarded. A concurrent webhook that already
    // wrote a newer version wins, and this run must not claim the correction.
    const { port, provider, emitted } = harness({
      remote: [remote({ status: 'past_due' })],
      port: {
        async applyRemote() {
          return false;
        },
      },
    });

    const result = await reconcileBilling({ now: NOW }, port, provider);

    expect(result.corrected).toBe(0);
    expect(result.divergences).toHaveLength(1);
    expect(emitted).toEqual([{ kind: 'status', corrected: false }]);
  });

  it('does not rebuild entitlements when the write did not apply', async () => {
    const { port, provider, calls } = harness({
      remote: [remote({ priceIds: ['price_business'] })],
      port: {
        async applyRemote() {
          return false;
        },
      },
    });

    await reconcileBilling({ now: NOW }, port, provider);

    expect(calls).not.toContain('rebuild');
  });

  it('asks the provider for the window it computed', async () => {
    let asked: Date | null = null;
    const { port } = harness();
    const provider = {
      async listRecentlyChangedSubscriptions(since: Date) {
        asked = since;
        return [];
      },
    } as unknown as BillingProviderAdapter;

    await reconcileBilling({ now: NOW }, port, provider);

    expect(asked).toEqual(reconcileSince(NOW));
  });
});

describe('whether a status change revokes', () => {
  it('says so when it does', () => {
    expect(revokesEntitlements({ from: 'active', to: 'unpaid' })).toBe(true);
    expect(revokesEntitlements({ from: 'trialing', to: 'canceled' })).toBe(true);
  });

  it('says no for a change between two granting statuses', () => {
    // `past_due` still grants. A card that failed this morning has not
    // stopped being a customer.
    expect(revokesEntitlements({ from: 'active', to: 'past_due' })).toBe(false);
  });

  it('says no when nothing was granted to begin with', () => {
    expect(revokesEntitlements({ from: 'canceled', to: 'unpaid' })).toBe(false);
  });

  it('says no for a restoration', () => {
    expect(revokesEntitlements({ from: 'unpaid', to: 'active' })).toBe(false);
  });
});
