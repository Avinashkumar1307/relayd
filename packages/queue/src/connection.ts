import { Redis, type RedisOptions } from 'ioredis';

/**
 * Re-exported so consumers hold a connection without depending on ioredis
 * directly. Only packages/queue knows which client we use.
 */
export type RedisConnection = Redis;

/**
 * Redis is transport and cache, never a system of record (CLAUDE.md section
 * 9). Every place it would hold the only copy of something has a
 * Postgres-backed reconciler.
 *
 * One instance with keyspace prefixes (`bull:`, `rl:`, `cache:`) until
 * measured (INVARIANTS R34).
 */
export interface CreateRedisOptions {
  url: string;
  keyPrefix?: string;
  /**
   * BullMQ requires null: it blocks on commands that would otherwise be
   * retried out from under it. Non-queue clients keep a bounded retry count.
   */
  maxRetriesPerRequest?: number | null;
}

export function createRedisConnection(options: CreateRedisOptions): Redis {
  const redisOptions: RedisOptions = {
    maxRetriesPerRequest: options.maxRetriesPerRequest ?? null,
    enableReadyCheck: true,
    lazyConnect: false,
  };
  if (options.keyPrefix !== undefined) {
    redisOptions.keyPrefix = options.keyPrefix;
  }
  return new Redis(options.url, redisOptions);
}

/** Liveness of Redis, for the /ready probe. */
export async function pingRedis(connection: Redis): Promise<void> {
  const reply = await connection.ping();
  if (reply !== 'PONG') {
    throw new Error(`Unexpected PING reply from Redis: ${reply}`);
  }
}

/**
 * A connection configured the way BullMQ requires it.
 *
 * `maxRetriesPerRequest: null` is not optional: BullMQ issues blocking
 * commands (BRPOPLPUSH and friends) that ioredis would otherwise abandon
 * mid-wait, which surfaces as jobs that appear to vanish.
 *
 * The `bull:` key prefix is the queue's share of the single Redis instance
 * (INVARIANTS R34: one instance with keyspace prefixes until measured).
 */
export function createBullConnection(url: string): RedisConnection {
  return createRedisConnection({
    url,
    keyPrefix: 'bull:',
    maxRetriesPerRequest: null,
  });
}
