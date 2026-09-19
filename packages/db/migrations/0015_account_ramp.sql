-- 0015_account_ramp.sql
--
-- The new-workspace ramp (docs/06 "Anti-abuse"; BUILD-PLAN Phase 11).
--
-- docs/06: "First 7 days capped at 500 emails/day regardless of plan, lifted
-- automatically on clean metrics or manually on request." And: "no sending
-- until a sender identity is verified".
--
-- Two tables, and the split matters.
--
--   `workspace_send_quota` is a counter, written on the send path, one row
--   per workspace per day. Hot, tiny, contended.
--
--   `workspace_trust` is state, written when somebody or something decides
--   the workspace's standing has changed. Cold, one row per workspace.
--
-- Keeping them apart means the send path never touches the row an operator
-- is editing, and an operator's transaction never waits behind a send.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS workspace_send_quota;
--   DROP TABLE IF EXISTS workspace_trust;


-- ---------------------------------------------------------------------------
-- workspace_send_quota
--
-- The daily send counter the ramp cap is checked against.
--
-- Why a counter and not a query: the obvious implementation counts rows in
-- `usage_records` for today. That table is partitioned by month and indexed
-- on (workspace_id, period_start), so "today" is a scan of the workspace's
-- whole month — and the check has to run on every dispatch page, not once
-- per launch, because a cap that is only enforced at launch is not a cap.
--
-- `day` is a date in UTC, deliberately, not in the workspace's timezone. A
-- cap that resets at local midnight resets at a different instant for every
-- workspace, which makes "how many did they send today" a question with no
-- single answer at the moment somebody is asking it during an incident. The
-- UI says UTC.

CREATE TABLE workspace_send_quota (
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day          date        NOT NULL,
  sent         integer     NOT NULL DEFAULT 0 CHECK (sent >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, day)
);

-- The counter is incremented once per send and read once per dispatch page,
-- so the row is rewritten constantly and the table would bloat at the
-- default fillfactor. Same reasoning as `campaign_recipients` (CLAUDE.md
-- section 8): leave room for the HOT update to stay on its own page.
ALTER TABLE workspace_send_quota SET (fillfactor = 70);
ALTER TABLE workspace_send_quota SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01
);

-- For the cleanup job. Rows older than the ramp window answer no question
-- the analytics rollups do not answer better.
CREATE INDEX ix_wsq_day ON workspace_send_quota (day);


-- ---------------------------------------------------------------------------
-- workspace_trust
--
-- One row per workspace, created lazily. A workspace with no row is treated
-- as in-ramp and unlifted, which is the safe default: the failure mode of a
-- missing row is a workspace capped at 500/day that should not have been,
-- which somebody complains about. The other way round is a spammer who was
-- never capped, which nobody complains about until the IP is blocklisted.

CREATE TABLE workspace_trust (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,

  -- When the ramp was lifted, and by what. NULL means still ramped.
  --
  -- `lifted_by` distinguishes the automatic lift on clean metrics from an
  -- operator's decision, because the two need different review when a
  -- workspace later turns out to be a spammer: one is a policy that was too
  -- loose, the other is a person who was misled.
  ramp_lifted_at timestamptz,
  ramp_lifted_by text CHECK (ramp_lifted_by IN ('automatic', 'operator')),
  ramp_lifted_note text,

  -- Set when an operator deliberately extends the ramp — a workspace that
  -- looks wrong but not wrong enough to suspend. Overrides the age check in
  -- both directions.
  ramp_until timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Either both or neither. A lift timestamp with no attribution is the
  -- state that makes the review above impossible, and it is exactly what an
  -- UPDATE that set one column and forgot the other would produce.
  CONSTRAINT ck_wt_lift_attributed CHECK (
    (ramp_lifted_at IS NULL AND ramp_lifted_by IS NULL)
    OR (ramp_lifted_at IS NOT NULL AND ramp_lifted_by IS NOT NULL)
  )
);


-- ---------------------------------------------------------------------------
-- Row-level security
--
-- Both are tenant-owned and keyed by workspace, so both get the standard
-- policy. NULLIF fails closed: an unset `app.workspace_id` matches nothing
-- rather than matching everything (INVARIANTS R36).

ALTER TABLE workspace_send_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_send_quota FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_send_quota_tenant ON workspace_send_quota
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE workspace_trust ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_trust FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_trust_tenant ON workspace_trust
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
