import { Router, type Request, type Response } from 'express';
import { pingDatabase, type DatabasePool } from '@relayd/db';
import { pingRedis, type RedisConnection } from '@relayd/queue';
import type { Logger } from '@relayd/logger';

export interface HealthDependencies {
  pool: DatabasePool;
  redis: RedisConnection;
  logger: Logger;
}

/**
 * Three checks, kept distinct because conflating them causes bad restarts
 * (docs/10).
 *
 *   /health  process alive only, never touches a dependency — Docker
 *            HEALTHCHECK
 *   /ready   Postgres SELECT 1 and Redis PING — the load balancer target
 *            group
 *
 * /health must stay dependency-free. If it checked Postgres and Postgres
 * hiccuped, every task would fail its health check at once and a ten-second
 * blip would become a full outage.
 *
 * docs/10 also lists a migration-version check on /ready and a /health/deep
 * endpoint for monitoring. Phase 0 scopes /ready to Postgres and Redis, per
 * the checklist; both arrive with the infrastructure that needs them.
 */
export function healthRoutes(deps: HealthDependencies): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ data: { status: 'ok' } });
  });

  router.get('/ready', async (_req: Request, res: Response) => {
    const checks = await Promise.allSettled([pingDatabase(deps.pool), pingRedis(deps.redis)]);
    const [postgres, redis] = checks;

    const result = {
      postgres: postgres?.status === 'fulfilled',
      redis: redis?.status === 'fulfilled',
    };
    const ready = result.postgres && result.redis;

    if (!ready) {
      for (const check of checks) {
        if (check.status === 'rejected') {
          deps.logger.warn({ err: check.reason }, 'readiness check failed');
        }
      }
    }

    res.status(ready ? 200 : 503).json({ data: { status: ready ? 'ready' : 'not_ready', ...result } });
  });

  return router;
}
