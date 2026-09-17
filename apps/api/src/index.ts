import { baseEnv, httpEnv, parseEnv, postgresEnv, redisEnv } from '@relayd/config';
import { createPool } from '@relayd/db';
import { createLogger } from '@relayd/logger';
import { createRedisConnection } from '@relayd/queue';
import { createApp } from './app.js';

const env = parseEnv(baseEnv.merge(httpEnv).merge(postgresEnv).merge(redisEnv));
const logger = createLogger({ name: 'api', level: env.LOG_LEVEL });

const pool = createPool({ connectionString: env.DATABASE_URL });
const redis = createRedisConnection({ url: env.REDIS_URL, maxRetriesPerRequest: 3 });

const app = createApp({ pool, redis, logger });
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'api listening');
});

/**
 * SIGTERM arrives on every deploy. Stop accepting connections, let in-flight
 * requests finish, then release the pools.
 */
const shutdown = (signal: string): void => {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    void Promise.allSettled([pool.end(), redis.quit()]).then(() => {
      process.exit(0);
    });
  });
};

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
