-- 0017_enforcement.sql
--
-- Complaint monitoring and the enforcement ladder (docs/06 "Anti-abuse";
-- BUILD-PLAN Phase 11).
--
-- docs/06: "Warn, then require review before launch, then pause sending, then
-- suspend, then terminate with data export." And: "Every enforcement action
-- writes to `audit_logs`."
--
-- That last sentence is why there is only a state table here and no history
-- table. `audit_logs` already records actor, workspace and before/after for
-- every mutating action, and a second history table would be a worse copy of
-- it that nothing else queries.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS workspace_enforcement;


-- ---------------------------------------------------------------------------
-- workspace_enforcement
--
-- One row per workspace, created when the first enforcement action lands.
-- Absent means `none`, which is the right default: a workspace nobody has
-- ever had cause to act on is not under enforcement.
--
-- Deliberately *not* merged into `workspace_trust` (migration 0015). They
-- look similar and are not: trust is about a workspace's age and is written
-- once or twice in its lifetime, enforcement is written by a nightly job and
-- read on every launch. Merging them would put a hot read path on a row an
-- operator edits by hand.

CREATE TABLE workspace_enforcement (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,

  -- The ladder, in order. The CHECK is the same list as `STAGES` in
  -- packages/campaigns/src/abuse/enforcement.ts, and a test compares them —
  -- a stage the database will not store is not a stage however many
  -- TypeScript files agree on it.
  stage text NOT NULL DEFAULT 'none'
        CHECK (stage IN ('none', 'warned', 'review_required', 'paused', 'suspended', 'terminated')),

  -- Why, in machine-readable form, so "how many workspaces are paused for
  -- complaints this month" is a GROUP BY.
  reason text
         CHECK (reason IN (
           'complaint_rate_pause',
           'complaint_rate_review',
           'bounce_rate_hygiene',
           'operator',
           'clean'
         )),

  -- The measured rate at the moment of the decision, kept so a customer
  -- asking "why was I paused" gets a number rather than a policy.
  observed_rate numeric(6, 5),
  observed_sends integer,

  -- When this stage was entered. The recovery clock runs from here, so it is
  -- reset on every change rather than only on escalation — a workspace
  -- stepped down from `paused` to `review_required` starts its next clean
  -- period now, not from when it was first paused.
  entered_at timestamptz NOT NULL DEFAULT now(),

  -- Set by an operator. While true the automatic job does nothing in either
  -- direction: somebody looked at this workspace and decided, and a nightly
  -- job quietly undoing that is how an investigation gets lost.
  held_by_operator boolean NOT NULL DEFAULT false,

  -- Free text for the operator's note. Never shown to the customer.
  note text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A stage above the automatic range is always somebody's decision, so it
  -- must carry one. Without this an automatic job could write `suspended`
  -- with reason `complaint_rate_pause` and nothing would notice.
  CONSTRAINT ck_we_manual_stages_are_operator CHECK (
    stage NOT IN ('suspended', 'terminated') OR reason = 'operator'
  )
);

-- The enforcement job's sweep: everything not clean, oldest first.
CREATE INDEX ix_we_stage ON workspace_enforcement (stage, entered_at)
  WHERE stage <> 'none';


-- ---------------------------------------------------------------------------
-- Row-level security
--
-- A workspace can read its own enforcement state — being told why you are
-- paused is the difference between a control and a black box. Writing it is
-- the job's and an operator's business, and both connect as roles that
-- bypass or set the scope explicitly.

ALTER TABLE workspace_enforcement ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_enforcement FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_enforcement_tenant ON workspace_enforcement
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
