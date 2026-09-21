import { authEnv, baseEnv, httpEnv, parseEnv, postgresEnv, redisEnv } from '@relayd/config';
import { createPool } from '@relayd/db';
import { createLogger } from '@relayd/logger';
import { createRedisConnection } from '@relayd/queue';
import { createApp } from './app.js';
import { composeDependencies } from './composition.js';

const env = parseEnv(
  baseEnv.merge(httpEnv).merge(postgresEnv).merge(redisEnv).merge(authEnv),
);
const logger = createLogger({ name: 'api', level: env.LOG_LEVEL });

const pool = createPool({ connectionString: env.DATABASE_URL });
const redis = createRedisConnection({ url: env.REDIS_URL, maxRetriesPerRequest: 3 });

/**
 * Cookies are Secure everywhere except plain-http local development.
 *
 * Tied to NODE_ENV rather than to a flag of its own: a flag is something
 * somebody can set wrongly in production, and the one place this must never
 * be false is the one place NODE_ENV is already 'production'.
 */
const deps = composeDependencies({
  pool,
  redis,
  logger,
  jwtPrivateKey: env.JWT_PRIVATE_KEY,
  jwtPublicKey: env.JWT_PUBLIC_KEY,
  jwtKeyId: env.JWT_KEY_ID,
  accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
  refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
  appBaseUrl: env.APP_BASE_URL,
  secureCookies: env.NODE_ENV === 'production',
  revealEmailBodies: env.NODE_ENV !== 'production',
  secretsRoot: '.secrets/store',
  environmentName: env.NODE_ENV,
});

const app = createApp(deps);
const server = app.listen(env.PORT, () => {
  const mounted = Object.entries(deps)
    .filter(([key, value]) => !['pool', 'redis', 'logger'].includes(key) && value !== undefined)
    .map(([key]) => key);

  // Logged because `createApp` mounts a router only when its dependency is
  // present, so "which routers does this process actually serve" is a real
  // question with a changing answer, and a 404 is otherwise indistinguishable
  // from a bad path.
  logger.info({ port: env.PORT, mounted }, 'api listening');
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
