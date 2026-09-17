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
 * The same two probes as api, with the same contract.
 *
 * This is deliberately a copy rather than shared code. edge may not import
 * from apps/api (CLAUDE.md section 6.3), and the only way to share it would
 * be an Express-dependent package, which the layout in CLAUDE.md section 3
 * does not have and which would give this app a reason to grow a middleware
 * stack. Twenty-five duplicated lines is the cheaper of the two.
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
