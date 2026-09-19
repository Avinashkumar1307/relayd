import { Router, type Request, type Response } from 'express';
import { renderMetrics } from '@relayd/logger';

/**
 * The Prometheus exposition endpoint (CLAUDE.md section 2; BUILD-PLAN
 * Phase 10).
 *
 * ## Why this is not on the load balancer
 *
 * The ALB listener rules in `infra/terraform/modules/compute` route
 * `/o/* /c/* /u/* /ingest/*` to this service and `/api/*` to the api.
 * `/metrics` matches neither, so the ALB answers it with the default 404 and
 * the endpoint is reachable only from inside the VPC, on the container port.
 *
 * That matters more here than on the api. Every route this process serves is
 * unauthenticated by design — the tracking pixel, the click redirect, the
 * unsubscribe handler, the provider webhook ingest — so there is no auth
 * middleware that would have caught `/metrics` being reachable. The routing
 * *is* the boundary, and a test in
 * `packages/testing/test/terraform-policy.isolation.test.ts` asserts no
 * listener rule ever routes it.
 *
 * What it would give away is worth stating: open and click rates by route,
 * the unmatched-webhook counter, and enough timing to tell when a campaign
 * is sending. Not credentials, but a decent map.
 *
 * docs/10 says "Prometheus + Grafana only once someone owns it. Do not run a
 * Prometheus stack you have no one to maintain." This is the endpoint, not
 * the stack.
 */
export function metricsRoutes(): Router {
  const router = Router();

  router.get('/metrics', async (_request: Request, response: Response) => {
    const { body, contentType } = await renderMetrics();

    response.setHeader('Content-Type', contentType);
    // A scrape is a point-in-time read. Any cache between the scraper and
    // this process would flatten the series into a constant, which reads as
    // a system that has stopped changing rather than as a caching bug.
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).send(body);
  });

  return router;
}
