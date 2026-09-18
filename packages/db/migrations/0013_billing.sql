-- Billing (docs/05; INVARIANTS R15, R17, R18, R19, R28).
--
-- The division of labour, stated once because every table below follows from
-- it: **Stripe owns money objects** — charges, invoices, subscription status,
-- refunds, payment methods. **We own** plans, features, limits, entitlements,
-- usage and the workspace-to-Stripe mapping.
--
-- So the money tables here are projections. They exist to answer questions
-- quickly and to survive Stripe being unreachable; they are never the
-- authority, and a reconciler (R19) repairs them nightly. The tables we own
-- outright — plans, features, entitlements, usage — have no Stripe equivalent
-- and are authoritative.
--
-- Three consequences worth naming:
--
--   Every projection carries `provider_state_version`. Stripe webhooks arrive
--   out of order routinely, and without a version a later-sent-earlier-arrived
--   event overwrites newer state (docs/05, F16's sibling problem).
--
--   `billing_customers` is written before Stripe is called (R18), so a crash
--   between the two leaves a pending row we can reconcile rather than a Stripe
--   customer nobody can map to a workspace.
--
--   `usage_aggregates` carries a watermark (R15) so aggregation is idempotent.
--   Running it three times must produce the totals of running it once.

-- ------------------------------------------------------------------- plans
--
-- Ours entirely. No Stripe object corresponds to a plan as the product means
-- it — Stripe has prices, which are one component.

CREATE TABLE plans (
  code            text        PRIMARY KEY
    CHECK (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name            text        NOT NULL,
  description     text,
  -- Ordering for the pricing page and, more importantly, for deciding
  -- whether a change is an upgrade or a downgrade. Comparing prices would
  -- get that wrong the first time somebody runs a promotion.
  rank            smallint    NOT NULL,
  is_public       boolean     NOT NULL DEFAULT true,
  trial_days      smallint    NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_plans_rank ON plans (rank);

CREATE TABLE features (
  key             text        PRIMARY KEY
    CHECK (key ~ '^[a-z][a-z0-9_.]{1,60}$'),
  name            text        NOT NULL,
  -- `limit` is a number the plan caps; `flag` is on or off; `metered` is a
  -- number that accrues and may overage.
  kind            text        NOT NULL CHECK (kind IN ('limit', 'flag', 'metered')),
  unit            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_features (
  plan_code       text        NOT NULL REFERENCES plans(code) ON DELETE CASCADE,
  feature_key     text        NOT NULL REFERENCES features(key) ON DELETE CASCADE,

  -- NULL means unlimited, which is different from 0 and must stay
  -- distinguishable: a plan with no campaigns and a plan with unlimited
  -- campaigns are not the same plan.
  limit_value     bigint,
  flag_value      boolean,

  overage_allowed boolean     NOT NULL DEFAULT false,
  -- A runaway automation must not be able to generate a $40,000 invoice.
  overage_hard_cap_multiple numeric(4,1) NOT NULL DEFAULT 3.0,

  PRIMARY KEY (plan_code, feature_key)
);

CREATE TABLE prices (
  id              text        PRIMARY KEY,
  plan_code       text        NOT NULL REFERENCES plans(code) ON DELETE RESTRICT,
  provider        text        NOT NULL DEFAULT 'stripe',
  provider_price_id text      NOT NULL,
  currency        char(3)     NOT NULL,
  unit_amount     integer     NOT NULL,
  interval        text        NOT NULL CHECK (interval IN ('month', 'year')),
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_prices_provider ON prices (provider, provider_price_id);


-- -------------------------------------------------------------- the mapping
--
-- R18: this row is written with status `pending` BEFORE `stripe.customers
-- .create` is called. A crash between the two then leaves a pending row that
-- the reconciler can finish, rather than a Stripe customer with no workspace.

CREATE TABLE billing_customers (
  id              uuid        PRIMARY KEY,
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider        text        NOT NULL DEFAULT 'stripe',
  -- Null until Stripe has answered. That null is the whole point of R18.
  provider_customer_id text,
  status          text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'failed')),
  email           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One billing customer per workspace per provider. A second would mean two
-- Stripe customers billing the same workspace, which is the kind of thing
-- discovered at renewal.
CREATE UNIQUE INDEX uq_bc_workspace ON billing_customers (workspace_id, provider);
CREATE UNIQUE INDEX uq_bc_provider_id ON billing_customers (provider, provider_customer_id)
  WHERE provider_customer_id IS NOT NULL;


-- --------------------------------------------------------------- the money
--
-- Projections of Stripe. Every one carries `provider_state_version`, and
-- every write is guarded on it.

CREATE TABLE subscriptions (
  id              uuid        PRIMARY KEY,
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  billing_customer_id uuid    NOT NULL REFERENCES billing_customers(id) ON DELETE CASCADE,
  plan_code       text        NOT NULL REFERENCES plans(code) ON DELETE RESTRICT,

  provider        text        NOT NULL DEFAULT 'stripe',
  provider_subscription_id text NOT NULL,

  status          text        NOT NULL
    CHECK (status IN ('trialing','active','past_due','unpaid','canceled','incomplete',
                      'incomplete_expired','paused')),

  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at     timestamptz,
  trial_end       timestamptz,

  -- The dunning clock. Set when an invoice first fails, cleared when one is
  -- paid. Nullable because most subscriptions never have one.
  grace_period_end timestamptz,

  -- A downgrade takes effect at period end. Stored rather than applied so the
  -- customer keeps what they paid for until the period they paid for ends.
  scheduled_plan_code text REFERENCES plans(code) ON DELETE RESTRICT,
  scheduled_change_at timestamptz,

  -- Out-of-order webhooks are routine. A write whose version is not greater
  -- than this one is discarded.
  provider_state_version bigint NOT NULL DEFAULT 0,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_sub_provider ON subscriptions (provider, provider_subscription_id);

-- One active subscription per workspace. The index BUILD-PLAN names.
--
-- Partial rather than total: a workspace that has cancelled and resubscribed
-- has two rows and only one of them is live, and a total unique index would
-- make the second signup fail.
CREATE UNIQUE INDEX uq_sub_active_ws ON subscriptions (workspace_id)
  WHERE status IN ('trialing', 'active', 'past_due', 'unpaid');

CREATE INDEX ix_sub_grace ON subscriptions (grace_period_end)
  WHERE grace_period_end IS NOT NULL;
CREATE INDEX ix_sub_scheduled ON subscriptions (scheduled_change_at)
  WHERE scheduled_change_at IS NOT NULL;

CREATE TABLE subscription_items (
  id              uuid        PRIMARY KEY,
  subscription_id uuid        NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  workspace_id    uuid        NOT NULL,
  provider_item_id text       NOT NULL,
  price_id        text        REFERENCES prices(id) ON DELETE SET NULL,
  quantity        integer     NOT NULL DEFAULT 1,
  is_metered      boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_si_provider ON subscription_items (provider_item_id);

CREATE TABLE invoices (
  id              uuid        PRIMARY KEY,
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  billing_customer_id uuid    NOT NULL REFERENCES billing_customers(id) ON DELETE CASCADE,
  subscription_id uuid        REFERENCES subscriptions(id) ON DELETE SET NULL,

  provider        text        NOT NULL DEFAULT 'stripe',
  provider_invoice_id text    NOT NULL,
  number          text,

  status          text        NOT NULL
    CHECK (status IN ('draft','open','paid','uncollectible','void')),
  currency        char(3)     NOT NULL,
  subtotal        integer     NOT NULL,
  tax             integer     NOT NULL DEFAULT 0,
  total           integer     NOT NULL,
  amount_paid     integer     NOT NULL DEFAULT 0,
  amount_due      integer     NOT NULL DEFAULT 0,

  period_start    timestamptz,
  period_end      timestamptz,
  due_at          timestamptz,
  paid_at         timestamptz,

  hosted_invoice_url text,
  pdf_url         text,

  provider_state_version bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_invoice_provider ON invoices (provider, provider_invoice_id);
CREATE INDEX ix_invoices_ws ON invoices (workspace_id, created_at DESC);

CREATE TABLE payments (
  id              uuid        PRIMARY KEY,
  workspace_id    uuid        NOT NULL,
  invoice_id      uuid        REFERENCES invoices(id) ON DELETE SET NULL,
  provider        text        NOT NULL DEFAULT 'stripe',
  provider_payment_id text    NOT NULL,
  status          text        NOT NULL
    CHECK (status IN ('succeeded','processing','requires_action','failed','canceled')),
  amount          integer     NOT NULL,
  currency        char(3)     NOT NULL,
  failure_code    text,
  failure_message text,
  provider_state_version bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_payment_provider ON payments (provider, provider_payment_id);

CREATE TABLE refunds (
  id              uuid        PRIMARY KEY,
  workspace_id    uuid        NOT NULL,
  payment_id      uuid        REFERENCES payments(id) ON DELETE SET NULL,
  provider        text        NOT NULL DEFAULT 'stripe',
  provider_refund_id text     NOT NULL,
  amount          integer     NOT NULL,
  currency        char(3)     NOT NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_refund_provider ON refunds (provider, provider_refund_id);

CREATE TABLE payment_methods (
  id              uuid        PRIMARY KEY,
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  billing_customer_id uuid    NOT NULL REFERENCES billing_customers(id) ON DELETE CASCADE,
  provider        text        NOT NULL DEFAULT 'stripe',
  provider_payment_method_id text NOT NULL,
  -- Display only. We never see a PAN; Stripe does not give us one.
  brand           text,
  last4           char(4),
  exp_month       smallint,
  exp_year        smallint,
  is_default      boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_pm_provider ON payment_methods (provider, provider_payment_method_id);
CREATE UNIQUE INDEX uq_pm_default ON payment_methods (workspace_id) WHERE is_default;

CREATE TABLE coupons (
  id              uuid        PRIMARY KEY,
  provider        text        NOT NULL DEFAULT 'stripe',
  provider_coupon_id text     NOT NULL,
  code            text,
  percent_off     numeric(5,2),
  amount_off      integer,
  currency        char(3),
  duration        text CHECK (duration IN ('once','repeating','forever')),
  duration_in_months smallint,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_coupon_provider ON coupons (provider, provider_coupon_id);

CREATE TABLE discounts (
  id              uuid        PRIMARY KEY,
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id uuid        REFERENCES subscriptions(id) ON DELETE CASCADE,
  coupon_id       uuid        NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT,
  starts_at       timestamptz NOT NULL DEFAULT now(),
  ends_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);


-- --------------------------------------------------------- what we enforce
--
-- `entitlements` is a rebuildable projection of subscriptions x plan_features.
-- Nothing may read a plan code to make a decision — the gate reads this table
-- (CLAUDE.md section 10), which is what lets a plan change take effect
-- everywhere at once.
--
-- R28: the launch transaction reads this row `FOR SHARE`, so a downgrade
-- committing concurrently cannot change the limit underneath a snapshot.

CREATE TABLE entitlements (
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  feature_key     text        NOT NULL REFERENCES features(key) ON DELETE CASCADE,

  -- NULL means unlimited. Distinct from 0.
  limit_value     bigint,
  flag_value      boolean,

  -- Which subscription produced this, so a rebuild can be checked and a
  -- stale row from a cancelled subscription is visible rather than merely
  -- wrong.
  source_subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  source_plan_code text       REFERENCES plans(code) ON DELETE SET NULL,

  computed_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, feature_key)
);

CREATE INDEX ix_entitlements_source ON entitlements (source_subscription_id)
  WHERE source_subscription_id IS NOT NULL;

-- R15: the aggregate, with its watermark.
--
-- `last_usage_record_id` is what makes aggregation idempotent: the pass reads
-- `usage_records` with `id > watermark` and advances it in the same
-- transaction. Running three times produces the totals of running once, which
-- is the difference between a billing job that can be retried and one that
-- cannot.
CREATE TABLE usage_aggregates (
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  feature_key     text        NOT NULL REFERENCES features(key) ON DELETE CASCADE,
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  subscription_id uuid        REFERENCES subscriptions(id) ON DELETE SET NULL,

  used            bigint      NOT NULL DEFAULT 0,
  included        bigint,
  overage         bigint      NOT NULL DEFAULT 0,

  -- R15. UUIDv7 is time-ordered, so `>` over it is a stable cursor.
  last_usage_record_id uuid,

  reported_to_provider_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, feature_key, period_start)
);

CREATE INDEX ix_ua_period ON usage_aggregates (period_end)
  WHERE reported_to_provider_at IS NULL;


-- ------------------------------------------------------------- the plumbing

-- The webhook inbox. R17: the handler verifies, inserts here, returns 200,
-- and marks the object dirty. It never calls Stripe inline — 500 events for
-- one object would otherwise be 500 API calls inside 500 HTTP handlers.
CREATE TABLE payment_webhook_events (
  id              uuid        PRIMARY KEY,
  provider        text        NOT NULL DEFAULT 'stripe',
  provider_event_id text      NOT NULL,
  event_type      text        NOT NULL,

  -- Nullable: an event may arrive before we know which workspace it belongs
  -- to, and refusing it would lose it.
  workspace_id    uuid,

  payload         jsonb       NOT NULL,
  signature_verified_at timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  process_error   text,
  received_at     timestamptz NOT NULL DEFAULT now()
);

-- The idempotency key for the whole billing webhook path. Stripe retries, and
-- a duplicate delivery must be a no-op rather than a second state change.
CREATE UNIQUE INDEX uq_pwe_provider_event
  ON payment_webhook_events (provider, provider_event_id);
CREATE INDEX ix_pwe_unprocessed ON payment_webhook_events (received_at)
  WHERE processed_at IS NULL;

-- R17: the coalescing queue. One row per object, not per event.
CREATE TABLE billing_refetch_queue (
  provider        text        NOT NULL DEFAULT 'stripe',
  object_type     text        NOT NULL,
  provider_object_id text     NOT NULL,

  workspace_id    uuid,
  -- Bumped by every event for this object. 500 events leave one row with
  -- `dirty_count = 500`, and the consumer makes one API call.
  dirty_count     integer     NOT NULL DEFAULT 1,
  first_dirty_at  timestamptz NOT NULL DEFAULT now(),
  last_dirty_at   timestamptz NOT NULL DEFAULT now(),

  -- The rate bound. The consumer refuses to fetch an object it fetched less
  -- than 30 seconds ago, which is what keeps us inside Stripe's read budget.
  last_fetched_at timestamptz,
  fetch_failures  smallint    NOT NULL DEFAULT 0,

  PRIMARY KEY (provider, object_type, provider_object_id)
);

CREATE INDEX ix_brq_due ON billing_refetch_queue (last_dirty_at)
  WHERE last_fetched_at IS NULL OR last_dirty_at > last_fetched_at;

-- The workspace-visible billing timeline. Not an audit log — this is what a
-- customer sees on their billing page, in their language.
CREATE TABLE billing_events (
  id              bigserial   PRIMARY KEY,
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type      text        NOT NULL,
  detail          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_billing_events_ws ON billing_events (workspace_id, occurred_at DESC);

-- R19: what the nightly reconciler did, so a divergence can be investigated
-- rather than merely counted.
CREATE TABLE billing_reconciliation_runs (
  id              uuid        PRIMARY KEY,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  objects_checked integer     NOT NULL DEFAULT 0,
  divergences_found integer   NOT NULL DEFAULT 0,
  divergences_corrected integer NOT NULL DEFAULT 0,
  detail          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  error           text
);


-- --------------------------------------------------------------------- RLS
--
-- Tenant tables get the standard fail-closed policy. `plans`, `features`,
-- `plan_features` and `prices` are global catalogue data with no
-- `workspace_id` and deliberately have none — every workspace reads the same
-- plan definitions, and a policy on them would have nothing to compare.
--
-- `payment_webhook_events`, `billing_refetch_queue` and
-- `billing_reconciliation_runs` are operator-scoped: their rows may have no
-- workspace at all, which is why the ingest path runs as a job rather than
-- inside a workspace transaction.

ALTER TABLE billing_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_customers FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_customers_tenant ON billing_customers
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_tenant ON subscriptions
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE subscription_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_items FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_items_tenant ON subscription_items
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY invoices_tenant ON invoices
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY payments_tenant ON payments
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY refunds_tenant ON refunds
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_methods_tenant ON payment_methods
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE discounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE discounts FORCE ROW LEVEL SECURITY;
CREATE POLICY discounts_tenant ON discounts
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY entitlements_tenant ON entitlements
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE usage_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_aggregates FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_aggregates_tenant ON usage_aggregates
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_events_tenant ON billing_events
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);


-- ROLLBACK:
-- DROP TABLE IF EXISTS billing_reconciliation_runs;
-- DROP TABLE IF EXISTS billing_events;
-- DROP TABLE IF EXISTS billing_refetch_queue;
-- DROP TABLE IF EXISTS payment_webhook_events;
-- DROP TABLE IF EXISTS usage_aggregates;
-- DROP TABLE IF EXISTS entitlements;
-- DROP TABLE IF EXISTS discounts;
-- DROP TABLE IF EXISTS coupons;
-- DROP TABLE IF EXISTS payment_methods;
-- DROP TABLE IF EXISTS refunds;
-- DROP TABLE IF EXISTS payments;
-- DROP TABLE IF EXISTS invoices;
-- DROP TABLE IF EXISTS subscription_items;
-- DROP TABLE IF EXISTS subscriptions;
-- DROP TABLE IF EXISTS billing_customers;
-- DROP TABLE IF EXISTS prices;
-- DROP TABLE IF EXISTS plan_features;
-- DROP TABLE IF EXISTS features;
-- DROP TABLE IF EXISTS plans;
