import type { WorkspaceRole } from '@relayd/types';
import { api } from './client.js';

/**
 * Workspace, team and account endpoints (section J, part 1).
 *
 * `apps/api/src/routes/workspaces.ts` serves the workspace record, its members
 * and its invitations; `routes/me.ts` serves the account half. The types below
 * are the contract between the two, asserted end to end by
 * `apps/api/test/contract-identity.test.ts` — anything declared required here
 * is a key that test proves the API sends.
 *
 * What is still missing is missing for a reason and says which: a field the
 * `workspaces` table has no column for, or one that belongs to a domain this
 * page does not own (the plan and the seat count are billing's; the delete
 * counts are the audience's, the campaigns' and the providers'). Each of those
 * is optional and named, and every page reads absent as "do not draw that
 * row" rather than drawing an empty one.
 */

export interface WorkspaceDetails {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  /** The caller's own role, so the UI can gate without a second request. */
  role?: WorkspaceRole | undefined;
  /** ISO 8601. J1's "Created" row. */
  createdAt?: string | undefined;
  /** The owner's name. Absent when that account is gone. */
  createdByName?: string | undefined;

  /**
   * BACKEND PENDING — field, not endpoint: `GET /workspaces/current` exists
   * and serves everything above. `workspaces` has no `default_sender_id`
   * column (packages/db/src/schema/identity.ts), so J1's "Default sender"
   * picker cannot be persisted without a migration.
   */
  defaultSenderId?: string | null | undefined;
  /** BACKEND PENDING — field: J1's plan chip. Billing owns the plan name. */
  planName?: string | undefined;
  /** BACKEND PENDING — field: J1's "Data region" row. No column for either. */
  dataRegion?: string | undefined;
  analyticsRetentionMonths?: number | undefined;
  /** BACKEND PENDING — field: J2a's "10 seats on Growth". A plan entitlement. */
  seatLimit?: number | undefined;
  /**
   * BACKEND PENDING — field: what "Delete workspace" would destroy.
   *
   * J1 names the numbers out loud rather than saying "all your data", because
   * a number is the only thing that makes somebody stop and read. Counting
   * them spans three other domains' tables.
   */
  counts?: { contacts: number; campaigns: number; providerConnections: number } | undefined;
}

export interface WorkspaceMember {
  userId: string;
  role: WorkspaceRole;
  joinedAt: string;
  /** J2a's Member column. The id when the account behind it is gone. */
  name: string;
  /** J2a's Email column. Empty when the account behind it is gone. */
  email: string;
  /**
   * J2a's "Last active", rendered by the server against its own clock.
   * Absent for a member who has never signed in; the column draws an em dash.
   */
  lastActiveLabel?: string | undefined;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: WorkspaceRole;
  expiresAt: string;
  /** J2a's "Invited by". Absent when the inviter's account is gone. */
  invitedByName?: string | undefined;
}

/** A sender identity, as J1's "Default sender" picker lists it. */
export interface DefaultSenderOption {
  id: string;
  fromName: string;
  fromEmail: string;
  status: string;
}

export interface AccountProfile {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  /** When the account was created. ISO 8601. */
  createdAt?: string | undefined;
}

export type SessionDevice = 'desktop' | 'mobile' | 'unknown';

export interface AccountSession {
  id: string;
  /** "MacBook Pro 14\"", "iPhone 15", "Unknown device". */
  device: string;
  deviceKind: SessionDevice;
  /** "Chrome 129 · macOS 15". */
  client: string;
  /**
   * City and country, when the server can say.
   *
   * It cannot today — nothing in the system does GeoIP — so the real API
   * sends an empty string and this line renders as nothing above the IP,
   * rather than as a fabricated place.
   */
  location: string;
  ip: string;
  /** "Active now", "2 hours ago". Rendered server-side, against its clock. */
  lastActiveLabel: string;
  /** The instant behind the label, for a client that wants to reformat. */
  lastActiveAt?: string | undefined;
  current: boolean;
}

