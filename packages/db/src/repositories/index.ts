// Repositories: the only code that touches Drizzle (CLAUDE.md section 6.1).
//
// Tenant-scoped repositories take a WorkspaceScope as their first parameter,
// without exception. The cross-tenant ones live under global/ and each
// documents why it cannot be scoped.
export type { Executor, Transaction } from './executor.js';

export { WorkspaceRepository } from './workspaces.js';
export type { WorkspaceRow, CreateWorkspaceInput } from './workspaces.js';

export { WorkspaceMemberRepository } from './workspace-members.js';
export type { MemberRow, CreateMemberInput, WorkspaceRole } from './workspace-members.js';

export { WorkspaceInvitationRepository } from './workspace-invitations.js';
export type {
  InvitationRow,
  CreateInvitationInput,
  InvitableRole,
} from './workspace-invitations.js';

export { AuditLogRepository } from './audit-logs.js';
export type { AuditEntry, AuditRow, ActorType } from './audit-logs.js';

// --- cross-tenant, named exceptions ---
export { UserRepository } from './global/users.js';
export type { UserRow, CreateUserInput, UserStatus } from './global/users.js';

export { SessionRepository } from './global/sessions.js';
export type { SessionRow, CreateSessionInput } from './global/sessions.js';

export {
  GlobalMembershipRepository,
  GlobalInvitationRepository,
} from './global/cross-tenant-lookups.js';
export type { MembershipSummary, PendingInvitation } from './global/cross-tenant-lookups.js';
