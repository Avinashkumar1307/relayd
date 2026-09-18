-- Analytics rollups (docs/08; INVARIANTS R24, R25, R26).
--
-- Six tables, all of them derived. Every number here can be recomputed from
-- `email_events` and `campaign_recipients`, and the hourly job does exactly
-- that (R24) rather than advancing a watermark — because a watermark plus a
-- lost Redis dirty set is a permanent gap, and nobody notices a gap in a
-- number that only ever goes up.
--
-- That also decides the shape: every table is an upsert target keyed on what
-- it aggregates, never an append log. A rollup that has run twice must leave
-- the same rows as one that ran once.
--
-- None of these are billing sources. `usage_records` is, and it is written in
-- the send transaction (R14) precisely so that the number we charge for never
-- depends on a rollup being correct.

-- ---------------------------------------------------------------- campaigns

-- The campaign card and the detail header. One row per campaign, forever.
CREATE TABLE campaign_stats (
  campaign_id         uuid        PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Dispatch facts, from campaign_recipients. Not from events: a send that
  -- the provider accepted is something we know directly, and deriving it from
  -- feedback would make it depend on the provider telling us.
  recipients          integer     NOT NULL DEFAULT 0,
  sent                integer     NOT NULL DEFAULT 0,
  failed              integer     NOT NULL DEFAULT 0,
  suppressed          integer     NOT NULL DEFAULT 0,
  delivery_uncertain  integer     NOT NULL DEFAULT 0,

  -- Feedback facts, from email_events.
  delivered           integer     NOT NULL DEFAULT 0,
  bounced_hard        integer     NOT NULL DEFAULT 0,
  bounced_soft        integer     NOT NULL DEFAULT 0,
  complained          integer     NOT NULL DEFAULT 0,
  unsubscribed        integer     NOT NULL DEFAULT 0,

  -- Opens are kept three ways on purpose (docs/06 section 13). The raw total,
  -- the unique count, and the unique count with bots and prefetches removed.
  -- The UI shows the filtered one and says so; the unfiltered one exists so a
  -- customer who asks "why is this lower than my old tool" can be answered.
  opens_total         integer     NOT NULL DEFAULT 0,
  opens_unique        integer     NOT NULL DEFAULT 0,
  opens_unique_nonbot integer     NOT NULL DEFAULT 0,

  clicks_total        integer     NOT NULL DEFAULT 0,
  clicks_unique       integer     NOT NULL DEFAULT 0,
  clicks_unique_nonbot integer    NOT NULL DEFAULT 0,

  -- Which rollup last wrote this, and when. `computed_at` is what tells the
  -- UI whether it is showing a 30-second figure or an hourly authoritative
  -- one, and `computed_by` is what tells an operator which job to blame.
  computed_at         timestamptz NOT NULL DEFAULT now(),
  computed_by         text        NOT NULL DEFAULT 'incremental'
    CHECK (computed_by IN ('incremental', 'hourly')),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_campaign_stats_ws ON campaign_stats (workspace_id, computed_at DESC);

-- The timeline chart. One row per campaign per day, so a 90-day chart is 90
-- rows rather than an aggregate over millions of events.
CREATE TABLE campaign_daily_stats (
  campaign_id         uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  workspace_id        uuid        NOT NULL,
  -- The day in UTC. Presentation converts; storage does not, because a stored
  -- local day is wrong the moment a workspace changes timezone.
  day                 date        NOT NULL,

  sent                integer     NOT NULL DEFAULT 0,
  delivered           integer     NOT NULL DEFAULT 0,
  bounced             integer     NOT NULL DEFAULT 0,
  complained          integer     NOT NULL DEFAULT 0,
  opens_unique_nonbot integer     NOT NULL DEFAULT 0,
  clicks_unique       integer     NOT NULL DEFAULT 0,
  unsubscribed        integer     NOT NULL DEFAULT 0,

  computed_at         timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (campaign_id, day)
);

CREATE INDEX ix_cds_ws_day ON campaign_daily_stats (workspace_id, day DESC);

-- ------------------------------------------------------------------ routing

-- Per provider connection per day. Feeds the provider comparison view and the
-- sender health score.
CREATE TABLE provider_stats (
  provider_connection_id uuid     NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  workspace_id        uuid        NOT NULL,
  day                 date        NOT NULL,

  sent                integer     NOT NULL DEFAULT 0,
  delivered           integer     NOT NULL DEFAULT 0,
  bounced_hard        integer     NOT NULL DEFAULT 0,
  bounced_soft        integer     NOT NULL DEFAULT 0,
  complained          integer     NOT NULL DEFAULT 0,
  deferred            integer     NOT NULL DEFAULT 0,
  rejected            integer     NOT NULL DEFAULT 0,

  computed_at         timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (provider_connection_id, day)
);

CREATE INDEX ix_provider_stats_ws_day ON provider_stats (workspace_id, day DESC);

-- ---------------------------------------------------------------- engagement

-- The device and client mix. Apple's Mail Privacy Protection reports a
-- generic client through a proxy, so a large "unknown" slice is expected —
-- docs/06 requires the UI to show its size honestly rather than distributing
-- it across the known clients.
CREATE TABLE device_stats (
  campaign_id         uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  workspace_id        uuid        NOT NULL,
  device_type         text        NOT NULL,
  client_family       text        NOT NULL,

  opens               integer     NOT NULL DEFAULT 0,
  clicks              integer     NOT NULL DEFAULT 0,

  computed_at         timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (campaign_id, device_type, client_family)
);

-- Per tracked link. The heat table on the campaign analytics page.
CREATE TABLE link_stats (
  link_id             uuid        NOT NULL REFERENCES tracked_links(id) ON DELETE CASCADE,
  campaign_id         uuid        NOT NULL,
  workspace_id        uuid        NOT NULL,

  clicks_total        integer     NOT NULL DEFAULT 0,
  clicks_unique       integer     NOT NULL DEFAULT 0,
  clicks_unique_nonbot integer    NOT NULL DEFAULT 0,

  computed_at         timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (link_id)
);

CREATE INDEX ix_link_stats_campaign ON link_stats (campaign_id, clicks_unique DESC);

-- Per contact, across all campaigns. R26/F26: derived from the hourly rollup
-- and never updated per event.
--
-- Updating this on every event would put the hottest write contention on
-- exactly the contacts that are mailed most — the ones whose rows would be
-- updated most often. It is a reporting artefact; it does not need to be
-- current to the second, and nothing in the product reads it in a send path.
CREATE TABLE contact_engagement (
  contact_id          uuid        PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  workspace_id        uuid        NOT NULL,

  campaigns_received  integer     NOT NULL DEFAULT 0,
  opens               integer     NOT NULL DEFAULT 0,
  clicks              integer     NOT NULL DEFAULT 0,

  last_opened_at      timestamptz,
  last_clicked_at     timestamptz,
  last_sent_at        timestamptz,

  -- 0-100. Recomputed wholesale by the hourly pass, never incremented.
  engagement_score    smallint    NOT NULL DEFAULT 0
    CHECK (engagement_score BETWEEN 0 AND 100),

  computed_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_contact_engagement_ws
  ON contact_engagement (workspace_id, engagement_score DESC);


-- ---------------------------------------------------------------------- RLS
--
-- Every one of these is tenant-owned and gets the same policy as everything
-- else: `NULLIF(current_setting(...), '')::uuid`, which fails closed when the
-- setting is absent rather than matching every row.

ALTER TABLE campaign_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_stats FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_stats_tenant ON campaign_stats
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE campaign_daily_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_daily_stats FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_daily_stats_tenant ON campaign_daily_stats
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE provider_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_stats FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_stats_tenant ON provider_stats
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE device_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_stats FORCE ROW LEVEL SECURITY;
CREATE POLICY device_stats_tenant ON device_stats
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE link_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE link_stats FORCE ROW LEVEL SECURITY;
CREATE POLICY link_stats_tenant ON link_stats
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE contact_engagement ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_engagement FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_engagement_tenant ON contact_engagement
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);


-- ------------------------------------------------------- partition creation
--
-- R25/F25: partitions created ahead of time, by the scheduler, with
-- `lock_timeout` set so a failed attach never blocks the write path.
--
-- A function rather than application code because the DDL has to be generated
-- from the date, and because `lock_timeout` must be set for the duration of
-- the statement and nothing else. `SET LOCAL` inside the function scopes it to
-- the calling transaction, which is what makes the timeout apply to the
-- `CREATE TABLE ... PARTITION OF` and not to whatever runs next.
--
-- Idempotent: creating a partition that exists is a no-op, so the scheduler
-- can run this every day forever without needing to know what it did
-- yesterday.
CREATE OR REPLACE FUNCTION ensure_month_partition(
  parent      text,
  month_start date
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  partition_name text;
  month_end      date;
BEGIN
  IF parent !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Refusing to build DDL for an unexpected table name: %', parent;
  END IF;

  partition_name := parent || '_' || to_char(month_start, 'YYYY_MM');
  month_end := (month_start + interval '1 month')::date;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
    RETURN partition_name;
  END IF;

  -- Five seconds, per F25. Attaching a partition needs a brief lock on the
  -- parent; if a long-running query is holding one, failing fast and trying
  -- again next tick is far better than queueing every insert behind us.
  SET LOCAL lock_timeout = '5s';

  EXECUTE format(
    'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    partition_name, parent, month_start, month_end
  );

  RETURN partition_name;
END;
$$;


-- ROLLBACK:
-- DROP FUNCTION IF EXISTS ensure_month_partition(text, date);
-- DROP TABLE IF EXISTS contact_engagement;
-- DROP TABLE IF EXISTS link_stats;
-- DROP TABLE IF EXISTS device_stats;
-- DROP TABLE IF EXISTS provider_stats;
-- DROP TABLE IF EXISTS campaign_daily_stats;
-- DROP TABLE IF EXISTS campaign_stats;
