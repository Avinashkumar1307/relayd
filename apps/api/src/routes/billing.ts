import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { GlobalMembershipRepository } from '@relayd/db';
import { AppError } from '@relayd/types';
import { requireScope } from '../context.js';
import { authenticate, requirePermission, requireWorkspace } from '../middleware/authorize.js';
import { refuseApiKey } from '../middleware/api-key-auth.js';
import { statusForEntitlementDenial, type BillingService } from '../services/billing.js';
import type { TokenService } from '../services/tokens.js';

/**
 * Billing routes (docs/03, docs/05; CLAUDE.md section 11).
 *
 * `billing:read` shows the page. `billing:write` moves money, and it is
 * owner-only — not admin — and can never be attached to an API key. The
 * permission matrix enforces both; this file only has to ask for the right
 * one, and asking for `billing:read` on a plan change would quietly hand every
 * admin a credit card.
 *
 * The plan catalogue is the one unauthenticated read here. It is the pricing
 * page, it is identical for every workspace, and gating it would mean a
 * signed-out visitor could not see what anything costs.
 */

export interface BillingRouterOptions {
  billing: BillingService;
  tokens: TokenService;
  memberships: GlobalMembershipRepository;
}

const intervalSchema = z.enum(['month', 'year']);

const checkoutSchema = z.object({
  planCode: z.string().min(1).max(32),
  interval: intervalSchema,
  // No email. The billing address is the workspace owner's and is read
  // server-side: a client that could choose it could create a Stripe customer
  // carrying somebody else's address.
  trialDays: z.number().int().min(0).max(90).optional(),
});

const planChangeSchema = z.object({
  planCode: z.string().min(1).max(32),
  interval: intervalSchema,
});

const cancelSchema = z.object({
  /**
   * Defaults to false. Immediate cancellation ends a paid period early with
   * no refund, so it is a thing the caller says explicitly rather than gets by
   * leaving a field out.
   */
  immediately: z.boolean().default(false),
});

const usageCheckSchema = z.object({
  feature: z.string().min(1).max(64),
  requested: z.coerce.number().int().min(0).max(100_000_000).optional(),
});

export function billingRoutes(options: BillingRouterOptions): Router {
  const router = Router();
  const { billing } = options;

  const auth = authenticate(options.tokens);
  const workspace = requireWorkspace({ memberships: options.memberships });
  const read = [auth, workspace, requirePermission('billing:read')] as const;
  // `refuseApiKey` as well as the owner-only permission. `billing:write` is
  // already ungrantable to a key, so this is the second of two — and the one
  // that still holds if somebody ever edits the forbidden set.
  const write = [
    auth,
    workspace,
    refuseApiKey(),
    requirePermission('billing:write'),
  ] as const;

  /** The pricing page. Public by design. */
  router.get('/billing/plans', (_req: Request, res: Response) => {
    res.json({ data: billing.plans() });
  });

  router.get('/billing', ...read, async (_req: Request, res: Response) => {
    res.json({ data: await billing.overview(requireScope()) });
  });

  router.get('/billing/usage', ...read, async (_req: Request, res: Response) => {
    res.json({ data: await billing.usage(requireScope()) });
  });

  router.get('/billing/invoices', ...read, async (req: Request, res: Response) => {
    const limit = Number.parseInt(String(req.query['limit'] ?? ''), 10);
    const before = typeof req.query['before'] === 'string' ? new Date(req.query['before']) : undefined;

    res.json({
      data: await billing.invoices(requireScope(), {
        ...(Number.isFinite(limit) ? { limit } : {}),
        // An unparseable date is ignored rather than refused: it is a
        // pagination cursor, and refusing one strands a client mid-list.
        ...(before !== undefined && !Number.isNaN(before.getTime()) ? { before } : {}),
      }),
    });
  });

  /**
   * A read-only entitlement check.
   *
   * For showing the customer where they stand, never for deciding whether to
   * allow something: the real check runs server-side inside the transaction of
   * the action it gates (R28). A client that has been told "you have room" and
   * acts on it is a client that can be lied to.
   */
  router.get('/billing/entitlements/check', ...read, async (req: Request, res: Response) => {
    const parsed = usageCheckSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError('validation_failed', 'Invalid feature or quantity', 400);
    }

    const decision = await billing.entitlementCheck(requireScope(), {
      feature: parsed.data.feature as never,
      ...(parsed.data.requested === undefined ? {} : { requested: parsed.data.requested }),
    });

    // 200 with the decision in the body, not a 402: this endpoint reports,
    // it does not refuse. `advisoryStatus` is what the *gated* endpoint would
    // have answered.
    res.json({
      data: {
        ...decision,
        advisoryStatus: statusForEntitlementDenial(decision),
      },
    });
  });

  router.post('/billing/checkout', ...write, async (req: Request, res: Response) => {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('validation_failed', 'Invalid checkout request', 400, details(parsed.error));
    }

    const { trialDays, ...rest } = parsed.data;
    const session = await billing.startCheckout(requireScope(), {
      ...rest,
      // Spread rather than passed: `exactOptionalPropertyTypes` draws a line
      // between "no trial asked for" and "a trial of undefined", and only the
      // first is a thing.
      ...(trialDays === undefined ? {} : { trialDays }),
    });
    res.status(201).json({ data: session });
  });

  /**
   * What the success page should do while it waits.
   *
   * `billing:read` rather than `billing:write`: the customer who paid may not
   * be the owner, and leaving them on a spinner because they cannot poll is a
   * worse failure than the one this endpoint exists to prevent.
   */
  router.get('/billing/checkout/status', ...read, async (req: Request, res: Response) => {
    const elapsed = Number.parseInt(String(req.query['elapsedMs'] ?? '0'), 10);

    res.json({
      data: await billing.checkoutStatus(requireScope(), {
        elapsedMs: Number.isFinite(elapsed) ? elapsed : 0,
      }),
    });
  });

  router.post('/billing/portal', ...write, async (_req: Request, res: Response) => {
    res.json({ data: await billing.portalSession(requireScope()) });
  });

  /**
   * The downgrade pre-check.
   *
   * `billing:read`, because it changes nothing and the UI calls it to decide
   * whether to show a confirm dialog or a "delete these first" list.
   */
  router.get('/billing/plan-change/preview', ...read, async (req: Request, res: Response) => {
    const planCode = String(req.query['planCode'] ?? '');
    if (planCode === '') throw new AppError('validation_failed', 'planCode is required', 400);

    res.json({ data: await billing.planChangePreview(requireScope(), { planCode }) });
  });

  router.post('/billing/plan', ...write, async (req: Request, res: Response) => {
    const parsed = planChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('validation_failed', 'Invalid plan change', 400, details(parsed.error));
    }

    res.json({ data: await billing.changePlan(requireScope(), parsed.data) });
  });

  router.post('/billing/cancel', ...write, async (req: Request, res: Response) => {
    const parsed = cancelSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError('validation_failed', 'Invalid cancellation', 400, details(parsed.error));
    }

    res.json({ data: await billing.cancel(requireScope(), parsed.data) });
  });

  return router;
}

function details(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}
