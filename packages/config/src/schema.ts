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
