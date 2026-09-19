import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '@relayd/types';
import type { GlobalMembershipRepository } from '@relayd/db';
import { requireScope, requirePrincipal } from '../context.js';
import { authenticate, requirePermission, requireWorkspace } from '../middleware/authorize.js';
import { refuseApiKey } from '../middleware/api-key-auth.js';
import { WEBHOOK_EVENT_TYPES, type OutboundWebhookService } from '../services/outbound-webhooks.js';
import type { TokenService } from '../services/tokens.js';

/**
 * Outbound webhook endpoints (BUILD-PLAN Phase 9).
 *
 * `apikey:write` gates these, the same permission API keys use, because they
 * are the same thing from the customer's point of view: the credentials and
 * subscriptions that let something outside the product act on it.
 *
 * Every route refuses an API key, for the same reason key management does. A
 * key that could subscribe an endpoint could exfiltrate every event in the
 * workspace to a host of its choosing, and revoking the key would not
 * un-subscribe the endpoint.
 */

export interface OutboundWebhookRouterOptions {
  webhooks: OutboundWebhookService;
  tokens: TokenService;
  memberships: GlobalMembershipRepository;
}

const eventsSchema = z
  .array(z.union([z.enum(WEBHOOK_EVENT_TYPES), z.literal('*')]))
  .min(1)
  .max(WEBHOOK_EVENT_TYPES.length + 1);

const createSchema = z.object({
  url: z.string().url().max(2_048),
  events: eventsSchema,
  description: z.string().max(200).optional(),
});

const updateSchema = z.object({
  url: z.string().url().max(2_048).optional(),
  events: eventsSchema.optional(),
  description: z.string().max(200).nullable().optional(),
  /**
   * Only the two a customer owns. `failing` and `disabled` are ours to set
   * from delivery outcomes, and letting a customer write them would let them
   * clear a failure count without fixing anything.
   */
  status: z.enum(['active', 'paused']).optional(),
});

export function outboundWebhookRoutes(options: OutboundWebhookRouterOptions): Router {
  const router = Router();
  const { webhooks } = options;

  const manage = [
    authenticate(options.tokens),
    requireWorkspace({ memberships: options.memberships }),
    refuseApiKey(),
    requirePermission('apikey:write'),
  ] as const;

  const id = (req: Request): string => String(req.params['id'] ?? '');

  router.get('/webhook-endpoints/event-types', ...manage, (_req: Request, res: Response) => {
    res.json({ data: { eventTypes: webhooks.eventTypes() } });
  });

  router.get('/webhook-endpoints', ...manage, async (_req: Request, res: Response) => {
    res.json({ data: await webhooks.list(requireScope()) });
  });

  /**
   * Creates an endpoint. 201 with the signing secret, exactly once.
   *
   * `Cache-Control: no-store`, for the same reason the API key route sets it:
   * a one-time reveal that a proxy keeps a copy of is not a one-time reveal.
   */
  router.post('/webhook-endpoints', ...manage, async (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw validationError(parsed.error);

    const { description, ...rest } = parsed.data;

    const result = await webhooks.create(requireScope(), {
      ...rest,
      ...(description === undefined ? {} : { description }),
      actor: { userId: requirePrincipal().userId },
    });

    res.set('Cache-Control', 'no-store');
    res.status(201).json({ data: { ...result.endpoint, secretShownOnce: result.secretShownOnce } });
  });

  router.patch('/webhook-endpoints/:id', ...manage, async (req: Request, res: Response) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw validationError(parsed.error);

    const { url, events, description, status } = parsed.data;

    res.json({
      data: await webhooks.update(requireScope(), {
        endpointId: id(req),
        ...(url === undefined ? {} : { url }),
        ...(events === undefined ? {} : { events }),
        ...(description === undefined ? {} : { description }),
        ...(status === undefined ? {} : { status }),
        actor: { userId: requirePrincipal().userId },
      }),
    });
  });

  router.post('/webhook-endpoints/:id/rotate-secret', ...manage, async (req: Request, res: Response) => {
    const result = await webhooks.rotateSecret(requireScope(), {
      endpointId: id(req),
      actor: { userId: requirePrincipal().userId },
    });

    res.set('Cache-Control', 'no-store');
    res.json({ data: { ...result.endpoint, secretShownOnce: result.secretShownOnce } });
  });

  router.delete('/webhook-endpoints/:id', ...manage, async (req: Request, res: Response) => {
    await webhooks.remove(requireScope(), {
      endpointId: id(req),
      actor: { userId: requirePrincipal().userId },
    });

    res.status(204).end();
  });

  /** The delivery log, which is what an integrator reads when nothing arrived. */
  router.get('/webhook-endpoints/:id/deliveries', ...manage, async (req: Request, res: Response) => {
    const limit = Number.parseInt(String(req.query['limit'] ?? ''), 10);

    res.json({
      data: await webhooks.deliveries(requireScope(), {
        endpointId: id(req),
        ...(Number.isFinite(limit) ? { limit } : {}),
      }),
    });
  });

  return router;
}

function validationError(error: z.ZodError): AppError {
  return new AppError(
    'validation_failed',
    'Invalid webhook endpoint',
    400,
    error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}
