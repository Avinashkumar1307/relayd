import type { WorkspaceRole } from '@relayd/types';
import { api } from './client.js';

/**
 * Workspace, team and account endpoints (section J, part 1).
 *
 * `apps/api/src/routes/workspaces.ts` serves the workspace record, its
 * members and its invitations. It answers `{ id, name, slug, timezone, role }`
 * and nothing else, while J1 draws a created-by line, a data region, a plan
 * chip and a delete warning that counts what would be destroyed; J2a draws a
 * seat count, a name and a last-active time per member, and who sent each
 * invitation.
 *
 * Every field the frames need and the server does not send yet is optional
 * here and marked `BACKEND PENDING`, so the same page renders against the
 * preview backend (which supplies them) and the real one (which does not) —
 * degraded, never broken. The profile and session endpoints do not exist at
 * all; they are marked at their call sites too.
 */

export interface WorkspaceDetails {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  /** The caller's own role, so the UI can gate without a second request. */
  role?: WorkspaceRole | undefined;

  /** BACKEND PENDING: GET /workspaces/current — J1's "Default sender" field. */
  defaultSenderId?: string | null | undefined;
  /** BACKEND PENDING: GET /workspaces/current — J1's plan chip. */
  planName?: string | undefined;
  /** BACKEND PENDING: GET /workspaces/current — J1's "Created" row. */
  createdAt?: string | undefined;
  createdByName?: string | undefined;
  /** BACKEND PENDING: GET /workspaces/current — J1's "Data region" row. */
  dataRegion?: string | undefined;
  analyticsRetentionMonths?: number | undefined;
  /** BACKEND PENDING: GET /workspaces/current — J2a's "10 seats on Growth". */
  seatLimit?: number | undefined;
  /**
   * BACKEND PENDING: GET /workspaces/current.
   *
   * What "Delete workspace" would destroy. J1 names the numbers out loud
   * rather than saying "all your data", because a number is the only thing
   * that makes somebody stop and read.
   */
  counts?: { contacts: number; campaigns: number; providerConnections: number } | undefined;
}

export interface WorkspaceMember {
  userId: string;
  role: WorkspaceRole;
  joinedAt: string;
  /** BACKEND PENDING: GET /workspaces/current/members — J2a's Member column. */
  name?: string | undefined;
  email?: string | undefined;
  /** BACKEND PENDING: J2a's "Last active" column, already worded. */
  lastActiveLabel?: string | undefined;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: WorkspaceRole;
  expiresAt: string;
  /** BACKEND PENDING: GET /workspaces/current/invitations — J2a's "Invited by". */
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
}

export type SessionDevice = 'desktop' | 'mobile' | 'unknown';

export interface AccountSession {
  id: string;
  /** "MacBook Pro 14\"", "iPhone 15", "Unknown device". */
  device: string;
  deviceKind: SessionDevice;
  /** "Chrome 129 · macOS 15". */
  client: string;
  location: string;
  ip: string;
  lastActiveLabel: string;
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

  update: (input: { name?: string; slug?: string; timezone?: string; defaultSenderId?: string | null }) =>
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

  /** BACKEND PENDING: POST /workspaces/current/invitations/:id/resend */
  resendInvitation: (id: string) =>
    api.post<WorkspaceInvitation>(`/workspaces/current/invitations/${id}/resend`),

  /** BACKEND PENDING: POST /workspaces/current/transfer-ownership */
  transferOwnership: (userId: string) =>
    api.post<void>('/workspaces/current/transfer-ownership', { userId }),

  /** The verified senders J1 offers as the workspace default. */
  senders: () => api.get<DefaultSenderOption[]>('/senders'),
};

export const accountApi = {
  /** BACKEND PENDING: GET /me */
  profile: () => api.get<AccountProfile>('/me', undefined, { unscoped: true }),

  /** BACKEND PENDING: PATCH /me */
  updateProfile: (input: { name: string }) =>
    api.patch<AccountProfile>('/me', input, { unscoped: true }),

  /** BACKEND PENDING: POST /me/password */
  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    api.post<void>('/me/password', input, { unscoped: true }),

  /** BACKEND PENDING: GET /me/sessions */
  sessions: () => api.get<AccountSession[]>('/me/sessions', undefined, { unscoped: true }),

  /** BACKEND PENDING: DELETE /me/sessions/:id */
  revokeSession: (id: string) => api.delete<void>(`/me/sessions/${id}`, { unscoped: true }),

  /** BACKEND PENDING: DELETE /me/sessions */
  revokeOtherSessions: () => api.delete<void>('/me/sessions', { unscoped: true }),
};
