import type { Brand } from './brand.js';

/**
 * Branded entity ids.
 *
 * UUIDv7, generated in the application (CLAUDE.md section 8) — except the
 * append-only high-volume event tables, which use BIGSERIAL for index
 * locality and are not branded here.
 *
 * Each phase adds the ids for the tables it introduces. These are the ids
 * named in CLAUDE.md section 3 plus UserId, which Phase 1 needs.
 */
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type UserId = Brand<string, 'UserId'>;
export type CampaignId = Brand<string, 'CampaignId'>;
export type RecipientId = Brand<string, 'RecipientId'>;

// Phase 1 identity tables.
export type SessionId = Brand<string, 'SessionId'>;
export type WorkspaceMemberId = Brand<string, 'WorkspaceMemberId'>;
export type WorkspaceInvitationId = Brand<string, 'WorkspaceInvitationId'>;

// Phase 2 audience tables.
export type ContactId = Brand<string, 'ContactId'>;
export type ContactListId = Brand<string, 'ContactListId'>;
export type TagId = Brand<string, 'TagId'>;
export type SegmentId = Brand<string, 'SegmentId'>;
export type SuppressionId = Brand<string, 'SuppressionId'>;
export type ImportJobId = Brand<string, 'ImportJobId'>;

// Phase 3 provider tables.
export type ProviderConnectionId = Brand<string, 'ProviderConnectionId'>;
export type SenderIdentityId = Brand<string, 'SenderIdentityId'>;
export type SenderAccountId = Brand<string, 'SenderAccountId'>;

// Phase 4 template tables.
export type TemplateId = Brand<string, 'TemplateId'>;
export type TemplateVersionId = Brand<string, 'TemplateVersionId'>;
