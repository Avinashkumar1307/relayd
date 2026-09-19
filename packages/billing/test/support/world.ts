import {
  aggregateUsageFully,
  advanceDunning,
  cancelSubscription,
  changePlan,
  checkUsage,
  dunningStage,
  ingestBillingEvent,
  isNewerThanStored,
  projectEntitlements,
  reconcileBilling,
  refetchBatch,
  usageIdempotencyKey,
  type AggregatePort,
  type AggregateRow,
  type BillingProviderAdapter,
  type CheckoutPort,
  type Decision,
  type DunningPort,
  type DunningStage,
  type EntitlementRow,
  type Grant,
  type Interval,
  type LedgerRow,
  type NormalisedBillingEvent,
  type ObjectType,
  type PlanChangePort,
  type ProviderInvoice,
  type ProviderSubscription,
  type ReconcilePort,
  type RefetchPort,
  type WorkspaceBillingState,
} from '../../src/index.js';
import { FEATURES, PLANS, planByCode, type FeatureKey } from '../../src/plans/catalogue.js';

/**
 * A deterministic billing world.
 *
 * docs/12 asks for the matrix to run "against Stripe test mode with the CLI
 * replaying fixture events, plus a deterministic fake gateway for speed".
 * This is the fake gateway: an in-memory Stripe and an in-memory database,
 * wired to the *real* modules — `ingestBillingEvent`, `refetchBatch`,
 * `changePlan`, `advanceDunning`, `aggregateUsageFully`,
 * `projectEntitlements`, `reconcileBilling`.
 *
 * Nothing here reimplements a decision. Every rule under test is the one that
 * ships; what is faked is the network and the storage, which is the point —
 * the matrix is about how the pieces behave together, and a fake that made
 * its own decisions would be testing itself.
 *
 * The provider side deliberately behaves the way Stripe does in the ways that
 * matter: it redelivers, it delivers out of order, and it never tells us
 * anything it has not been asked for.
 */

const WORKSPACE = 'ws-1';
const PRICES: Record<string, { planCode: string; interval: Interval }> = {
  price_starter_month: { planCode: PLANS.starter, interval: 'month' },
  price_growth_month: { planCode: PLANS.growth, interval: 'month' },
  price_growth_year: { planCode: PLANS.growth, interval: 'year' },
  price_business_month: { planCode: PLANS.business, interval: 'month' },
};

function priceFor(planCode: string, interval: Interval): string | null {
  for (const [id, price] of Object.entries(PRICES)) {
    if (price.planCode === planCode && price.interval === interval) return id;
  }
  return null;
}

export interface RemoteSubscription {
  id: string;
  customerId: string;
  status: ProviderSubscription['status'];
  priceId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  stateVersion: number;
}

export interface LocalSubscriptionRow {
  id: string;
  workspaceId: string;
  providerSubscriptionId: string;
  planCode: string;
  interval: Interval;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  scheduledPlanCode: string | null;
  scheduledChangeAt: Date | null;
  gracePeriodEnd: Date | null;
  firstFailedAt: Date | null;
  dunningStage: DunningStage;
  noticesSentDays: number[];
  providerStateVersion: number;
}

