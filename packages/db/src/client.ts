import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export type Database = NodePgDatabase<Record<string, never>>;

export interface CreatePoolOptions {
  connectionString: string;
  /** Upper bound on connections held by this process. */
  max?: number;
  /** Fail fast rather than queue forever when the pool is exhausted. */
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
}

/**
 * The pooled connection used by api, edge and every single-workspace job.
 *
 * May sit behind PgBouncer in transaction mode, which is the reason workspace
 * scope is always set with SET LOCAL semantics: transaction-scoped settings
 * survive a transaction pooler handing the connection to another client
 * afterwards, and session-scoped ones do not (CLAUDE.md section 8).
 *
 * The scheduler does NOT use this. It needs a direct connection because it
 * holds a transaction-scoped advisory lock across an entire tick
 * (INVARIANTS R35).
 */
export function createPool(options: CreatePoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
  });
}

export function createDatabase(pool: pg.Pool): Database {
  return drizzle(pool);
}
