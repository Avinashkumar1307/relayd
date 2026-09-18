import { Router, type Request, type Response } from 'express';
import type { GlobalMembershipRepository } from '@relayd/db';
import { AppError } from '@relayd/types';
import type { CampaignId } from '@relayd/types';
import {
  audienceSchema,
  cloneCampaignSchema,
  createCampaignSchema,
  launchCampaignSchema,
  listCampaignsSchema,
  listRecipientsSchema,
  scheduleCampaignSchema,
  testSendSchema,
  updateCampaignSchema,
} from '@relayd/validation';
import { requireScope } from '../context.js';
import { authenticate, requirePermission, requireWorkspace } from '../middleware/authorize.js';
import { validateBody } from '../middleware/validate.js';
import type { CampaignService } from '../services/campaigns.js';
import type { TokenService } from '../services/tokens.js';

/**
 * Campaign routes.
 *
 * Two things here differ from the other resource routers, and both are
 * deliberate.
 *
 * **`campaign:launch` is not `campaign:write`.** An editor may build a
 * campaign and may not send it (docs/06). This is the one permission split in
 * the product that maps to an irreversible action, and collapsing the two is
 * the obvious simplification to make and the expensive one to undo.
 *
 * **Launch accepts an `Idempotency-Key`.** F29's trace is a double-clicked
 * launch button creating two snapshots. The guarded transition in the engine
 * already makes the second one a no-op, but a no-op that returns 409 to a
 * retried HTTP request looks like a failure to the browser. With the key, the
 * loser gets the winner's result.
 *
 * Progress reads `campaign_counters` and never counts recipients (R13). The
 * route has no way to express the `COUNT(*)` it forbids, because the service
 * exposes no method that would do one.
 */

export interface CampaignRouterOptions {
  campaigns: CampaignService;
  tokens: TokenService;
  memberships: GlobalMembershipRepository;
}

