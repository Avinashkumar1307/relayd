import { z } from 'zod';

const postgresUrl = z
  .string()
  .url()
  .refine(
    (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
    { message: 'must be a postgres:// or postgresql:// URL' },
  );

const redisUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'), {
    message: 'must be a redis:// or rediss:// URL',
  });

/** Every process needs these. */
export const baseEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});

/** Processes that listen for HTTP: api, edge. */
export const httpEnv = z.object({
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),
});

/**
 * Pooled Postgres. May sit behind PgBouncer in transaction mode, which is why
 * scope is always set with `SET LOCAL` (CLAUDE.md section 8, INVARIANTS R36).
 */
export const postgresEnv = z.object({
  DATABASE_URL: postgresUrl,
});

/**
 * Direct, never-pooled Postgres. The scheduler holds a transaction-scoped
 * advisory lock across a whole tick, which cannot survive a transaction
 * pooler handing the connection to someone else (INVARIANTS R35).
 */
export const postgresDirectEnv = z.object({
  DATABASE_DIRECT_URL: postgresUrl,
});

/** Redis is transport and cache only, never a system of record (CLAUDE.md section 9). */
export const redisEnv = z.object({
  REDIS_URL: redisUrl,
});

/**
 * Selects which process the single shared image starts as
 * (BUILD-PLAN Phase 0: "CMD selected by env var per process type").
 */
export const processTypeEnv = z.object({
  RELAYD_PROCESS: z.enum(['api', 'edge', 'worker', 'scheduler']),
});

/** Which worker entrypoint to run when RELAYD_PROCESS=worker. */
export const workerEntrypointEnv = z.object({
  RELAYD_WORKER_ENTRYPOINT: z.enum(['send', 'campaign', 'events', 'billing', 'io']),
});

/**
 * Set by every CI provider. Used to decide whether a missing dependency is a
 * skip or a failure: locally, an absent Docker daemon skips the integration
 * suite with a message; in CI it must fail, because a silently skipped
 * integration suite is how coverage rots.
 */
export const ciEnv = z.object({
  CI: z
    .string()
    .optional()
    .transform((value) => value === 'true' || value === '1'),
});

/**
 * Access-token signing. RS256 with a key id for rotation (docs/06 s15).
 *
 * Keys are supplied as PEM, never generated at boot: a key generated per
 * process means a token issued by one api task is rejected by the next, and
 * the failure looks like random logouts under load rather than a
 * misconfiguration.
 */
export const authEnv = z.object({
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  /** Identifies which key signed a token, so keys can be rotated. */
  JWT_KEY_ID: z.string().min(1).default('k1'),
  /** Short by design: 15 minutes, per docs/06. */
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  /** 30 days, rotated on every use. */
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** Public origin, used to build links in verification and invite emails. */
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
});
