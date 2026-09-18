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
