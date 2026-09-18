import { Router, type Request, type Response } from 'express';
import type { GlobalMembershipRepository } from '@relayd/db';
import type { CampaignId } from '@relayd/types';
import { requireScope } from '../context.js';
import { authenticate, requirePermission, requireWorkspace } from '../middleware/authorize.js';
import { toCsv, type AnalyticsService } from '../services/analytics.js';
import type { TokenService } from '../services/tokens.js';

/**
 * Analytics routes.
 *
 * All reads, all `workspace:read`. A viewer who can see campaigns but not
 * their numbers would be looking at half a report, and there is no
 * `analytics:read` in the permission matrix for the same reason.
 *
 * Every rate in every response carries `botFiltered` and its own confidence.
 * That is enforced in the service rather than here, because an API consumer
 * building their own dashboard must not be able to receive an open rate that
 * looks like a click rate.
 */

export interface AnalyticsRouterOptions {
  analytics: AnalyticsService;
  tokens: TokenService;
  memberships: GlobalMembershipRepository;
}

export function analyticsRoutes(options: AnalyticsRouterOptions): Router {
  const router = Router();
  const { analytics } = options;

  const auth = authenticate(options.tokens);
  const workspace = requireWorkspace({ memberships: options.memberships });
  const read = requirePermission('workspace:read');
  const chain = [auth, workspace, read] as const;

  const id = (req: Request): CampaignId => req.params['id'] as CampaignId;
  const range = (req: Request) => ({
    ...(typeof req.query['from'] === 'string' ? { from: req.query['from'] } : {}),
    ...(typeof req.query['to'] === 'string' ? { to: req.query['to'] } : {}),
  });

  router.get('/analytics/overview', ...chain, async (req: Request, res: Response) => {
    res.json({ data: await analytics.overview(requireScope(), range(req)) });
  });

  router.get('/analytics/campaigns/:id', ...chain, async (req: Request, res: Response) => {
    res.json({ data: await analytics.campaign(requireScope(), id(req)) });
  });

  router.get(
    '/analytics/campaigns/:id/timeseries',
    ...chain,
    async (req: Request, res: Response) => {
      res.json({ data: await analytics.campaignTimeseries(requireScope(), id(req), range(req)) });
    },
  );

  router.get('/analytics/campaigns/:id/links', ...chain, async (req: Request, res: Response) => {
    res.json({ data: await analytics.campaignLinks(requireScope(), id(req)) });
  });

  router.get('/analytics/campaigns/:id/devices', ...chain, async (req: Request, res: Response) => {
    res.json({ data: await analytics.campaignDevices(requireScope(), id(req)) });
  });

  router.get('/analytics/providers', ...chain, async (req: Request, res: Response) => {
    res.json({ data: await analytics.providers(requireScope(), range(req)) });
  });

  /**
   * CSV export of the timeseries.
   *
   * `Content-Disposition: attachment` with a filename, and
   * `X-Content-Type-Options: nosniff` — without the latter a browser may
   * decide a CSV whose first cell looks like markup is HTML, and render it
   * from our origin.
   */
  router.get(
    '/analytics/campaigns/:id/export.csv',
    ...chain,
    async (req: Request, res: Response) => {
      const result = await analytics.campaignTimeseries(requireScope(), id(req), range(req));

      res
        .status(200)
        .set({
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="campaign-${id(req)}-${result.from}-to-${result.to}.csv"`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        })
        .send(toCsv(result.points as unknown as Record<string, unknown>[]));
    },
  );

  return router;
}
