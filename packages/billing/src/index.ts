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

export {
  usageIdempotencyKey,
  advanceWatermark,
  foldLedger,
  aggregationCutoff,
  aggregateUsage,
  aggregateUsageFully,
  compareUsageIds,
  overageFor,
  overageHardCap,
  isOverHardCap,
  reconcileVerdict,
  reconcileAggregate,
  AGGREGATION_LAG_MS,
  AGGREGATION_PAGE,
  OVERAGE_HARD_CAP_MULTIPLIER,
} from './metering/meter.js';
export type {
  AggregatePort,
  AggregateKey,
  AggregateRow,
  AggregationResult,
  LedgerRow,
  Fold,
  ReconcileVerdict,
  ReconcileReport,
} from './metering/meter.js';

export { canUseFeature, checkUsage, statusForDenial } from './entitlements/gate.js';
export type { Decision, DenialCode, Grant, WorkspaceBillingState } from './entitlements/gate.js';

export { rebuildEntitlements, rebuildMany } from './entitlements/rebuild.js';
export type { RebuildPort, RebuildResult, RebuildAllResult } from './entitlements/rebuild.js';

export {
  classifyChange,
  planChangeEffect,
  precheckDowngrade,
  changePlan,
  cancelSubscription,
} from './plans/change.js';
export type {
  ChangeDirection,
  PlanChangeEffect,
  PlanChangePort,
  ChangeResult,
  ChangeFailure,
  CancelResult,
  DowngradeConflict,
  PrecheckResult,
  Interval,
} from './plans/change.js';
