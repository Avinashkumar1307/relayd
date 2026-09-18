/**
 * The plan and feature catalogue.
 *
 * The only place in the codebase where a plan code appears in a comparison —
 * `relayd/no-plan-literals` enforces that, and this directory is its one
 * exemption. Everything else in the product asks the entitlements table what
 * a workspace may do, never which plan it is on.
 *
 * That distinction is the whole reason this file is small and the rest of
 * billing is not. A feature gate written as `plan === 'pro'` has to be found
 * and changed every time pricing moves; one written as "does this workspace
 * have `campaigns.sending_pools`" never does.
 *
 * D7: there is no free tier. If the owner adds one, the defaults are written
 * here and in CLAUDE.md section 13 — 300 sends a month, verified identity
 * required, excluded from pool routing, counted in the new-account abuse
 * ladder.
 */

/** Feature keys. Referenced by everything; defined once. */
export const FEATURES = {
  /** Metered. The billable unit: a recipient reaching `sent` for the first time. */
  emailsSent: 'emails.sent',

  contactsStored: 'contacts.stored',
  campaignsPerMonth: 'campaigns.per_month',

  sendingPools: 'campaigns.sending_pools',
  abTesting: 'campaigns.ab_testing',
  customDomains: 'tracking.custom_domains',
  apiAccess: 'api.access',
  webhooks: 'api.webhooks',

  teamSeats: 'workspace.seats',
  analyticsRetentionDays: 'analytics.retention_days',

  prioritySupport: 'support.priority',
} as const;

export type FeatureKey = (typeof FEATURES)[keyof typeof FEATURES];

export type FeatureKind = 'limit' | 'flag' | 'metered';

export interface FeatureDefinition {
  key: FeatureKey;
  name: string;
  kind: FeatureKind;
  unit?: string;
}

export const FEATURE_DEFINITIONS: readonly FeatureDefinition[] = [
  { key: FEATURES.emailsSent, name: 'Emails sent', kind: 'metered', unit: 'email' },
  { key: FEATURES.contactsStored, name: 'Contacts stored', kind: 'limit', unit: 'contact' },
  { key: FEATURES.campaignsPerMonth, name: 'Campaigns per month', kind: 'limit', unit: 'campaign' },
  { key: FEATURES.sendingPools, name: 'Sending pools', kind: 'flag' },
  { key: FEATURES.abTesting, name: 'A/B testing', kind: 'flag' },
  { key: FEATURES.customDomains, name: 'Custom tracking domain', kind: 'flag' },
  { key: FEATURES.apiAccess, name: 'API access', kind: 'flag' },
  { key: FEATURES.webhooks, name: 'Outbound webhooks', kind: 'flag' },
  { key: FEATURES.teamSeats, name: 'Team members', kind: 'limit', unit: 'seat' },
  {
    key: FEATURES.analyticsRetentionDays,
    name: 'Analytics history',
    kind: 'limit',
    unit: 'day',
  },
  { key: FEATURES.prioritySupport, name: 'Priority support', kind: 'flag' },
];

/** Plan codes. The catalogue's own vocabulary. */
export const PLANS = {
  starter: 'starter',
  growth: 'growth',
  business: 'business',
  enterprise: 'enterprise',
} as const;

export type PlanCode = (typeof PLANS)[keyof typeof PLANS];

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  description: string;
  /**
   * Ordering, and the only correct way to decide upgrade versus downgrade.
   *
   * Comparing prices would get it wrong the first time a promotion runs, and
   * an "upgrade" that is really a downgrade skips the over-limit pre-check
   * and strands a workspace above its new limits.
   */
  rank: number;
  isPublic: boolean;
  trialDays: number;
  /** `null` is unlimited, and is deliberately distinct from `0`. */
  limits: Partial<Record<FeatureKey, number | null>>;
  flags: Partial<Record<FeatureKey, boolean>>;
  /** Features that may exceed their limit and bill for the excess. */
  overage: Partial<Record<FeatureKey, { allowed: boolean; hardCapMultiple: number }>>;
}

