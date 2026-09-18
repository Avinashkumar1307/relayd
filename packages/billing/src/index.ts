// @relayd/billing — plans, features, entitlements, Stripe adapter, metering.

export {
  FEATURES,
  FEATURE_DEFINITIONS,
  PLANS,
  PLAN_DEFINITIONS,
  planByCode,
  selfServePlans,
  isUpgrade,
  isDowngrade,
  limitFor,
  flagFor,
} from './plans/catalogue.js';
export type { FeatureKey, FeatureKind, FeatureDefinition, PlanCode, PlanDefinition } from './plans/catalogue.js';

export {
  projectEntitlements,
  entitlementsDiffer,
  overLimitOnPlan,
  grantsEntitlements,
  ENTITLING_STATUSES,
} from './entitlements/project.js';
export type { EntitlementRow, ActiveSubscription } from './entitlements/project.js';

export { BillingProviderError } from './port.js';
export type {
  BillingProviderAdapter,
  NormalisedBillingEvent,
  ObjectType,
  ProviderCustomer,
  ProviderSubscription,
  ProviderInvoice,
  CheckoutSession,
} from './port.js';

export {
  ingestBillingEvent,
  isDueForRefetch,
  isNewerThanStored,
  refetchBackoffMs,
  REFETCH_COOLDOWN_MS,
  MAX_REFETCH_BACKOFF_MS,
} from './webhooks/ingest.js';
export type { IngestPort, IngestResult, DirtyObject } from './webhooks/ingest.js';

export {
  startCheckout,
  successPollPlan,
  SUCCESS_POLL_INTERVAL_MS,
  SUCCESS_FALLBACK_AFTER_MS,
  SUCCESS_GIVE_UP_AFTER_MS,
} from './checkout/checkout.js';
export type { CheckoutPort, CheckoutResult, CheckoutFailure, StartCheckoutInput } from './checkout/checkout.js';
