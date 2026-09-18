-- 0009_campaigns.sql
--
-- The campaign engine. This is the most consequential migration in the
-- project: `campaign_recipients` is the durable state machine that every
-- guarantee about not sending twice rests on.
--
-- DDL follows docs/02-database.md section 5 with the amendments in
-- docs/17-review-findings.md section F applied, and where BUILD-PLAN Phase 6
-- names something differently it wins (CLAUDE.md section 1). Those
-- differences, all recorded in docs/16 section 27:
--
--   1. campaign_recipients.state, not .status. BUILD-PLAN says `state`
--      throughout, docs/17's amendment SQL says `state`, and docs/02 says
--      `status`. Two of three, and the one that outranks.
--
--   2. campaign_recipients.provider_connection_id, not .provider_id. Same
--      reasoning, and it is the clearer name: it references
--      provider_connections.
--
--   3. campaigns.status gains `held` and renames `running` to `sending`, per
--      BUILD-PLAN's extended state set. `held` is the state a scheduled
--      campaign enters under dunning restrictions — a running campaign always
--      completes.
--
--   4. usage_records and email_events are created unpartitioned with their
--      first partition, rather than as plain tables. docs/02 and docs/05 both
--      partition them by range on occurred_at; creating the parent without
--      partitioning would need a rewrite later, and a rewrite of the event
--      table is the one migration nobody wants to run.
--
-- Immutable once merged (CLAUDE.md section 8).


