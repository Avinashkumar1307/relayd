import { z } from 'zod';
import { emailSchema } from './auth.js';

/**
 * Billing request schemas (design section I).
 *
 * Only the invoice identity is here. Nothing in this file describes money:
 * amounts, proration and payment outcomes come back from Stripe, and a
 * client-supplied number would be a client-supplied price (CLAUDE.md
 * section 10).
 */

/**
 * The details printed on an invoice (I8).
 *
 * `email` is where receipts go. It is validated as an address rather than
 * accepted as free text because Stripe will refuse a malformed one at send
 * time, and discovering that at the moment an invoice is issued is the worst
 * possible moment.
 *
 * `address` is one multi-line string, matching what the form collects. It is
 * deliberately not the structured line1 / city / postal_code / country set
 * Stripe Tax needs: that shape is a decision about tax calculation which is
 * not made yet, and inventing it here would freeze a guess into a migration.
 *
 * `taxId` is not pattern-checked. There are dozens of national formats, a
 * regex that rejects a valid one is worse than one that accepts an invalid
 * one, and the authority on whether a VAT id is real is the tax authority —
 * via Stripe — not this file.
 *
 * `.strict()`, so a client sending `country` or `vatValidated` is told the
 * field does not exist rather than having it silently dropped.
 */
export const billingDetailsSchema = z
  .object({
    email: emailSchema,
    company: z.string().max(200).trim().default(''),
    address: z.string().max(1_000).trim().default(''),
    taxId: z.string().max(64).trim().default(''),
  })
  .strict();

export type BillingDetailsRequest = z.infer<typeof billingDetailsSchema>;