export function campaignRoutes(options: CampaignRouterOptions): Router {
  const router = Router();
  const { campaigns } = options;

  const auth = authenticate(options.tokens);
  const workspace = requireWorkspace({ memberships: options.memberships });
  const chain = [auth, workspace] as const;

  const read = requirePermission('workspace:read');
  const write = requirePermission('campaign:write');
  const launch = requirePermission('campaign:launch');

  const id = (req: Request): CampaignId => req.params['id'] as CampaignId;

  router.get('/campaigns', ...chain, read, async (req: Request, res: Response) => {
    const query = listCampaignsSchema.parse(req.query);
    res.json({ data: await campaigns.list(requireScope(), query) });
  });

  router.get('/campaigns/:id', ...chain, read, async (req: Request, res: Response) => {
    res.json({ data: await campaigns.get(requireScope(), id(req)) });
  });

  /**
   * Progress, from counters only (R13, F13).
   *
   * Three team members watching a 500k campaign poll this every five seconds.
   * As a `GROUP BY` over `campaign_recipients` that is a sequential scan every
   * 1.7 seconds, competing with the dispatcher's own writes on the same table.
   */
  router.get('/campaigns/:id/progress', ...chain, read, async (req: Request, res: Response) => {
    res.json({ data: await campaigns.progress(requireScope(), id(req)) });
  });

  router.get('/campaigns/:id/recipients', ...chain, read, async (req: Request, res: Response) => {
    const query = listRecipientsSchema.parse(req.query);
    res.json({ data: await campaigns.listRecipients(requireScope(), id(req), query) });
  });

  /**
   * The audience step's count, before a campaign exists.
   *
   * A POST rather than a GET because the selection is a body — a list of list
   * ids and segment ids — and putting it in a query string caps the wizard at
   * whatever the proxy's URL limit happens to be.
   */
  router.post(
    '/campaigns/audience-preview',
    ...chain,
    write,
    validateBody(audienceSchema),
    async (req: Request, res: Response) => {
      const { listIds } = req.body as { listIds: string[] };
      res.json({ data: await campaigns.previewAudience(requireScope(), { listIds }) });
    },
  );

  router.post(
    '/campaigns',
    ...chain,
    write,
    validateBody(createCampaignSchema),
    async (req: Request, res: Response) => {
      const result = await campaigns.create(
        requireScope(),
        req.body as Parameters<CampaignService['create']>[1],
      );

      res.status(201).json({ data: result });
    },
  );

  router.patch(
    '/campaigns/:id',
    ...chain,
    write,
    validateBody(updateCampaignSchema),
    async (req: Request, res: Response) => {
      const result = await campaigns.update(
        requireScope(),
        id(req),
        req.body as Parameters<CampaignService['update']>[2],
      );

      res.json({ data: result });
    },
  );

  router.delete('/campaigns/:id', ...chain, write, async (req: Request, res: Response) => {
    await campaigns.remove(requireScope(), id(req));
    res.status(204).end();
  });

  router.post(
    '/campaigns/:id/schedule',
    ...chain,
    // Scheduling is not launching: it can be undone, and the launch
    // permission is checked again when the scheduler picks it up.
    write,
    validateBody(scheduleCampaignSchema),
    async (req: Request, res: Response) => {
      const { scheduledAt, timezone } = req.body as { scheduledAt: Date; timezone: string };
      res.json({ data: await campaigns.schedule(requireScope(), id(req), { scheduledAt, timezone }) });
    },
  );

  router.post(
    '/campaigns/:id/launch',
    ...chain,
    launch,
    validateBody(launchCampaignSchema),
    async (req: Request, res: Response) => {
      const key = idempotencyKey(req);

      const result = await campaigns.launch(requireScope(), id(req), {
        ...(key === undefined ? {} : { idempotencyKey: key }),
      });

      // 202, not 200. The snapshot is taken but nothing has been sent, and a
      // client that treats launch as "done" will show a completed campaign
      // with a zero send count for the next several seconds.
      res.status(202).json({ data: result });
    },
  );

  // Pause, resume and cancel take `campaign:launch` rather than
  // `campaign:write`. Whoever is trusted to start a send is the person who
  // should be able to stop it — and an editor who could pause but not launch
  // could halt someone else's campaign.
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    router.post(`/campaigns/:id/${action}`, ...chain, launch, async (req: Request, res: Response) => {
      res.json({ data: await campaigns.lifecycle(requireScope(), id(req), action) });
    });
  }

  router.post(
    '/campaigns/:id/retry-failed',
    ...chain,
    launch,
    async (req: Request, res: Response) => {
      res.json({ data: await campaigns.retryFailed(requireScope(), id(req)) });
    },
  );

  router.post(
    '/campaigns/:id/clone',
    ...chain,
    write,
    validateBody(cloneCampaignSchema),
    async (req: Request, res: Response) => {
      const { name } = req.body as { name?: string };
      const result = await campaigns.clone(requireScope(), id(req), name);
      res.status(201).json({ data: result });
    },
  );

  router.post(
    '/campaigns/:id/test-send',
    ...chain,
    write,
    validateBody(testSendSchema),
    async (req: Request, res: Response) => {
      const { to } = req.body as { to: string[] };
      res.json({ data: await campaigns.testSend(requireScope(), id(req), to) });
    },
  );

  return router;
}

/**
 * The Idempotency-Key header, validated.
 *
 * Bounded and character-restricted because it becomes a unique index key. An
 * unbounded header is a way to write arbitrarily large rows, and a key with a
 * newline in it is a way to make two different requests look like one in a
 * log.
 */
function idempotencyKey(req: Request): string | undefined {
  const raw = req.get('idempotency-key');
  if (raw === undefined || raw === '') return undefined;

  if (raw.length > 255 || !/^[A-Za-z0-9_:.-]+$/u.test(raw)) {
    throw new AppError('validation_failed', 'Idempotency-Key must be 1-255 safe characters', 400);
  }

  return raw;
}
