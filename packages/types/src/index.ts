// @relayd/types — shared DTOs and branded ids.
export type { Brand } from './brand.js';
export type {
  WorkspaceId,
  UserId,
  CampaignId,
  RecipientId,
  SessionId,
  WorkspaceMemberId,
  WorkspaceInvitationId,
  ContactId,
  ContactListId,
  TagId,
  SegmentId,
  SuppressionId,
  ImportJobId,
} from './ids.js';
export { ERROR_CODES, AppError, ValidationError, NotFoundError, ConflictError, EntitlementError } from './errors.js';
export type { ErrorCode, ErrorDetail } from './errors.js';
export {
  PERMISSIONS,
  WORKSPACE_ROLES,
  can,
  permissionsFor,
  canApiKeyHold,
  partitionApiKeyScopes,
} from './permissions.js';
export type { Permission, WorkspaceRole } from './permissions.js';
