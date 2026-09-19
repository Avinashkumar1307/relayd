import { Router, type Request, type Response } from 'express';
import { renderMetrics } from '@relayd/logger';

/**
 * The Prometheus exposition endpoint (CLAUDE.md section 2; BUILD-PLAN
 * Phase 10).
 *
 * ## Why this is not on the load balancer
 *
 * The ALB listener rules in `infra/terraform/modules/compute` route `/api/*`
 * to this service and `/o/* /c/* /u/* /ingest/*` to edge. `/metrics` matches
 * neither, so the ALB answers it with the default 404 and the endpoint is
 * reachable only from inside the VPC, on the container port.
 *
 * That is the whole access control, and it is deliberate rather than
 * accidental: an exposition endpoint is a map of the system — route names,
 * queue names, error rates, deploy timing. A test in
 * `packages/testing/test/terraform-policy.isolation.test.ts` asserts no
 * listener rule ever routes it, because the failure mode of getting this
 * wrong is silent and permanent.
 *
 * ## Why it is not under /api/v1
 *
 * Everything under `/api/v1` is authenticated and would need an exemption
 * here, and an exemption in the auth middleware is a worse thing to own than
 * a route the router never exposes. It also keeps the path where every
 * scraper expects to find it.
 *
 * docs/10 says "Prometheus + Grafana only once someone owns it. Do not run a
 * Prometheus stack you have no one to maintain." This is the endpoint, not
 * the stack: nothing scrapes it until somebody decides to, and in the
 * meantime it costs one route and is what makes `/health/deep` and a local
 * `curl` useful during an incident.
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
