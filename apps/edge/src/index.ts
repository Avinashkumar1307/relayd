import { baseEnv, httpEnv, parseEnv, postgresEnv, redisEnv } from '@relayd/config';
import { createPool } from '@relayd/db';
import { createLogger } from '@relayd/logger';
import { createRedisConnection } from '@relayd/queue';
import { createApp } from './app.js';

const env = parseEnv(baseEnv.merge(httpEnv).merge(postgresEnv).merge(redisEnv));
const logger = createLogger({ name: 'edge', level: env.LOG_LEVEL });

// Read-mostly: edge resolves tracking tokens and connection lookups, and
// writes through the queue rather than directly (CLAUDE.md section 3).
const pool = createPool({ connectionString: env.DATABASE_URL, max: 5 });
const redis = createRedisConnection({ url: env.REDIS_URL, maxRetriesPerRequest: 3 });

const app = createApp({ pool, redis, logger });
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'edge listening');
});

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