export function createWorld(options: { now?: Date } = {}) {
  let now = options.now ?? new Date('2026-09-01T00:00:00.000Z');

  // ------------------------------------------------------------- provider
  const remote = {
    customers: new Map<string, { id: string; email: string; deleted: boolean; metadata: Record<string, string> }>(),
    subscriptions: new Map<string, RemoteSubscription>(),
    invoices: new Map<string, ProviderInvoice>(),
    sessions: [] as { id: string; priceId: string; billingCustomerId: string; workspaceId: string }[],
    apiCalls: [] as string[],
  };

  // ------------------------------------------------------------- database
  const db = {
    billingCustomers: new Map<string, { id: string; workspaceId: string; providerCustomerId: string | null; status: 'pending' | 'active' | 'failed'; email: string }>(),
    subscriptions: new Map<string, LocalSubscriptionRow>(),
    entitlements: [] as EntitlementRow[],
    billingEvents: [] as { workspaceId: string; eventType: string; detail: unknown }[],
    inbox: new Map<string, { eventType: string; processed: boolean }>(),
    refetchQueue: new Map<string, { objectType: ObjectType; providerObjectId: string; workspaceId: string | null; dirtyCount: number; firstDirtyAt: Date; lastDirtyAt: Date; lastFetchedAt: Date | null; fetchFailures: number }>(),
    usageRecords: [] as LedgerRow[],
    usageAggregates: new Map<string, AggregateRow>(),
    heldCampaigns: new Set<string>(),
    scheduledCampaigns: new Set<string>(['camp-1']),
    workspaceSuspended: false,
    divergences: [] as { kind: string; corrected: boolean }[],
    reconciliationRuns: [] as { id: string; finished: boolean; found: number; corrected: number }[],
  };

  let nextId = 1;
  const id = (prefix: string): string => `${prefix}_${nextId++}`;

  /** UUIDv7-shaped and monotonic, so `id > watermark` is a cursor. */
  const usageId = (): string =>
    `0192aaaa-0000-7000-8000-${(nextId++).toString(16).padStart(12, '0')}`;

  function setNow(next: Date): void {
    now = next;
  }

  function advanceDays(days: number): void {
    now = new Date(now.getTime() + days * 86_400_000);
  }

  function advanceMs(ms: number): void {
    now = new Date(now.getTime() + ms);
  }

  // --------------------------------------------------------- the adapter
  const provider: BillingProviderAdapter = {
    async verifyWebhook() {
      throw new Error('signature verification is the edge route, not this world');
    },

    async createCustomer(input) {
      remote.apiCalls.push('createCustomer');
      const customerId = id('cus');
      remote.customers.set(customerId, {
        id: customerId,
        email: input.email,
        deleted: false,
        metadata: { billing_customer_id: input.billingCustomerId, workspace_id: input.workspaceId },
      });
      return { id: customerId, email: input.email, deleted: false };
    },

    async createCheckoutSession(input) {
      remote.apiCalls.push('createCheckoutSession');
      const sessionId = id('cs');
      remote.sessions.push({
        id: sessionId,
        priceId: input.priceId,
        billingCustomerId: input.billingCustomerId,
        workspaceId: input.workspaceId,
      });
      return {
        id: sessionId,
        url: `https://checkout.stripe.test/${sessionId}`,
        expiresAt: new Date(now.getTime() + 3_600_000),
      };
    },

    async createPortalSession() {
      remote.apiCalls.push('createPortalSession');
      return { url: 'https://billing.stripe.test/p/1' };
    },

    async fetchSubscription(subscriptionId) {
      remote.apiCalls.push('fetchSubscription');
      const row = remote.subscriptions.get(subscriptionId);
      return row === undefined ? null : toProviderSubscription(row);
    },

    async fetchInvoice(invoiceId) {
      remote.apiCalls.push('fetchInvoice');
      return remote.invoices.get(invoiceId) ?? null;
    },

    async fetchCustomer(customerId) {
      remote.apiCalls.push('fetchCustomer');
      const row = remote.customers.get(customerId);
      return row === undefined ? null : { id: row.id, email: row.email, deleted: row.deleted };
    },

    async updateSubscriptionPrice(input) {
      remote.apiCalls.push('updateSubscriptionPrice');
      const row = remote.subscriptions.get(input.providerSubscriptionId);
      if (row === undefined) throw new Error('no such subscription');

      // Stripe applies the price change to the object immediately even for a
      // downgrade scheduled locally; the schedule is ours.
      if (input.prorate) row.priceId = input.priceId;
      row.stateVersion += 1;

      return toProviderSubscription(row);
    },

    async cancelSubscription(input) {
      remote.apiCalls.push('cancelSubscription');
      const row = remote.subscriptions.get(input.providerSubscriptionId);
      if (row === undefined) throw new Error('no such subscription');

      if (input.atPeriodEnd) {
        row.cancelAtPeriodEnd = true;
      } else {
        row.status = 'canceled';
        row.canceledAt = now;
      }
      row.stateVersion += 1;

      return toProviderSubscription(row);
    },

    async reportUsage() {
      remote.apiCalls.push('reportUsage');
    },

    async listRecentlyChangedSubscriptions(since) {
      remote.apiCalls.push('listRecentlyChangedSubscriptions');
      void since;
      return [...remote.subscriptions.values()].map(toProviderSubscription);
    },
  };

  function toProviderSubscription(row: RemoteSubscription): ProviderSubscription {
    return {
      id: row.id,
      customerId: row.customerId,
      status: row.status,
      priceIds: [row.priceId],
      currentPeriodStart: row.currentPeriodStart,
      currentPeriodEnd: row.currentPeriodEnd,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      canceledAt: row.canceledAt,
      trialEnd: null,
      stateVersion: row.stateVersion,
      items: [{ id: `si_${row.id}`, priceId: row.priceId, quantity: 1, isMetered: false }],
    };
  }

  // ------------------------------------------------------------- the ports
  const checkoutPort: CheckoutPort = {
    async activeSubscription(workspaceId) {
      const row = [...db.subscriptions.values()].find(
        (sub) =>
          sub.workspaceId === workspaceId &&
          ['trialing', 'active', 'past_due', 'unpaid'].includes(sub.status),
      );
      return row === undefined ? null : { id: row.id, planCode: row.planCode };
    },
    async findBillingCustomer(workspaceId) {
      const row = [...db.billingCustomers.values()].find((c) => c.workspaceId === workspaceId);
      return row === undefined
        ? null
        : { id: row.id, providerCustomerId: row.providerCustomerId, status: row.status };
    },
    async createPendingBillingCustomer(input) {
      db.billingCustomers.set(input.id, {
        id: input.id,
        workspaceId: input.workspaceId,
        providerCustomerId: null,
        status: 'pending',
        email: input.email,
      });
    },
    async attachProviderCustomer(input) {
      const row = db.billingCustomers.get(input.billingCustomerId);
      if (row !== undefined) {
        row.providerCustomerId = input.providerCustomerId;
        row.status = 'active';
      }
    },
    async markBillingCustomerFailed(input) {
      const row = db.billingCustomers.get(input.billingCustomerId);
      if (row !== undefined) row.status = 'failed';
    },
    async findPrice(input) {
      const priceId = priceFor(input.planCode, input.interval);
      return priceId === null ? null : { id: priceId, providerPriceId: priceId };
    },
    async recordEvent(input) {
      db.billingEvents.push(input);
    },
  };

  const planChangePort: PlanChangePort = {
    async currentSubscription(workspaceId) {
      const row = liveSubscription(workspaceId);
      return row === null
        ? null
        : {
            id: row.id,
            providerSubscriptionId: row.providerSubscriptionId,
            planCode: row.planCode,
            interval: row.interval,
            currentPeriodEnd: row.currentPeriodEnd,
            status: row.status,
          };
    },
    async findPrice(input) {
      const priceId = priceFor(input.planCode, input.interval);
      return priceId === null ? null : { id: priceId, providerPriceId: priceId };
    },
    async currentUsage() {
      return usageByFeature();
    },
    async applyPlanNow(input) {
      const row = db.subscriptions.get(input.subscriptionId);
      if (row === undefined) return;
      row.planCode = input.planCode;
      row.scheduledPlanCode = null;
      row.scheduledChangeAt = null;
      rebuildEntitlements();
    },
    async schedulePlanChange(input) {
      const row = db.subscriptions.get(input.subscriptionId);
      if (row === undefined) return;
      row.scheduledPlanCode = input.planCode;
      row.scheduledChangeAt = input.effectiveAt;
    },
    async recordEvent(input) {
      db.billingEvents.push(input);
    },
  };

  const refetchPort: RefetchPort = {
    async claimDirtyObjects(input) {
      return [...db.refetchQueue.values()]
        .filter((row) => row.lastFetchedAt === null || row.lastDirtyAt > row.lastFetchedAt)
        .slice(0, input.limit)
        .map((row) => ({ ...row }));
    },
    async storedVersion(input) {
      const row = [...db.subscriptions.values()].find(
        (sub) => sub.providerSubscriptionId === input.providerObjectId,
      );
      return row?.providerStateVersion ?? 0;
    },
    async applySubscription(input) {
      const fetched = input.subscription as ProviderSubscription;
      const existing = [...db.subscriptions.values()].find(
        (sub) => sub.providerSubscriptionId === input.providerObjectId,
      );

      if (existing !== undefined) {
        if (!isNewerThanStored({
          fetchedVersion: input.stateVersion,
          storedVersion: existing.providerStateVersion,
        })) {
          return false;
        }

        applyRemoteToLocal(existing, fetched);
        rebuildEntitlements();
        return true;
      }

      const created = localFromRemote(fetched);
      db.subscriptions.set(created.id, created);
      db.billingEvents.push({
        workspaceId: WORKSPACE,
        eventType: 'subscription.created',
        detail: { planCode: created.planCode },
      });
      rebuildEntitlements();
      return true;
    },
    async applyInvoice(input) {
      const invoice = input.invoice as ProviderInvoice;
      remote.invoices.set(invoice.id, invoice);
      return true;
    },
    async applyCustomer() {
      return true;
    },
    async markFetched(input) {
      const row = db.refetchQueue.get(queueKey(input.objectType, input.providerObjectId));
      if (row !== undefined) {
        row.lastFetchedAt = input.fetchedAt;
        row.fetchFailures = 0;
      }
    },
    async markFetchFailed(input) {
      const row = db.refetchQueue.get(queueKey(input.objectType, input.providerObjectId));
      if (row !== undefined) row.fetchFailures = input.failures;
    },
  };

  const dunningPort: DunningPort = {
    async workspacesInDunning() {
      // A live clock OR a stage past `current`. The second half is what lets
      // the tick after a successful payment release the held campaigns.
      return [...db.subscriptions.values()]
        .filter((row) => row.firstFailedAt !== null || row.dunningStage !== 'current')
        .map((row) => ({
          workspaceId: row.workspaceId,
          subscriptionId: row.id,
          status: row.status,
          firstFailedAt: row.firstFailedAt,
          stage: row.dunningStage,
          noticesSentDays: row.noticesSentDays,
        }));
    },
    async setStage(input) {
      const row = db.subscriptions.get(input.subscriptionId);
      if (row === undefined) return false;
      row.dunningStage = input.stage;
      if (input.stage === 'current') {
        row.firstFailedAt = null;
        row.gracePeriodEnd = null;
        row.noticesSentDays = [];
      }
      return true;
    },
    async holdScheduledCampaigns() {
      let held = 0;
      for (const campaign of db.scheduledCampaigns) {
        if (!db.heldCampaigns.has(campaign)) {
          db.heldCampaigns.add(campaign);
          held += 1;
        }
      }
      return held;
    },
    async releaseHeldCampaigns() {
      const released = db.heldCampaigns.size;
      db.heldCampaigns.clear();
      return released;
    },
    async sendNotice(input) {
      const row = [...db.subscriptions.values()].find((sub) => sub.workspaceId === input.workspaceId);
      row?.noticesSentDays.push(input.day);
      db.billingEvents.push({
        workspaceId: input.workspaceId,
        eventType: 'dunning.notice',
        detail: { day: input.day, stage: input.stage },
      });
    },
    async recordEvent(input) {
      db.billingEvents.push(input);
    },
  };

  const aggregatePort: AggregatePort = {
    async readAggregate(key) {
      const row = db.usageAggregates.get(aggregateKey(key.featureKey, key.periodStart));
      return row === undefined ? null : { ...row };
    },
    async readLedgerAfter(input) {
      return db.usageRecords
        .filter((row) => row.featureKey === input.key.featureKey)
        .filter((row) => row.periodStart.getTime() === input.key.periodStart.getTime())
        .filter((row) => input.afterId === null || row.id > input.afterId)
        .filter((row) => row.occurredAt.getTime() < input.before.getTime())
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, input.limit);
    },
    async applyAggregate(input) {
      const row = db.usageAggregates.get(aggregateKey(input.key.featureKey, input.key.periodStart));
      if (row === undefined) return false;
      if (row.lastUsageRecordId !== input.expectedWatermark) return false;

      row.used += input.addUsed;
      row.lastUsageRecordId = input.watermark;
      return true;
    },
    async countLedger(key) {
      return db.usageRecords.filter(
        (row) =>
          row.featureKey === key.featureKey &&
          row.periodStart.getTime() === key.periodStart.getTime(),
      ).length;
    },
  };

  const reconcilePort: ReconcilePort = {
    async findByProviderIds(ids) {
      return [...db.subscriptions.values()]
        .filter((row) => ids.includes(row.providerSubscriptionId))
        .map((row) => ({
          id: row.id,
          workspaceId: row.workspaceId,
          providerSubscriptionId: row.providerSubscriptionId,
          planCode: row.planCode,
          status: row.status,
          currentPeriodStart: row.currentPeriodStart,
          currentPeriodEnd: row.currentPeriodEnd,
          cancelAtPeriodEnd: row.cancelAtPeriodEnd,
          providerStateVersion: row.providerStateVersion,
        }));
    },
    async applyRemote(input) {
      const row = db.subscriptions.get(input.subscriptionId);
      if (row === undefined) return false;
      if (input.stateVersion <= row.providerStateVersion) return false;

      row.status = input.status;
      if (input.planCode !== null) row.planCode = input.planCode;
      row.currentPeriodStart = input.currentPeriodStart;
      row.currentPeriodEnd = input.currentPeriodEnd;
      row.cancelAtPeriodEnd = input.cancelAtPeriodEnd;
      row.providerStateVersion = input.stateVersion;
      return true;
    },
    async rebuildEntitlements() {
      rebuildEntitlements();
    },
    planForPrice(priceId) {
      return PRICES[priceId]?.planCode ?? null;
    },
    async startRun() {
      const runId = id('run');
      db.reconciliationRuns.push({ id: runId, finished: false, found: 0, corrected: 0 });
      return runId;
    },
    async finishRun(input) {
      const run = db.reconciliationRuns.find((row) => row.id === input.runId);
      if (run !== undefined) {
        run.finished = true;
        run.found = input.divergencesFound;
        run.corrected = input.divergencesCorrected;
      }
    },
    emitDivergence(divergence) {
      db.divergences.push({ kind: divergence.kind, corrected: divergence.corrected });
    },
  };

  // ------------------------------------------------------------ the helpers
  function queueKey(objectType: ObjectType, providerObjectId: string): string {
    return `${objectType}:${providerObjectId}`;
  }

  function aggregateKey(featureKey: string, periodStart: Date): string {
    return `${featureKey}:${periodStart.toISOString()}`;
  }

  function liveSubscription(workspaceId = WORKSPACE): LocalSubscriptionRow | null {
    return (
      [...db.subscriptions.values()].find(
        (row) =>
          row.workspaceId === workspaceId &&
          ['trialing', 'active', 'past_due', 'unpaid'].includes(row.status),
      ) ?? null
    );
  }

  function localFromRemote(fetched: ProviderSubscription): LocalSubscriptionRow {
    const price = PRICES[fetched.priceIds[0] ?? ''];

    return {
      id: id('sub'),
      workspaceId: WORKSPACE,
      providerSubscriptionId: fetched.id,
      planCode: price?.planCode ?? PLANS.starter,
      interval: price?.interval ?? 'month',
      status: fetched.status,
      currentPeriodStart: fetched.currentPeriodStart,
      currentPeriodEnd: fetched.currentPeriodEnd,
      cancelAtPeriodEnd: fetched.cancelAtPeriodEnd,
      scheduledPlanCode: null,
      scheduledChangeAt: null,
      gracePeriodEnd: null,
      firstFailedAt: null,
      dunningStage: 'current',
      noticesSentDays: [],
      providerStateVersion: fetched.stateVersion,
    };
  }

  function applyRemoteToLocal(row: LocalSubscriptionRow, fetched: ProviderSubscription): void {
    const price = PRICES[fetched.priceIds[0] ?? ''];

    row.status = fetched.status;
    if (price !== undefined) {
      row.planCode = price.planCode;
      row.interval = price.interval;
    }
    row.currentPeriodStart = fetched.currentPeriodStart;
    row.currentPeriodEnd = fetched.currentPeriodEnd;
    row.cancelAtPeriodEnd = fetched.cancelAtPeriodEnd;
    row.providerStateVersion = fetched.stateVersion;

    if (fetched.status === 'past_due' && row.firstFailedAt === null) {
      row.firstFailedAt = now;
      row.gracePeriodEnd = new Date(now.getTime() + 14 * 86_400_000);
    }

    if (fetched.status === 'active') {
      row.firstFailedAt = null;
      row.gracePeriodEnd = null;
    }
  }

  function rebuildEntitlements(): void {
    const row = liveSubscription();

    db.entitlements = projectEntitlements(
      row === null
        ? null
        : { id: row.id, workspaceId: row.workspaceId, planCode: row.planCode, status: row.status },
    );
  }

  function grants(): Grant[] {
    return db.entitlements.map((row) => ({
      featureKey: row.featureKey,
      limitValue: row.limitValue,
      flagValue: row.flagValue,
    }));
  }

  function billingState(): WorkspaceBillingState {
    const row = liveSubscription();

    return {
      workspaceSuspended: db.workspaceSuspended,
      subscriptionSuspended: row?.status === 'unpaid',
      pastDue: row?.status === 'past_due',
      hasSubscription: row !== null && row.status !== 'unpaid',
    };
  }

  function usageByFeature(): Partial<Record<FeatureKey, number>> {
    const out: Partial<Record<FeatureKey, number>> = {};
    for (const row of db.usageAggregates.values()) {
      out[row.featureKey as FeatureKey] = row.used;
    }
    return out;
  }

  function openPeriod(input: { periodStart: Date; periodEnd: Date; included: number | null }): void {
    db.usageAggregates.set(aggregateKey(FEATURES.emailsSent, input.periodStart), {
      workspaceId: WORKSPACE,
      featureKey: FEATURES.emailsSent,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      used: 0,
      included: input.included,
      overage: 0,
      lastUsageRecordId: null,
    });
  }

  // ------------------------------------------------------------- the moves
  return {
    get now() {
      return now;
    },
    setNow,
    advanceDays,
    advanceMs,
    db,
    remote,
    provider,
    ports: { checkoutPort, planChangePort, refetchPort, dunningPort, aggregatePort, reconcilePort },
    grants,
    billingState,
    liveSubscription,
    rebuildEntitlements,
    openPeriod,
    usageByFeature,

    /** Creates the Stripe-side subscription a completed checkout would leave. */
    completeCheckoutAtProvider(input: { planCode: string; interval?: Interval }): string {
      const customerId = [...remote.customers.keys()][0] ?? id('cus');
      const subscriptionId = id('sub_stripe');
      const priceId = priceFor(input.planCode, input.interval ?? 'month');

      remote.subscriptions.set(subscriptionId, {
        id: subscriptionId,
        customerId,
        status: 'active',
        priceId: priceId ?? 'price_growth_month',
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
        cancelAtPeriodEnd: false,
        canceledAt: null,
        stateVersion: 1,
      });

      return subscriptionId;
    },

    /** One webhook, through the real ingest path. */
    async deliver(event: Partial<NormalisedBillingEvent> & { providerEventId: string }) {
      return ingestBillingEvent(
        {
          type: 'customer.subscription.updated',
          objectType: 'subscription',
          providerObjectId: null,
          billingCustomerId: null,
          workspaceId: WORKSPACE,
          createdAt: now,
          payload: {},
          ...event,
        },
        {
          async insertInboxEvent(input) {
            if (db.inbox.has(input.providerEventId)) return false;
            db.inbox.set(input.providerEventId, { eventType: input.eventType, processed: false });
            return true;
          },
          async markDirty(input) {
            const key = queueKey(input.objectType, input.providerObjectId);
            const existing = db.refetchQueue.get(key);

            if (existing === undefined) {
              db.refetchQueue.set(key, {
                objectType: input.objectType,
                providerObjectId: input.providerObjectId,
                workspaceId: input.workspaceId,
                dirtyCount: 1,
                firstDirtyAt: now,
                lastDirtyAt: now,
                lastFetchedAt: null,
                fetchFailures: 0,
              });
              return;
            }

            existing.dirtyCount += 1;
            existing.lastDirtyAt = now;
          },
        },
      );
    },

    /** Drains the re-fetch queue through the real consumer. */
    async drainRefetch(cooldownMs = 0) {
      return refetchBatch({ now, cooldownMs }, refetchPort, provider);
    },

    async changePlan(input: { planCode: string; interval?: Interval }) {
      return changePlan(
        {
          workspaceId: WORKSPACE,
          toPlanCode: input.planCode,
          toInterval: input.interval ?? 'month',
          isSelfServe: (code) => planByCode(code)?.isPublic === true,
        },
        planChangePort,
        provider,
      );
    },

    async cancel(immediately: boolean) {
      return cancelSubscription({ workspaceId: WORKSPACE, immediately }, planChangePort, provider);
    },

    async runDunning() {
      const rows = await dunningPort.workspacesInDunning(now);
      const outcomes = [];
      for (const row of rows) outcomes.push(await advanceDunning(row, now, dunningPort));
      return outcomes;
    },

    async reconcile() {
      return reconcileBilling({ now }, reconcilePort, provider);
    },

    /** One billable send, through the two guards the real path uses. */
    meterSend(input: { recipientId: string; periodStart: Date }): boolean {
      const key = usageIdempotencyKey(input.recipientId);
      if (db.usageRecords.some((row) => row.id === key || row.workspaceId === key)) return false;

      // The ledger's unique index, as a check on the idempotency key.
      const seen = db.usageRecords.some(
        (row) => (row as LedgerRow & { idempotencyKey?: string }).idempotencyKey === key,
      );
      if (seen) return false;

      const record = {
        id: usageId(),
        workspaceId: WORKSPACE,
        featureKey: FEATURES.emailsSent,
        quantity: 1,
        periodStart: input.periodStart,
        occurredAt: new Date(now.getTime() - 5 * 60_000),
        idempotencyKey: key,
      };

      db.usageRecords.push(record as LedgerRow);
      return true;
    },

    async aggregateUsage(periodStart: Date) {
      return aggregateUsageFully(
        {
          key: { workspaceId: WORKSPACE, featureKey: FEATURES.emailsSent, periodStart },
          now,
        },
        aggregatePort,
      );
    },

    /** The gate, against whatever the world currently holds. */
    check(input: { feature: FeatureKey; requested?: number }): Decision {
      const used =
        [...db.usageAggregates.values()].find((row) => row.featureKey === input.feature)?.used ?? 0;

      return checkUsage(
        input.feature,
        { used, ...(input.requested === undefined ? {} : { requested: input.requested }) },
        grants(),
        billingState(),
      );
    },

    stage(): DunningStage {
      const row = liveSubscription();
      if (row === null || row.firstFailedAt === null) return 'current';
      return dunningStage({ status: row.status, firstFailedAt: row.firstFailedAt, now });
    },

    /** Marks the provider-side subscription past due, the way a failed charge does. */
    failPaymentAtProvider(subscriptionId: string): void {
      const row = remote.subscriptions.get(subscriptionId);
      if (row === undefined) return;
      row.status = 'past_due';
      row.stateVersion += 1;
    },

    recoverPaymentAtProvider(subscriptionId: string): void {
      const row = remote.subscriptions.get(subscriptionId);
      if (row === undefined) return;
      row.status = 'active';
      row.stateVersion += 1;
    },

    exhaustRetriesAtProvider(subscriptionId: string): void {
      const row = remote.subscriptions.get(subscriptionId);
      if (row === undefined) return;
      row.status = 'unpaid';
      row.stateVersion += 1;
    },

    WORKSPACE,
  };
}

export type World = ReturnType<typeof createWorld>;
