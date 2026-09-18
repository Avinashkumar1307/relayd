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

export { UserTokenRepository } from './global/user-tokens.js';
export type { UserTokenRow, IssueTokenInput, TokenPurpose } from './global/user-tokens.js';

export {
  GlobalMembershipRepository,
  GlobalInvitationRepository,
} from './global/cross-tenant-lookups.js';
export type { MembershipSummary, PendingInvitation } from './global/cross-tenant-lookups.js';

// --- audience (Phase 2) ---
export { ContactRepository } from './contacts.js';
export type {
  ContactRow,
  CreateContactInput,
  ContactPage,
  ContactStatus,
  ContactSource,
  ConsentStatus,
} from './contacts.js';

export { ContactListRepository, TagRepository } from './contact-lists.js';
export type { ListRow, TagRow } from './contact-lists.js';

export { SegmentRepository } from './segments.js';
export type { SegmentRow, CompiledPreview } from './segments.js';

export { SuppressionRepository } from './suppressions.js';
export type { SuppressionRow, SuppressionReason } from './suppressions.js';

export { ImportJobRepository, MAX_STORED_ROW_ERRORS } from './import-jobs.js';
export type { ImportJobRow, ImportStatus, RowError } from './import-jobs.js';

export { ContactImportRepository } from './contact-import.js';
export type { ImportRow, MergeResult, MergeOptions } from './contact-import.js';

export { ProviderConnectionRepository } from './providers.js';
export type { ProviderConnectionRow } from './providers.js';
export { SenderIdentityRepository, SenderAccountRepository } from './senders.js';
export type { SenderIdentityRow, SenderAccountRow } from './senders.js';
export { WebhookEventRepository } from './webhook-events.js';
export type { WebhookEventRow } from './webhook-events.js';
export { GlobalEndpointTokenRepository } from './global/endpoint-tokens.js';
export type { EndpointResolution } from './global/endpoint-tokens.js';
export { TemplateRepository } from './templates.js';
export type { TemplateRow, TemplateVersionRow } from './templates.js';
export { GlobalDeadLetterRepository } from './global/dead-letters.js';
export type { DeadLetterRow } from './global/dead-letters.js';
export { GlobalScheduledJobRepository } from './global/scheduled-jobs.js';
export type { ScheduledJobRow } from './global/scheduled-jobs.js';
