import type { NextFunction, Request, Response } from 'express';
import { httpRequestDuration, httpRequestsTotal } from '@relayd/logger';

/**
 * HTTP metrics (docs/10 "Observability"; alarms on p99 latency and 5xx rate).
 *
 * Duplicated from `apps/api` rather than shared through a package, matching
 * what `request-id.ts` already does. The alternative is putting Express
 * middleware in `packages/logger`, which would make every consumer of the
 * logger — including the worker and the scheduler, which serve no HTTP —
 * depend on Express.
 *
 * ## The route label
 *
 * `route` is the matched Express route *pattern*, never `req.path`. On edge
 * this matters more than anywhere else: every single request carries a
 * token — `/o/<token>.gif`, `/c/<token>` — so labelling by path would mint
 * one series per tracked open, which is the highest-volume event in the
 * whole system.
 * Prometheus does not reject that, it just consumes memory until something
 * else breaks, and the cause is several steps away from the symptom.
 *
 * Unmatched requests collapse to a single `unmatched` label for the same
 * reason — a scanner walking random URLs is precisely the traffic that would
 * otherwise mint the most series.
 */

/** The label for a request that matched no route. */
export const UNMATCHED_ROUTE = 'unmatched';

export function routeLabel(request: Request): string {
  // `req.route` is only set once a handler matched. `baseUrl` carries the
  // router's mount path, which is where `/api/v1` lives — without it every
  // router's `/` would collapse into one series.
  const route = (request as Request & { route?: { path?: string } }).route;

  if (route?.path === undefined) return UNMATCHED_ROUTE;
  return `${request.baseUrl}${route.path}` || '/';
}

/**
 * Buckets a status code to `2xx`, `4xx`, `5xx`.
 *
 * The exact code is in the logs. As a metric label it triples the series
 * count to answer a question nobody alarms on — every alarm in docs/10 is
 * phrased as a class, and `5xx rate > 1%` is a ratio over exactly this.
 */
export function statusClass(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

export function metrics(process_: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();

    // `finish` fires when the response is fully written. `close` catches the
    // client that hung up mid-response — without it, an abandoned request is
    // simply absent from the metrics, which makes a timing-out endpoint look
    // like an endpoint nobody calls.
    let recorded = false;

    const record = (): void => {
      if (recorded) return;
      recorded = true;

      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const labels = {
        method: request.method,
        route: routeLabel(request),
        status: statusClass(response.statusCode),
        process: process_,
      };

      httpRequestDuration.observe(labels, seconds);
      httpRequestsTotal.inc(labels);
    };

    response.once('finish', record);
    response.once('close', record);

    next();
  };
}
