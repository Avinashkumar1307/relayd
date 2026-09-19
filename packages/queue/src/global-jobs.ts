import type { QueueName } from './queues.js';

/**
 * The cross-tenant job allowlist (CLAUDE.md section 8; review finding F20).
 *
 * F20: "Workers connect with BYPASSRLS, so the four-layer isolation story
 * reduces to one layer — application code — in the least-reviewed part of the
 * system."
 *
 * The fix it asks for is this list. Two database roles exist: `relayd_app`,
 * which RLS applies to, and `relayd_global`, which bypasses it. Every job
 * runs as `relayd_app` and sets `app.workspace_id` from its payload, except
 * the ones named here.
 *
 * ## Why a list and not a flag on each job
 *
 * A boolean on a job definition is set by whoever is writing that job, at the
 * moment they are frustrated that their query returns nothing. A list in its
 * own file is a diff that says "this job can now read every customer's data",
 * which is a different conversation in review.
 *
 * ## The bar for being on it
 *
 * The job's *purpose* is cross-tenant, not merely its convenience. A job that
 * processes many workspaces one at a time is not cross-tenant — it should
 * open a scoped transaction per workspace, which is both safer and what the
 * RLS policies are written for. Only work that must see all tenants *at once*
 * to be correct belongs here.
 */
export const GLOBAL_JOB_TYPES: readonly QueueName[] = [
  // Creates next week's `email_events` and `usage_records` partitions. A
  // partition is not a tenant's object; there is no workspace to scope to.
  'partition-maintenance',

  // Compares every workspace's local billing state with Stripe and emits the
  // divergence metric (R19). The number it produces is the count across all
  // tenants, which cannot be computed one scoped transaction at a time.
  'billing-reconcile',

  // Complaint-rate monitoring and the enforcement ladder (docs/06). It has to
  // rank workspaces against each other and sweep everything under
  // enforcement; a per-workspace scope would need a list of workspaces to
  // iterate, which is itself the cross-tenant read.
  'enforcement-sweep',
];

/**
 * Whether this job type may connect as `relayd_global`.
 *
 * Called at the point the connection is chosen, so a job type that is not on
 * the list gets an RLS-enforced connection whatever it expected. The failure
 * mode of getting this wrong is then an empty result rather than a
 * cross-tenant read, which is the right way round.
 */
export function isGlobalJob(name: string): boolean {
  return (GLOBAL_JOB_TYPES as readonly string[]).includes(name);
}