/** Query keys, prefixed with the workspace id (docs/09). */
export const workspaceKeys = {
  all: (workspaceId: string) => ['workspace-settings', workspaceId] as const,
  details: (workspaceId: string) => ['workspace-settings', workspaceId, 'details'] as const,
  members: (workspaceId: string) => ['workspace-settings', workspaceId, 'members'] as const,
  invitations: (workspaceId: string) => ['workspace-settings', workspaceId, 'invitations'] as const,
  senders: (workspaceId: string) => ['workspace-settings', workspaceId, 'senders'] as const,
  /** The account is the person, not the workspace, so this key is unprefixed. */
  profile: () => ['account', 'profile'] as const,
  sessions: () => ['account', 'sessions'] as const,
};

export const workspaceApi = {
  details: () => api.get<WorkspaceDetails>('/workspaces/current'),

  /**
   * J1's Save.
   *
   * Name and timezone only, because `updateWorkspaceSchema` on the server is
   * `.strict()` and a body carrying anything else is a 400 that loses the two
   * fields that would have saved.
   *
   * BACKEND PENDING — field: `slug`. The column exists and is editable in the
   * frame, but `uq_workspaces_slug` is global while the `workspaces` RLS
   * policy is not, so an update cannot see the row it would collide with and
   * a taken slug would surface as a constraint violation. Answering it
   * properly needs a cross-tenant lookup in
   * `packages/db/repositories/global/`.
   *
   * BACKEND PENDING — field: `defaultSenderId`. No column; see
   * `WorkspaceDetails`.
   */
  update: (input: { name?: string; timezone?: string }) =>
    api.patch<WorkspaceDetails>('/workspaces/current', input),

  remove: () => api.delete<void>('/workspaces/current'),

  members: () => api.get<WorkspaceMember[]>('/workspaces/current/members'),

  changeRole: (userId: string, role: WorkspaceRole) =>
    api.patch<WorkspaceMember>(`/workspaces/current/members/${userId}`, { role }),

  removeMember: (userId: string) => api.delete<void>(`/workspaces/current/members/${userId}`),

  invitations: () => api.get<WorkspaceInvitation[]>('/workspaces/current/invitations'),

  invite: (input: { email: string; role: Exclude<WorkspaceRole, 'owner'> }) =>
    api.post<WorkspaceInvitation>('/workspaces/current/invitations', input),

  revokeInvitation: (id: string) => api.delete<void>(`/workspaces/current/invitations/${id}`),

  /**
   * Sends the invitation again with a fresh link and a fresh expiry.
   *
   * At most once an hour per invitation: a second call inside that window is
   * a 429, which J2 should show as "just sent — try again shortly" rather
   * than as a failure.
   */
  resendInvitation: (id: string) =>
    api.post<WorkspaceInvitation>(`/workspaces/current/invitations/${id}/resend`),

  /** Owner-only. The caller becomes an Admin in the same transaction. */
  transferOwnership: (userId: string) =>
    api.post<void>('/workspaces/current/transfer-ownership', { userId }),

  /** The verified senders J1 offers as the workspace default. */
  senders: () => api.get<DefaultSenderOption[]>('/senders'),
};

/**
 * The signed-in person, across every workspace (J5).
 *
 * Every call is `unscoped`: none of this belongs to a workspace, and the
 * server's `/me` router has no workspace middleware for the same reason. A
 * suspended workspace must not stop somebody changing their own password.
 */
export const accountApi = {
  profile: () => api.get<AccountProfile>('/me', undefined, { unscoped: true }),

  updateProfile: (input: { name: string }) =>
    api.patch<AccountProfile>('/me', input, { unscoped: true }),

  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    api.post<void>('/me/password', input, { unscoped: true }),

  /**
   * Starts an email change. The address does not move until the link sent to
   * it is opened, so this answers `pending`, never the new profile.
   */
  changeEmail: (input: { newEmail: string; currentPassword: string }) =>
    api.post<{ pending: true; email: string }>('/me/email-change', input, { unscoped: true }),

  sessions: () => api.get<AccountSession[]>('/me/sessions', undefined, { unscoped: true }),

  revokeSession: (id: string) => api.delete<void>(`/me/sessions/${id}`, { unscoped: true }),

  revokeOtherSessions: () => api.delete<void>('/me/sessions', { unscoped: true }),
};
