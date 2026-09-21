import { sql } from 'drizzle-orm';
import type { Brand, WorkspaceId } from '@relayd/types';
import type { Database } from './client.js';

/**
 * Proof that a caller has established which workspace it is acting for.
 *
 * Every repository method takes one of these as its FIRST parameter
 * (CLAUDE.md section 6.2). It is branded so that a bare string cannot be
 * passed in its place, and a CI reflection test in Phase 1 enumerates every
 * repository method and fails on any that lacks it. The only exceptions are
 * the explicitly named cross-tenant repositories in
 * packages/db/repositories/global/.
 */
export type WorkspaceScope = Brand<{ readonly workspaceId: WorkspaceId }, 'WorkspaceScope'>;

export function workspaceScope(workspaceId: WorkspaceId): WorkspaceScope {
  return { workspaceId } as WorkspaceScope;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Runs `fn` in a transaction with `app.workspace_id` set, so that every RLS
 * policy inside it resolves to this workspace.
 *
 * Two things about this are load-bearing.
 *
 * It opens a transaction. The setting MUST be transaction-scoped: under
 * PgBouncer transaction pooling the connection returns to the pool at commit
 * and is handed to a different tenant. A session-scoped setting would leak
 * across that boundary and hand one workspace another's rows. CLAUDE.md
 * section 12 bans bare `SET app.workspace_id` for exactly this reason, and
 * INVARIANTS R36 makes it a grep test.
 *
 * It uses set_config(..., true) rather than the literal text `SET LOCAL
 * app.workspace_id = '...'`. The two are the same thing — the third argument
 * `true` means is_local — but SET LOCAL is a utility statement that does not
 * accept bind parameters, so the literal form would require interpolating the
 * workspace id into SQL text. set_config takes it as a parameter. Same
 * semantics, no interpolation.
 */
export async function scoped<T>(
  db: Database,
  scope: WorkspaceScope,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await adoptScope(tx, scope);
    return fn(tx);
  });
}

/**
 * Points `app.workspace_id` at a workspace inside a transaction already open.
 *
 * This exists for exactly one caller: creating a workspace. That write cannot
 * happen inside a transaction already scoped to it, because the id does not
 * exist until the caller invents it — and `workspaces_tenant` is an ALL
 * policy with no WITH CHECK, so PostgreSQL applies its USING expression
 * (`id = current_setting(...)`) to the INSERT and refuses a row when the
 * setting is unset. Without this, registration could never create anything.
 *
 * It lives here rather than in the repository that needs it because R36
 * requires every write of `app.workspace_id` to be in this one file, so that
 * "what can change the tenant scope" has a single, readable answer. The
 * setting is transaction-local, so it ends with the transaction and cannot
 * follow the connection back to the pool.
 */
export async function adoptScope(
  tx: Database | Transaction,
  scope: WorkspaceScope,
): Promise<void> {
  await tx.execute(sql`select set_config('app.workspace_id', ${scope.workspaceId}, true)`);
}