-- ---------------------------------------------------------------------------
-- sending_pools
--
-- Declared before campaigns, which references one. Pool routing itself is
-- late in Phase 6 and may be cut (BUILD-PLAN's risk note); the tables are
-- cheap and removing them later would be a second migration.

CREATE TABLE sending_pools (
  id           uuid        PRIMARY KEY,
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  strategy     text        NOT NULL DEFAULT 'weighted'
               CHECK (strategy IN ('round_robin','weighted','failover','least_loaded')),
  is_default   boolean     NOT NULL DEFAULT false,
  settings     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_pool_name UNIQUE (workspace_id, name),
  CONSTRAINT uq_pool_ws UNIQUE (id, workspace_id)
);

-- One default per workspace, enforced rather than trusted.
CREATE UNIQUE INDEX uq_pool_default ON sending_pools (workspace_id) WHERE is_default;

CREATE TABLE sending_pool_members (
  workspace_id      uuid     NOT NULL,
  pool_id           uuid     NOT NULL,
  sender_account_id uuid     NOT NULL,
  weight            smallint NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 1000),
  -- Lower first, for failover.
  priority          smallint NOT NULL DEFAULT 100,
  enabled           boolean  NOT NULL DEFAULT true,

  PRIMARY KEY (pool_id, sender_account_id),
  CONSTRAINT fk_spm_pool FOREIGN KEY (pool_id, workspace_id)
    REFERENCES sending_pools (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT fk_spm_sender FOREIGN KEY (sender_account_id, workspace_id)
    REFERENCES sender_accounts (id, workspace_id) ON DELETE CASCADE
);


-- ---------------------------------------------------------------------------
-- campaigns

CREATE TABLE campaigns (
  id                  uuid        PRIMARY KEY,
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                text        NOT NULL,
  type                text        NOT NULL DEFAULT 'regular'
                      CHECK (type IN ('regular','ab_test','transactional')),

  -- BUILD-PLAN Phase 6's extended set. `held` is dunning; `sending` is what
  -- docs/02 called `running`.
  status              text        NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','scheduled','validating','queueing','sending',
                                        'pausing','paused','cancelling','cancelled',
                                        'completed','completed_with_errors','held','failed')),

  -- RESTRICT, not CASCADE: a sent campaign must keep naming the version it
  -- rendered, or its report describes content that no longer exists.
  template_version_id uuid        REFERENCES template_versions(id) ON DELETE RESTRICT,
  subject_override    text,

  sending_pool_id     uuid,
  sender_account_id   uuid,

  audience            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  tracking            jsonb       NOT NULL DEFAULT '{"opens":true,"clicks":true}'::jsonb,
  throttle_per_hour   integer,

  scheduled_at        timestamptz,
  timezone            text,

  recipient_count     integer     NOT NULL DEFAULT 0,
  snapshot_at         timestamptz,
  launched_at         timestamptz,
  launched_by         uuid        REFERENCES users(id),
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  paused_at           timestamptz,

  -- F29: a double-clicked launch must not create two snapshots.
  idempotency_key     text,

  cloned_from         uuid        REFERENCES campaigns(id) ON DELETE SET NULL,
  created_by          uuid        REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,

  CONSTRAINT uq_campaign_ws UNIQUE (id, workspace_id),
  CONSTRAINT fk_campaign_pool FOREIGN KEY (sending_pool_id, workspace_id)
    REFERENCES sending_pools (id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT fk_campaign_sender FOREIGN KEY (sender_account_id, workspace_id)
    REFERENCES sender_accounts (id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX ix_campaigns_ws_status ON campaigns (workspace_id, status, created_at DESC);
CREATE INDEX ix_campaigns_due ON campaigns (scheduled_at) WHERE status = 'scheduled';
CREATE UNIQUE INDEX uq_campaign_idem ON campaigns (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;


-- ---------------------------------------------------------------------------
-- campaign_recipients
--
-- The most important table in the system, and the one whose physical shape
-- matters most (F27).
--
-- Each row is updated three or four times in its life: pending → queued →
-- sending → sent. An index on `state` alone would mean none of those updates
-- can be HOT, so every update writes new index entries and the table bloats
-- fast. So: fillfactor 80 to leave room for HOT updates on the same page, the
-- only state index partial on the active states so terminal rows carry no
-- entry at all, and aggressive autovacuum.
--
-- `email` and `merge_data` are snapshots rather than joins. A campaign sends
-- what the audience looked like at launch; re-reading the contact would mean
-- an edit mid-send changes what half the recipients get.

CREATE TABLE campaign_recipients (
  id                  uuid        PRIMARY KEY,
  workspace_id        uuid        NOT NULL,
  campaign_id         uuid        NOT NULL,
  contact_id          uuid        NOT NULL,

  email               citext      NOT NULL,
  merge_data          jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- `state`, per BUILD-PLAN. delivery_uncertain is D3: the provider may have
  -- accepted it, so it is terminal and unmetered rather than resent.
  state               text        NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending','queued','sending','sent','failed',
                                       'suppressed','cancelled','delivery_uncertain')),

  attempt_count       smallint    NOT NULL DEFAULT 0,
  -- Identifies one attempt, so a late provider response can be matched to the
  -- attempt that made it rather than to whatever is current.
  attempt_token       uuid,
  queued_at           timestamptz,
  provider_attempt_started_at timestamptz,

  sender_account_id   uuid,
  provider_connection_id uuid,
  provider_message_id text,

  -- 16 random bytes; the basis of every tracking token for this recipient.
  message_token       bytea       NOT NULL,

  -- Write-once. The trigger below refuses to clear it (R14).
  metered             boolean     NOT NULL DEFAULT false,

  -- The F16 ordering lattice. A transition applies only if it strictly
  -- increases the rank, so a `delivered` arriving after a `bounced` — routine,
  -- because SNS has no ordering guarantee — cannot overwrite the bounce and
  -- leave the contact unsuppressed.
  delivery_state      text        NOT NULL DEFAULT 'queued'
                      CHECK (delivery_state IN ('queued','sent','delivered',
                                                'soft_bounced','hard_bounced','complained')),
  delivery_rank       smallint    NOT NULL DEFAULT 0,

  error_code          text,
  error_message       text,
  sent_at             timestamptz,
  failed_at           timestamptz,
  next_attempt_at     timestamptz,
  terminal_at         timestamptz,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_cr_ws UNIQUE (id, workspace_id),
  CONSTRAINT fk_cr_campaign FOREIGN KEY (campaign_id, workspace_id)
    REFERENCES campaigns (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT fk_cr_contact FOREIGN KEY (contact_id, workspace_id)
    REFERENCES contacts (id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT fk_cr_sender FOREIGN KEY (sender_account_id, workspace_id)
    REFERENCES sender_accounts (id, workspace_id) ON DELETE SET NULL,
  CONSTRAINT fk_cr_connection FOREIGN KEY (provider_connection_id, workspace_id)
    REFERENCES provider_connections (id, workspace_id) ON DELETE SET NULL
);

ALTER TABLE campaign_recipients SET (
  fillfactor = 80,
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01
);

-- One row per contact per campaign. The durable guard against a snapshot
-- running twice.
CREATE UNIQUE INDEX uq_cr_campaign_contact ON campaign_recipients (campaign_id, contact_id);
CREATE UNIQUE INDEX uq_cr_token ON campaign_recipients (message_token);

-- The only index on state, and it is partial: terminal rows leave it, so
-- their updates become HOT (F27).
CREATE INDEX ix_cr_active ON campaign_recipients (campaign_id, state)
  WHERE state IN ('pending','queued','sending');

-- The sweeper's query: rows stuck mid-attempt.
CREATE INDEX ix_cr_stale_attempt ON campaign_recipients (provider_attempt_started_at)
  WHERE state = 'sending';

CREATE INDEX ix_cr_provider_msg ON campaign_recipients (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX ix_cr_retry ON campaign_recipients (next_attempt_at)
  WHERE state = 'failed' AND next_attempt_at IS NOT NULL;


-- ---------------------------------------------------------------------------
-- metered is write-once (INVARIANTS R14, review finding F14)
--
-- The trace this prevents: a campaign has 10,000 failures from a provider
-- outage, the customer clicks retry-failed, and an implementation that resets
-- `metered` alongside `state` — which is the natural thing to write — bills
-- every successful retry a second time.
--
-- A trigger rather than discipline, because "remember not to" is not a
-- control.

CREATE OR REPLACE FUNCTION guard_metered()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.metered = true AND NEW.metered = false THEN
    RAISE EXCEPTION 'metered is write-once (recipient %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_metered
  BEFORE UPDATE ON campaign_recipients
  FOR EACH ROW EXECUTE FUNCTION guard_metered();


-- ---------------------------------------------------------------------------
-- campaign_counters (F13)
--
-- Campaign completion is `pending + queued + sending = 0`: one index-free
-- single-row read, instead of a COUNT(*) over millions of recipient rows in a
-- request path (CLAUDE.md section 12).

CREATE TABLE campaign_counters (
  campaign_id  uuid        PRIMARY KEY,
  workspace_id uuid        NOT NULL,
  total        integer     NOT NULL DEFAULT 0,
  pending      integer     NOT NULL DEFAULT 0,
  queued       integer     NOT NULL DEFAULT 0,
  sending      integer     NOT NULL DEFAULT 0,
  sent         integer     NOT NULL DEFAULT 0,
  failed       integer     NOT NULL DEFAULT 0,
  suppressed   integer     NOT NULL DEFAULT 0,
  uncertain    integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_counters_campaign FOREIGN KEY (campaign_id, workspace_id)
    REFERENCES campaigns (id, workspace_id) ON DELETE CASCADE
);


-- ---------------------------------------------------------------------------
-- sender_daily_usage (F8)
--
-- The durable daily quota. Incremented in the same transaction as the `sent`
-- transition: one extra row touch on a tiny table, and correct across any
-- infrastructure failure — which a Redis counter is not.

CREATE TABLE sender_daily_usage (
  sender_account_id uuid   NOT NULL,
  workspace_id      uuid   NOT NULL,
  usage_date        date   NOT NULL,
  sent_count        bigint NOT NULL DEFAULT 0,

  PRIMARY KEY (sender_account_id, usage_date),
  CONSTRAINT fk_sdu_sender FOREIGN KEY (sender_account_id, workspace_id)
    REFERENCES sender_accounts (id, workspace_id) ON DELETE CASCADE
);


-- ---------------------------------------------------------------------------
-- campaign_events
--
-- The campaign's own audit trail: launched, paused, resumed, cancelled, and
-- every automatic transition. Separate from audit_logs because these are
-- mostly system actions at high volume, and mixing them would drown the
-- human-actor trail that audit_logs exists to preserve.

CREATE TABLE campaign_events (
  id           bigserial   PRIMARY KEY,
  workspace_id uuid        NOT NULL,
  campaign_id  uuid        NOT NULL,
  event_type   text        NOT NULL,
  actor_type   text        NOT NULL DEFAULT 'system'
               CHECK (actor_type IN ('user','api_key','system','provider')),
  actor_id     uuid,
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_ce_campaign FOREIGN KEY (campaign_id, workspace_id)
    REFERENCES campaigns (id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX ix_campaign_events_campaign ON campaign_events (campaign_id, created_at DESC);


-- ---------------------------------------------------------------------------
-- tracked_links
--
-- A click URL is resolved from this table by index, never taken from the
-- request (docs/06). That is what makes an open redirect structurally
-- impossible rather than merely guarded against.

CREATE TABLE tracked_links (
  id           uuid        PRIMARY KEY,
  workspace_id uuid        NOT NULL,
  campaign_id  uuid        NOT NULL,
  url          text        NOT NULL,
  url_hash     bytea       NOT NULL,
  label        text,
  -- The index a tracking token carries. Stable for the life of the campaign.
  position     smallint    NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_link UNIQUE (campaign_id, url_hash),
  CONSTRAINT uq_link_position UNIQUE (campaign_id, position),
  CONSTRAINT fk_link_campaign FOREIGN KEY (campaign_id, workspace_id)
    REFERENCES campaigns (id, workspace_id) ON DELETE CASCADE
);


-- ---------------------------------------------------------------------------
-- email_events
--
-- Partitioned by range on occurred_at from the start. Retro-fitting
-- partitioning to a table with hundreds of millions of rows is the one
-- migration nobody wants to run (F25).
--
-- BIGSERIAL is not used here: the partition key must be part of the primary
-- key, and `(id, occurred_at)` with a uuid id is what docs/02 specifies.
--
-- Raw events are always written, whether or not they advance the delivery
-- lattice, so analytics stays complete even when state does not move (F16).

CREATE TABLE email_events (
  id                    uuid        NOT NULL,
  workspace_id          uuid        NOT NULL,
  campaign_id           uuid,
  campaign_recipient_id uuid,
  contact_id            uuid,
  provider_connection_id uuid,

  event_type            text        NOT NULL
    CHECK (event_type IN ('queued','sent','delivered','deferred','bounce','complaint',
                          'open','click','unsubscribe','reject','failed')),
  bounce_class          text CHECK (bounce_class IN ('hard','soft','block','suppressed')),

  provider_message_id   text,
  provider_event_id     text,

  link_id               uuid,
  url                   text,
  user_agent            text,
  -- Hashed with a daily rotating salt, never a raw IP (docs/06 section 15).
  ip_hash               bytea,
  geo_country           char(2),
  device_type           text,
  client_family         text,

  -- Stored and excluded, never dropped (R6).
  is_bot                boolean     NOT NULL DEFAULT false,
  is_prefetch           boolean     NOT NULL DEFAULT false,

  payload               jsonb,
  occurred_at           timestamptz NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (occurred_at);

-- The first partitions. The scheduler creates subsequent ones seven days
-- ahead with lock_timeout set, so a failed attach never blocks the write path
-- (F25). Two are created here so a deployment spanning a month boundary does
-- not hit a missing partition.
CREATE TABLE email_events_2026_09 PARTITION OF email_events
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE email_events_2026_10 PARTITION OF email_events
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

ALTER TABLE email_events_2026_09 ADD PRIMARY KEY (id, occurred_at);
ALTER TABLE email_events_2026_10 ADD PRIMARY KEY (id, occurred_at);

-- Provider event ids are unique per connection, which is what makes a
-- redelivered event a no-op.
CREATE UNIQUE INDEX uq_ee_dedup_2026_09 ON email_events_2026_09
  (provider_connection_id, provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE UNIQUE INDEX uq_ee_dedup_2026_10 ON email_events_2026_10
  (provider_connection_id, provider_event_id) WHERE provider_event_id IS NOT NULL;

CREATE INDEX ix_ee_campaign_2026_09 ON email_events_2026_09 (campaign_id, event_type, occurred_at);
CREATE INDEX ix_ee_campaign_2026_10 ON email_events_2026_10 (campaign_id, event_type, occurred_at);
CREATE INDEX ix_ee_recipient_2026_09 ON email_events_2026_09 (campaign_recipient_id);
CREATE INDEX ix_ee_recipient_2026_10 ON email_events_2026_10 (campaign_recipient_id);
CREATE INDEX ix_ee_ws_time_2026_09 ON email_events_2026_09 (workspace_id, occurred_at DESC);
CREATE INDEX ix_ee_ws_time_2026_10 ON email_events_2026_10 (workspace_id, occurred_at DESC);


-- ---------------------------------------------------------------------------
-- usage_records
--
-- The billing ledger, written from day one even though plans arrive in Phase
-- 8 — BUILD-PLAN's risk note is that a ledger started late can never describe
-- the sends that happened before it.
--
-- The unique key is the whole of R15: `send:{campaignRecipientId}`, so the
-- same recipient can never be billed twice however many times it is retried.
-- It is an INSERT that conflicts, never an upsert that overwrites.

CREATE TABLE usage_records (
  id              uuid        NOT NULL,
  workspace_id    uuid        NOT NULL,
  feature_key     text        NOT NULL,
  quantity        integer     NOT NULL DEFAULT 1,
  -- 'send:' || campaign_recipient_id
  idempotency_key text        NOT NULL,
  campaign_id     uuid,
  resource_id     uuid,
  period_start    timestamptz NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (occurred_at);

CREATE TABLE usage_records_2026_09 PARTITION OF usage_records
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE usage_records_2026_10 PARTITION OF usage_records
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

ALTER TABLE usage_records_2026_09 ADD PRIMARY KEY (id, occurred_at);
ALTER TABLE usage_records_2026_10 ADD PRIMARY KEY (id, occurred_at);

CREATE UNIQUE INDEX uq_ur_idem_2026_09 ON usage_records_2026_09
  (workspace_id, feature_key, idempotency_key);
CREATE UNIQUE INDEX uq_ur_idem_2026_10 ON usage_records_2026_10
  (workspace_id, feature_key, idempotency_key);

CREATE INDEX ix_ur_ws_period_2026_09 ON usage_records_2026_09 (workspace_id, period_start);
CREATE INDEX ix_ur_ws_period_2026_10 ON usage_records_2026_10 (workspace_id, period_start);


-- ---------------------------------------------------------------------------
-- Row-level security

ALTER TABLE sending_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE sending_pools FORCE ROW LEVEL SECURITY;
CREATE POLICY sending_pools_tenant ON sending_pools
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE sending_pool_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE sending_pool_members FORCE ROW LEVEL SECURITY;
CREATE POLICY sending_pool_members_tenant ON sending_pool_members
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY campaigns_tenant ON campaigns
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_recipients_tenant ON campaign_recipients
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE campaign_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_counters_tenant ON campaign_counters
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE sender_daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE sender_daily_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY sender_daily_usage_tenant ON sender_daily_usage
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE campaign_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_events FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_events_tenant ON campaign_events
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE tracked_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tracked_links_tenant ON tracked_links
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

-- On the partitioned parents. Postgres applies a parent's policies to every
-- partition, so a partition created later by the scheduler is covered without
-- anybody remembering to enable it — which is the only way this stays true.
ALTER TABLE email_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_events FORCE ROW LEVEL SECURITY;
CREATE POLICY email_events_tenant ON email_events
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_records_tenant ON usage_records
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);


-- ROLLBACK:
-- DROP TABLE IF EXISTS usage_records;
-- DROP TABLE IF EXISTS email_events;
-- DROP TABLE IF EXISTS tracked_links;
-- DROP TABLE IF EXISTS campaign_events;
-- DROP TABLE IF EXISTS sender_daily_usage;
-- DROP TABLE IF EXISTS campaign_counters;
-- DROP TRIGGER IF EXISTS trg_guard_metered ON campaign_recipients;
-- DROP FUNCTION IF EXISTS guard_metered();
-- DROP TABLE IF EXISTS campaign_recipients;
-- DROP TABLE IF EXISTS campaigns;
-- DROP TABLE IF EXISTS sending_pool_members;
-- DROP TABLE IF EXISTS sending_pools;
