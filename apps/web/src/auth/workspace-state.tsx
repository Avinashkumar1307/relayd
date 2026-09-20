import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../api/client.js';

/**
 * Whether the workspace can be written to, and why not when it cannot.
 *
 * Section K owns this. It reads the workspace's enforcement state (the
 * dunning ladder from billing, suspension from anti-abuse) and every page
 * that offers a write consults `useReadOnly()` before enabling it. The
 * banners in the shell (K1a–K1f) and the read-only chrome on K2 are both
 * driven from the same record, so there is one answer rather than twelve.
 *
 * The contract the other sections compile against:
 *   - `status` is the workspace's enforcement state, not the user's role.
 *     Permission is a separate question, answered by the guards next door.
 *   - `loading` is true only before the first answer is known. A page must
 *     not decide anything while it is true — treating "not yet known" as
 *     "writable" is how a suspended workspace gets a send button.
 *   - `useReadOnly()` is the only thing a page should normally need. It
 *     collapses the states the UI treats alike.
 *
 * Nothing here is a security control: the server rejects the write
 * (CLAUDE.md section 10 — entitlement checks are server-side only, inside
 * the transaction they gate). This just stops the UI offering an action it
 * knows will fail.
 *
 * ## Why the query key carries no workspace id
 *
 * docs/09 asks for workspace-prefixed keys, and the endpoint below is the
 * one that has no id to prefix with: `/workspaces/current` *is* the current
 * workspace, resolved from the `x-workspace-id` header the client attaches.
 * `AuthProvider` calls `queryClient.clear()` on every switch and on logout,
 * so nothing from the previous workspace can survive into the next one.
 * Reading the id here would mean `useAuth()`, and `useReadOnly()` is called
 * from page bodies that several section tests render without an
 * `AuthProvider` around them.
 */

export type WorkspaceEnforcement = 'active' | 'past_due' | 'restricted' | 'suspended';

/**
 * The non-billing conditions that raise a global banner.
 *
 * BACKEND PENDING: GET /workspaces/current does not return these yet — it
 * answers `{ id, name, slug, timezone, role }` (apps/api/src/routes/
 * workspaces.ts). Each field is optional and absent means "no banner", so
 * the shell degrades to no banner rather than to a wrong one.
 */
export interface WorkspaceAlerts {
  /** K1d — the new-account sending cap, for the first 7 days. */
  newAccountCap?: { perDay: number; endsAt: string } | undefined;
  /** K1e — a campaign auto-paused at 0.3% complaints. */
  complaintPause?: { campaignId: string; campaignName: string; rate: number } | undefined;
  /** K1f — a provider connection whose credentials were rejected. */
  providerFailure?: { connectionId: string; label: string } | undefined;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  role?: string | undefined;
  /** BACKEND PENDING: the enforcement state. Absent is read as `active`. */
  status?: WorkspaceEnforcement | undefined;
  alerts?: WorkspaceAlerts | undefined;
  /** How many items the "needs attention" rail holds — the bell's red dot. */
  alertCount?: number | undefined;
}

export interface WorkspaceStatus {
  status: WorkspaceEnforcement;
  loading: boolean;
}

export const WORKSPACE_QUERY_KEY = ['workspace', 'current'] as const;

/** The whole record, for the shell. Pages want `useReadOnly()` instead. */
export function useWorkspaceRecord(): UseQueryResult<WorkspaceRecord> {
  return useQuery({
    queryKey: WORKSPACE_QUERY_KEY,
    queryFn: () => api.get<WorkspaceRecord>('/workspaces/current'),
    staleTime: 60_000,
    // A failed read must not leave every page's buttons disabled forever;
    // an unknown state is read as `active` below and the server still says
    // no. Retrying would only delay the page.
    retry: false,
  });
}

export function useWorkspaceStatus(): WorkspaceStatus {
  const query = useWorkspaceRecord();
  return { status: query.data?.status ?? 'active', loading: query.isPending };
}

/**
 * Suspended is the one state that turns every write off at once (K2).
 * `past_due` and `restricted` block launches, which is a decision the launch
 * path makes with the entitlement it is holding, not one the whole UI makes.
 */
export function useReadOnly(): boolean {
  return useWorkspaceStatus().status === 'suspended';
}
