import express, { Router, type Request, type Response } from 'express';
import type { Logger } from '@relayd/logger';

/**
 * Stripe webhook ingest (INVARIANTS R17, review findings F17, F18).
 *
 * One endpoint, not one per workspace — the opposite of the provider ingest
 * next door, and for a reason that is easy to state: provider webhooks carry
 * a workspace's own credentials and a tenant boundary that must be enforced by
 * the URL, while Stripe events come from our account and are signed with our
 * secret. There is no per-tenant secret to verify against because there is no
 * per-tenant Stripe account.
 *
 * The route does exactly two writes and nothing else:
 *
 *   1. Insert the event into the inbox, `ON CONFLICT DO NOTHING`.
 *   2. Mark the object it refers to dirty in `billing_refetch_queue`.
 *
 * It never calls Stripe. That is R17, and the reason is arithmetic: at the
 * monthly billing boundary Stripe emits invoice and subscription events for
 * every customer within a few minutes, and at 5,000 customers that is roughly
 * 15,000 events against a read budget of about 100 per second. Fetching
 * inline means 429s inside HTTP handlers that each owe a 200 in under 200 ms,
 * and reconciliation lagging by hours on the day it matters most.
 *
 * It also never interprets the payload. A separate consumer re-fetches each
 * dirty object at most once per 30 seconds and writes the provider's current
 * truth, which is what makes out-of-order delivery a non-event rather than a
 * corruption.
 */

export interface BillingWebhookDependencies {
  logger: Logger;

  /**
   * Verifies the signature over the raw bytes and normalises the event.
   *
   * Throws or returns null for anything that does not verify. Implemented by
   * the Stripe adapter, which is the only place the SDK is allowed to live.
   */
  verify(input: { rawBody: Buffer; signature: string }): Promise<{
    providerEventId: string;
    type: string;
    objectType: string | null;
    providerObjectId: string | null;
    workspaceId: string | null;
    payload: unknown;
  } | null>;

  /** Inserts the inbox row. False means it was already there. */
  insertInboxEvent(input: {
    providerEventId: string;
    eventType: string;
    workspaceId: string | null;
    payload: unknown;
  }): Promise<boolean>;

  /** One row per object, `dirty_count` incremented. Never one per event. */
  markDirty(input: {
    objectType: string;
    providerObjectId: string;
    workspaceId: string | null;
  }): Promise<void>;

  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 512 * 1024;

export function billingWebhookRoutes(deps: BillingWebhookDependencies): Router {
  const router = Router();

  /**
   * Raw bytes, before any JSON parser.
   *
   * Stripe signs what it sent. Re-serialising parsed JSON changes key order,
   * whitespace and number formatting, and the signature stops matching — for
   * every event, silently, in a way that looks like a configuration problem.
   */
  const rawBody = express.raw({ type: '*/*', limit: deps.maxBodyBytes ?? DEFAULT_MAX_BODY });

  router.post(
    '/ingest/v1/stripe',
    rawBody,
    async (req: Request, res: Response): Promise<void> => {
      const signature = headerValue(req, 'stripe-signature');

      if (signature === null) {
        // 400 rather than 404. Unlike the per-connection endpoints there is
        // nothing to conceal here: the URL is in Stripe's dashboard.
        res.status(400).json({ error: { code: 'bad_request', message: 'Missing signature' } });
        return;
      }

      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      let event: Awaited<ReturnType<BillingWebhookDependencies['verify']>>;
      try {
        event = await deps.verify({ rawBody: raw, signature });
      } catch {
        event = null;
      }

      if (event === null) {
        deps.logger.warn({ bytes: raw.length }, 'stripe webhook signature rejected');
        res
          .status(401)
          .json({ error: { code: 'unauthenticated', message: 'Invalid signature' } });
        return;
      }

      // Write one. The row commits before the 200 is returned, so a crash
      // after the 200 loses nothing.
      const inserted = await deps.insertInboxEvent({
        providerEventId: event.providerEventId,
        eventType: event.type,
        workspaceId: event.workspaceId,
        payload: event.payload,
      });

      if (!inserted) {
        // A redelivery. The first one already marked the object dirty, and
        // marking it again inflates `dirty_count` without changing what the
        // consumer does. Still a 200: anything else makes Stripe retry, and
        // retrying a duplicate forever is how an endpoint gets disabled.
        res.status(200).json({ data: { received: true, duplicate: true } });
        return;
      }

      if (event.objectType === null || event.providerObjectId === null) {
        // An event about nothing we mirror — a `ping`, a
        // `customer.discount.created`. Kept for the record, deliberately not
        // an error, because refusing it makes Stripe retry something we will
        // never process.
        res.status(200).json({ data: { received: true, marked: false } });
        return;
      }

      // Write two.
      await deps.markDirty({
        objectType: event.objectType,
        providerObjectId: event.providerObjectId,
        workspaceId: event.workspaceId,
      });

      res.status(200).json({ data: { received: true, marked: true } });
    },
  );

  return router;
}

function headerValue(req: Request, name: string): string | null {
  const raw = req.headers[name];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  // An array means the header arrived twice. Picking one would be choosing
  // which signature to verify against, which is a decision nobody should make
  // on a caller's behalf.
  return null;
}
