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
export { scheduledJobs, jobDeadLetters } from './scheduler.js';
export type { DeadLetterStatus } from './scheduler.js';
export {
  sendingPools,
  sendingPoolMembers,
  campaigns,
  campaignRecipients,
  campaignCounters,
  senderDailyUsage,
  campaignEvents,
  trackedLinks,
  emailEvents,
  usageRecords,
  DELIVERY_RANK,
} from './campaigns.js';
export type {
  CampaignStatus,
  RecipientState,
  DeliveryState,
} from './campaigns.js';
export {
  campaignStats,
  campaignDailyStats,
  providerStats,
  deviceStats,
  linkStats,
  contactEngagement,
} from './analytics.js';
export {
  plans,
  features,
  planFeatures,
  prices,
  billingCustomers,
  subscriptions,
  subscriptionItems,
  invoices,
  payments,
  refunds,
  paymentMethods,
  coupons,
  discounts,
  entitlements,
  usageAggregates,
  paymentWebhookEvents,
  billingRefetchQueue,
  billingEvents,
  billingReconciliationRuns,
} from './billing.js';
export type {
  FeatureKind,
  PriceInterval,
  BillingCustomerStatus,
  SubscriptionStatus,
  InvoiceStatus,
  PaymentStatus,
  CouponDuration,
} from './billing.js';
export {
  apiKeys,
  idempotencyKeys,
  outboundWebhookEndpoints,
  outboundWebhookDeliveries,
} from './platform.js';
export type {
  IdempotencyStatus,
  WebhookEndpointStatus,
  WebhookDeliveryStatus,
} from './platform.js';

export { workspaceSendQuota, workspaceTrust } from './abuse.js';
export { consentAttestations } from './abuse.js';
export type { ConsentSubjectKind } from './abuse.js';
export { workspaceEnforcement } from './abuse.js';
export { globalBlockedAddresses, blockedLinkDomains } from './abuse.js';
