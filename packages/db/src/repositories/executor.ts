import type { Database } from '../client.js';

/**
 * Something that can run queries: the pool-backed database, or a transaction
 * opened by `scoped()`.
 *
 * Repositories take one at construction rather than reaching for a global,
 * so a service can hand them the transaction that carries the workspace
 * scope. Every tenant-scoped read and write must run inside that transaction
 * or RLS sees no `app.workspace_id` and returns nothing (CLAUDE.md section 8).
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type Executor = Database | Transaction;
