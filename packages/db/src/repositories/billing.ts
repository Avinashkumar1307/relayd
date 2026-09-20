import { and, eq } from 'drizzle-orm';
import type { WorkspaceId } from '@relayd/types';
import { billingCustomers } from '../schema/billing.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * The billing customer row — the workspace ↔ provider mapping, and the
 * invoice identity printed on what the provider sends.
 *
 * Nothing here touches a money object. Stripe owns charges, invoices,
 * subscription status, refunds and payment methods (CLAUDE.md section 10);
 * what this file owns is the mapping row and the three fields a customer
 * types into I8. Reading a Stripe invoice is a different repository and a
 * different table.
 *
 * `provider` is a parameter rather than a constant even though `stripe` is
 * the only value D1 allows, because it is half of `uq_bc_workspace` and a
 * write that guesses it writes a second row.
 */

export interface BillingCustomerRow {
  id: string;
  workspaceId: WorkspaceId;
  provider: string;
  providerCustomerId: string | null;
  status: 'pending' | 'active' | 'failed';
  email: string | null;
  company: string | null;
  address: string | null;
  taxId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What I8 edits. Every field optional — a customer may fill in one of them. */
export interface BillingDetailsPatch {
  email?: string;
  company?: string;
  address?: string;
  taxId?: string;
}

export const DEFAULT_BILLING_PROVIDER = 'stripe';

export class BillingCustomerRepository {
  constructor(private readonly db: Executor) {}

  async find(
    scope: WorkspaceScope,
    options: { provider?: string } = {},
  ): Promise<BillingCustomerRow | null> {
    const [row] = await this.db
      .select()
      .from(billingCustomers)
      .where(
        and(
          eq(billingCustomers.workspaceId, scope.workspaceId),
          eq(billingCustomers.provider, options.provider ?? DEFAULT_BILLING_PROVIDER),
        ),
      )
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  /**
   * Writes the invoice identity, creating the billing customer if this
   * workspace has never had one.
   *
   * The insert is the R18 ordering seen from the other end: the row exists
   * before Stripe knows anything about it, `provider_customer_id` stays null
   * and `status` stays `pending` until a Stripe customer is created for it.
   * A customer who fills in their VAT id before they ever reach checkout is
   * the ordinary case, not an edge one.
   *
   * `onConflictDoUpdate` on `uq_bc_workspace` rather than read-then-write:
   * two tabs saving the form at once must not race into a unique violation,
   * and the conflict target is the index that already exists.
   *
   * Fields absent from the patch are left alone. `exactOptionalPropertyTypes`
   * is what makes that readable — "not supplied" and "cleared to empty" are
   * different requests, and only the first is a partial update.
   */
  async upsertDetails(
    scope: WorkspaceScope,
    input: BillingDetailsPatch & { id: string; provider?: string },
  ): Promise<BillingCustomerRow> {
    const provider = input.provider ?? DEFAULT_BILLING_PROVIDER;

    const fields = {
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.company === undefined ? {} : { company: input.company }),
      ...(input.address === undefined ? {} : { address: input.address }),
      ...(input.taxId === undefined ? {} : { taxId: input.taxId }),
    };

    const [row] = await this.db
      .insert(billingCustomers)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        provider,
        ...fields,
      })
      .onConflictDoUpdate({
        target: [billingCustomers.workspaceId, billingCustomers.provider],
        set: { ...fields, updatedAt: new Date() },
      })
      .returning();

    if (row === undefined) throw new Error('upsertBillingDetails: returned no row');
    return toRow(row);
  }
}

function toRow(row: typeof billingCustomers.$inferSelect): BillingCustomerRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    provider: row.provider,
    providerCustomerId: row.providerCustomerId,
    status: row.status,
    email: row.email,
    company: row.company,
    address: row.address,
    taxId: row.taxId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
