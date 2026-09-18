// Drizzle table definitions. Tables arrive with the phase that owns them:
// identity in Phase 1, audience in Phase 2, campaigns in Phase 6, billing in
// Phase 8. Phase 0 ships the runner, not the schema.
export { citext, bytea, inet } from './column-types.js';
export {
  users,
  workspaces,
  workspaceMembers,
  workspaceInvitations,
  sessions,
  auditLogs,
  userTokens,
} from './identity.js';
export {
  contacts,
  contactLists,
  contactListMembers,
  tags,
  contactTags,
  segments,
  suppressions,
  importJobs,
  importRowErrors,
} from './audience.js';
export {
  providerConnections,
  senderIdentities,
  senderAccounts,
  providerWebhookEvents,
} from './providers.js';
export type {
  ProviderType,
  ConnectionStatus,
  SenderStatus,
} from './providers.js';
export { templates, templateVersions } from './templates.js';