export const PLAN_DEFINITIONS: readonly PlanDefinition[] = [
  {
    code: PLANS.starter,
    name: 'Starter',
    description: 'For a first list and a regular newsletter.',
    rank: 10,
    isPublic: true,
    trialDays: 14,
    limits: {
      [FEATURES.emailsSent]: 10_000,
      [FEATURES.contactsStored]: 2_500,
      [FEATURES.campaignsPerMonth]: 20,
      [FEATURES.teamSeats]: 2,
      [FEATURES.analyticsRetentionDays]: 90,
    },
    flags: {
      [FEATURES.sendingPools]: false,
      [FEATURES.abTesting]: false,
      [FEATURES.customDomains]: false,
      [FEATURES.apiAccess]: false,
      [FEATURES.webhooks]: false,
      [FEATURES.prioritySupport]: false,
    },
    // No overage on the entry plan. A customer who has not chosen to spend
    // more should not discover they have.
    overage: { [FEATURES.emailsSent]: { allowed: false, hardCapMultiple: 1 } },
  },
  {
    code: PLANS.growth,
    name: 'Growth',
    description: 'For a team sending regularly across several audiences.',
    rank: 20,
    isPublic: true,
    trialDays: 14,
    limits: {
      [FEATURES.emailsSent]: 100_000,
      [FEATURES.contactsStored]: 25_000,
      [FEATURES.campaignsPerMonth]: 200,
      [FEATURES.teamSeats]: 10,
      [FEATURES.analyticsRetentionDays]: 365,
    },
    flags: {
      [FEATURES.sendingPools]: true,
      [FEATURES.abTesting]: true,
      [FEATURES.customDomains]: true,
      [FEATURES.apiAccess]: true,
      [FEATURES.webhooks]: true,
      [FEATURES.prioritySupport]: false,
    },
    overage: { [FEATURES.emailsSent]: { allowed: true, hardCapMultiple: 3 } },
  },
  {
    code: PLANS.business,
    name: 'Business',
    description: 'For higher volume, multiple senders and a support commitment.',
    rank: 30,
    isPublic: true,
    trialDays: 14,
    limits: {
      [FEATURES.emailsSent]: 500_000,
      [FEATURES.contactsStored]: 150_000,
      [FEATURES.campaignsPerMonth]: null,
      [FEATURES.teamSeats]: 25,
      [FEATURES.analyticsRetentionDays]: 730,
    },
    flags: {
      [FEATURES.sendingPools]: true,
      [FEATURES.abTesting]: true,
      [FEATURES.customDomains]: true,
      [FEATURES.apiAccess]: true,
      [FEATURES.webhooks]: true,
      [FEATURES.prioritySupport]: true,
    },
    overage: { [FEATURES.emailsSent]: { allowed: true, hardCapMultiple: 3 } },
  },
  {
    code: PLANS.enterprise,
    name: 'Enterprise',
    description: 'Negotiated volume and terms.',
    rank: 40,
    // Not on the pricing page. Provisioned by hand, so it must not be
    // self-serve selectable — a plan change endpoint that offered it would
    // let anyone assign themselves unlimited sending.
    isPublic: false,
    trialDays: 0,
    limits: {
      [FEATURES.emailsSent]: null,
      [FEATURES.contactsStored]: null,
      [FEATURES.campaignsPerMonth]: null,
      [FEATURES.teamSeats]: null,
      [FEATURES.analyticsRetentionDays]: 730,
    },
    flags: {
      [FEATURES.sendingPools]: true,
      [FEATURES.abTesting]: true,
      [FEATURES.customDomains]: true,
      [FEATURES.apiAccess]: true,
      [FEATURES.webhooks]: true,
      [FEATURES.prioritySupport]: true,
    },
    overage: { [FEATURES.emailsSent]: { allowed: true, hardCapMultiple: 10 } },
  },
];

const BY_CODE = new Map<string, PlanDefinition>(
  PLAN_DEFINITIONS.map((plan) => [plan.code, plan]),
);

export function planByCode(code: string): PlanDefinition | null {
  return BY_CODE.get(code) ?? null;
}

/** Plans a customer may select themselves. */
export function selfServePlans(): PlanDefinition[] {
  return PLAN_DEFINITIONS.filter((plan) => plan.isPublic);
}

/**
 * Whether moving between two plans is an upgrade.
 *
 * By rank, never by price. A promotion that makes Growth temporarily cheaper
 * than Starter would otherwise turn an upgrade into a downgrade — which skips
 * the over-limit pre-check and leaves a workspace above limits it was never
 * warned about.
 */
export function isUpgrade(from: string, to: string): boolean {
  const before = planByCode(from);
  const after = planByCode(to);
  if (before === null || after === null) return false;

  return after.rank > before.rank;
}

export function isDowngrade(from: string, to: string): boolean {
  const before = planByCode(from);
  const after = planByCode(to);
  if (before === null || after === null) return false;

  return after.rank < before.rank;
}

/**
 * The limit a plan grants for a feature.
 *
 * `undefined` means the plan says nothing about it, which is not the same as
 * `null` meaning unlimited — and the difference decides whether a rebuild
 * writes an entitlement row at all.
 */
export function limitFor(plan: PlanDefinition, feature: FeatureKey): number | null | undefined {
  return Object.hasOwn(plan.limits, feature) ? plan.limits[feature] : undefined;
}

export function flagFor(plan: PlanDefinition, feature: FeatureKey): boolean | undefined {
  return Object.hasOwn(plan.flags, feature) ? plan.flags[feature] : undefined;
}
