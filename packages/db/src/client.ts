import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export type Database = NodePgDatabase<Record<string, never>>;

/**
 * Re-exported so that api, edge and worker can hold a pool without taking a
 * direct dependency on the driver. Only packages/db knows we use node-postgres.
 */
export type DatabasePool = pg.Pool;

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

/**
 * Liveness of the database from this process's pool, for the /ready probe.
 *
 * Deliberately not part of /health: docs/10 is explicit that if /health
 * checked Postgres and Postgres hiccuped, the load balancer would drain every
 * task at once and turn a ten-second blip into a full outage.
 */
export async function pingDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}

/**
 * A single, direct, never-pooled connection. The scheduler's connection, and
 * only the scheduler's.
 *
 * INVARIANTS R35: leader election takes pg_try_advisory_xact_lock inside a
 * transaction that spans the whole tick. A transaction pooler would hand the
 * connection to someone else between statements, so the lock would not mean
 * what the scheduler thinks it means and two leaders could tick at once. This
 * takes a connection string that must point at Postgres directly, never at
 * PgBouncer — which is why packages/config carries DATABASE_DIRECT_URL as a
 * separate variable from DATABASE_URL.
 *
 * A Client rather than a Pool for the same reason: one process, one
 * connection, one session, for the life of the process.
 */
export function createDirectClient(connectionString: string): pg.Client {
  return new pg.Client({ connectionString });
}

export type DirectClient = pg.Client;
