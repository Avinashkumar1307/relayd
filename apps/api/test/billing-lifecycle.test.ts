import { describe, expect, it } from 'vitest';
import { FEATURES, PLANS } from '@relayd/billing';
import type { WorkspaceScope } from '@relayd/db';
import { BillingService } from '../src/services/billing.js';
import type {
  BillingDetails,
  BillingRepositoryLike,
  BillingServiceOptions,
} from '../src/services/billing.js';

/**
 * Reactivate, retry payment, invoice details and export (I1b, I8, I9).
 *
 * The rule that shapes all four, and the one every test here turns on:
 * **Stripe owns the money object and we own the mapping** (CLAUDE.md
 * section 10). Reactivating and retrying send an instruction and write
 * nothing locally; the webhook that follows is what moves our rows. A
 * service that optimistically cleared `cancel_at_period_end` itself would
 * be a second source of truth for a flag Stripe owns, and the two would
 * disagree the first time the call failed after the write.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const PERIOD_END = new Date('2026-10-01T00:00:00.000Z');

const SUBSCRIPTION = {
  id: 'sub-row',
  providerSubscriptionId: 'sub_stripe',
  planCode: PLANS.growth,
  interval: 'month' as const,
  status: 'active',
  currentPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
  currentPeriodEnd: PERIOD_END,
  cancelAtPeriodEnd: true,
  scheduledPlanCode: null,
  scheduledChangeAt: null,
  trialEnd: null,
};

const INVOICE = {
  id: 'in_past_due',
  number: 'INV-2026-0912',
  status: 'open',
  currency: 'usd',
  total: 24_900,
  amountDue: 24_900,
  periodStart: null,
  periodEnd: null,
  paidAt: null,
  hostedInvoiceUrl: null,
  pdfUrl: null,
  createdAt: new Date('2026-09-12T00:00:00.000Z'),
};

function world(
  over: {
    repo?: Partial<BillingRepositoryLike>;
    provider?: Record<string, unknown>;
    exports?: boolean;
    stored?: BillingDetails | null;
  } = {},
) {
  const calls: string[] = [];
  const audited: { action: string; after?: unknown }[] = [];
  let stored: BillingDetails | null = over.stored ?? null;

  const repo: BillingRepositoryLike = {
    async readEntitlements() {
      return [{ featureKey: FEATURES.emailsSent, limitValue: 100_000, flagValue: null }];
    },
    async readBillingState() {
      return {
        workspaceSuspended: false,
        subscriptionSuspended: false,
        pastDue: true,
        hasSubscription: true,
      };
    },
    async currentSubscription() {
      return SUBSCRIPTION;
    },
    async usageForPeriod() {
      return [];
    },
    async currentUsageByFeature() {
      return {};
    },
    async listInvoices() {
      calls.push('invoices');
      return [{ ...INVOICE, status: 'paid', id: 'in_paid' }, INVOICE];
    },
    async defaultPaymentMethod() {
      return null;
    },
    async providerCustomerId() {
      return 'cus_123';
    },
    async billingEmail() {
      return 'owner@example.com';
    },
    async billingDetails() {
      return stored;
    },
    async saveBillingDetails(_scope, input) {
      calls.push('save-details');
      stored = {
        email: input.email,
        company: input.company,
        address: input.address,
        taxId: input.taxId,
      };
      return stored;
    },
    ...over.repo,
  };

  const options: BillingServiceOptions = {
    unitOfWork: async (fn) => fn({ billing: repo }),
    provider: {
      async resumeSubscription() {
        calls.push('stripe-resume');
      },
      async payInvoice() {
        calls.push('stripe-pay');
      },
      ...over.provider,
    } as never,
    checkoutPort: () => ({}) as never,
    planChangePort: () => ({
      async recordEvent(input: { eventType: string }) {
        calls.push(`event:${input.eventType}`);
      },
    }) as never,
    newId: () => 'bc-new',
    appUrl: 'https://app.relayd.test',
    audit: {
      async record(_scope, entry) {
        audited.push(entry);
      },
    },
    ...(over.exports === true
      ? {
          exports: {
            async enqueue() {
              calls.push('export-queued');
              return { jobId: 'job-1' };
            },
          },
        }
      : {}),
  };

  return { service: new BillingService(options), calls, audited, details: () => stored };
}

describe('reactivate', () => {
  it('tells Stripe and records the event, and writes no subscription state', async () => {
    const { service, calls } = world();

    expect(await service.reactivate(SCOPE)).toEqual({ ok: true });
    expect(calls).toContain('stripe-resume');
    expect(calls).toContain('event:subscription.reactivated');
  });

  it('refuses when nothing is scheduled to cancel', async () => {
    // Answering ok to a no-op teaches the customer the button did something.
    const { service } = world({
      repo: {
        async currentSubscription() {
          return { ...SUBSCRIPTION, cancelAtPeriodEnd: false };
        },
      },
    });

    await expect(service.reactivate(SCOPE)).rejects.toMatchObject({ status: 409 });
  });

  it('is 404 when the workspace has no subscription at all', async () => {
    const { service } = world({
      repo: {
        async currentSubscription() {
          return null;
        },
      },
    });

    await expect(service.reactivate(SCOPE)).rejects.toMatchObject({ status: 404 });
  });

  it('is 502 when the provider refuses, not 500', async () => {
    // It is not our fault and it is worth retrying.
    const { service } = world({
      provider: {
        async resumeSubscription() {
          throw new Error('stripe is down');
        },
      },
    });

    await expect(service.reactivate(SCOPE)).rejects.toMatchObject({ status: 502 });
  });

  it('is 503 when the adapter cannot do it at all', async () => {
    // The capability is genuinely absent. 503 says so; a silent ok would
    // leave a customer believing their subscription was saved.
    const { service } = world({ provider: { resumeSubscription: undefined } });

    await expect(service.reactivate(SCOPE)).rejects.toMatchObject({ status: 503 });
  });
});

describe('retry payment', () => {
  it('chooses the unpaid invoice server-side and pays it', async () => {
    // Never the client's choice. A client that could name an invoice could
    // ask us to charge a different workspace's.
    const { service, calls } = world();

    expect(await service.retryPayment(SCOPE)).toEqual({ ok: true });
    expect(calls).toContain('stripe-pay');
  });

  it('is 404 when everything is paid', async () => {
    const { service } = world({
      repo: {
        async listInvoices() {
          return [{ ...INVOICE, status: 'paid' }];
        },
      },
    });

    await expect(service.retryPayment(SCOPE)).rejects.toMatchObject({ status: 404 });
  });

  it('ignores a draft invoice, which has nothing to charge', async () => {
    const { service } = world({
      repo: {
        async listInvoices() {
          return [{ ...INVOICE, status: 'draft' }];
        },
      },
    });

    await expect(service.retryPayment(SCOPE)).rejects.toMatchObject({ status: 404 });
  });

  it('is 502 and not 402 when the provider call fails', async () => {
    // The card may well be declined again, but we do not know that until
    // the webhook. All this call reports is whether Stripe took the
    // instruction.
    const { service } = world({
      provider: {
        async payInvoice() {
          throw new Error('stripe is down');
        },
      },
    });

    await expect(service.retryPayment(SCOPE)).rejects.toMatchObject({ status: 502 });
  });
});

describe('invoice details', () => {
  it('falls back to the owner’s address before anything has been saved', async () => {
    const { service } = world();

    expect(await service.details(SCOPE)).toEqual({
      email: 'owner@example.com',
      company: '',
      address: '',
      taxId: '',
    });
  });

  it('saves and reads back', async () => {
    const { service } = world();

    const saved = await service.updateDetails(SCOPE, {
      email: 'finance@northwind.travel',
      company: 'Northwind Voyages FZ-LLC',
      address: 'Dubai Media City, Dubai, UAE',
      taxId: 'AE100123456700003',
    });

    expect(saved.taxId).toBe('AE100123456700003');
    expect((await service.details(SCOPE)).company).toBe('Northwind Voyages FZ-LLC');
  });

  it('audits the change without putting the tax id in the log', async () => {
    // An audit log is read by more people than the billing page is, and a
    // VAT number identifies a business.
    const { service, audited } = world();

    await service.updateDetails(SCOPE, {
      email: 'finance@northwind.travel',
      company: 'Northwind',
      address: 'Dubai',
      taxId: 'AE100123456700003',
    });

    const entry = audited.find((row) => row.action === 'billing.details_updated');
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain('AE100123456700003');
    expect(JSON.stringify(entry)).toContain('hasTaxId');
  });
});

describe('export everything', () => {
  it('queues the job and audits the request', async () => {
    const { service, calls, audited } = world({ exports: true });

    expect(await service.requestExport(SCOPE, { requestedBy: 'usr-1' })).toEqual({ ok: true });
    expect(calls).toContain('export-queued');
    expect(audited.map((row) => row.action)).toContain('billing.export_requested');
  });

  it('is 503 rather than a silent ok when no queue is wired', async () => {
    const { service } = world();

    await expect(service.requestExport(SCOPE, { requestedBy: 'usr-1' })).rejects.toMatchObject({
      status: 503,
    });
  });
});
