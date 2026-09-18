-- 0008_scheduler_and_dlq.sql
--
-- The two tables the worker platform needs: a Postgres-driven schedule, and
-- an explicit dead-letter queue.
--
-- scheduled_jobs exists because of review finding F23. BullMQ repeatable jobs
-- live in Redis, so a flush or a failover loses every recurring job —
-- rollups, sweepers, dunning, partition maintenance — and nothing errors,
-- because nothing failed; things simply stop happening. INVARIANTS R23 bans
-- them outright and requires the scheduler to compute due work from this
-- table each tick.
--
-- The two tables differ in how they are protected:
--
--   scheduled_jobs is operator configuration. One row per recurring job for
--   the whole deployment, read by a scheduler that connects directly as an
--   operator (R35) before any workspace is known. It has no workspace_id and
--   no RLS, and is named in the coverage test's allowlist.
--
--   job_dead_letters carries a nullable workspace_id and DOES have RLS. A
--   tenant-scoped query therefore sees only its own failed jobs — useful, and
--   the right default. Rows with a null workspace_id match no tenant scope at
--   all, which is correct: a job that failed before its payload could be read
--   belongs to nobody. The operator console reads the whole table through the
--   BYPASSRLS role, which is what makes it an operator console.
--
-- Two departures from the documents, recorded in docs/16 section 27:
--
--   1. The table is job_dead_letters, not dead_letters. BUILD-PLAN Phase 5
--      names it job_dead_letters and docs/04 names it dead_letters;
--      BUILD-PLAN outranks docs/00-16 (CLAUDE.md section 1).
--
--   2. scheduled_jobs gains locked_until, locked_by, last_error and
--      consecutive_failures. docs/02 has name, cron, queue, payload, enabled,
--      last_run_at and next_run_at, which is enough to decide what is due and
--      nothing else — two schedulers reading the same due row would both
--      enqueue it. Leader election makes that unlikely; the claim columns
--      make it impossible. The two error columns make a schedule that keeps
--      failing visible without reading logs.
--
-- Immutable once merged (CLAUDE.md section 8).


-- ---------------------------------------------------------------------------
-- scheduled_jobs

CREATE TABLE scheduled_jobs (
  name        text        PRIMARY KEY,
  cron        text        NOT NULL,
  queue       text        NOT NULL,
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  enabled     boolean     NOT NULL DEFAULT true,

  last_run_at timestamptz,
  next_run_at timestamptz NOT NULL,

  -- Claimed by one tick. A scheduler that dies mid-tick leaves the claim
  -- behind, and it expires rather than needing a human.
  locked_until timestamptz,
  locked_by    text,

  -- Observability: a schedule that keeps failing should be visible without
  -- reading logs.
  last_error   text,
  consecutive_failures integer NOT NULL DEFAULT 0,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The tick's own query: enabled, due, and not claimed by a live tick.
CREATE INDEX ix_scheduled_due ON scheduled_jobs (next_run_at)
  WHERE enabled;


-- ---------------------------------------------------------------------------
-- job_dead_letters
--
-- BullMQ has no native dead-letter queue, so it is explicit: the worker's
-- `failed` handler writes here once a job has exhausted its attempts.
--
-- Replay re-enqueues with the *original* jobId, which is why every queue in
-- docs/04's catalogue has a deterministic one — replaying a job that actually
-- succeeded is then a no-op rather than a duplicate send.

CREATE TABLE job_dead_letters (
  id           uuid        PRIMARY KEY,
  queue        text        NOT NULL,
  job_id       text        NOT NULL,

  -- Nullable: not every job belongs to a workspace, and a job that failed
  -- before its payload could be read has none at all.
  workspace_id uuid        REFERENCES workspaces(id) ON DELETE SET NULL,

  payload      jsonb       NOT NULL,
  -- The scrubbed error, never the original object (INVARIANTS R22).
  error        jsonb       NOT NULL,
  attempts     smallint    NOT NULL,

  status       text        NOT NULL DEFAULT 'new'
               CHECK (status IN ('new','investigating','replayed','discarded')),
  replayed_at  timestamptz,
  replayed_by  uuid        REFERENCES users(id),
  notes        text,

  failed_at    timestamptz NOT NULL DEFAULT now(),

  -- One row per failure of a given job. A job that fails, is replayed and
  -- fails again is two rows; a duplicate `failed` event for the same attempt
  -- is one.
  CONSTRAINT uq_dl_job UNIQUE (queue, job_id, attempts)
);

CREATE INDEX ix_dl_queue ON job_dead_letters (queue, status, failed_at DESC);
-- The operator console's default view: everything nobody has looked at yet.
CREATE INDEX ix_dl_new ON job_dead_letters (failed_at DESC)
  WHERE status = 'new';
-- Used when a workspace asks what happened to their import.
CREATE INDEX ix_dl_workspace ON job_dead_letters (workspace_id, failed_at DESC)
  WHERE workspace_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- Row-level security on the dead-letter queue
--
-- NULLIF as everywhere else, so an unset scope matches nothing rather than
-- raising. A row with a null workspace_id matches no scope either, because
-- `NULL = anything` is NULL — which is exactly the intent.

ALTER TABLE job_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_dead_letters FORCE ROW LEVEL SECURITY;
CREATE POLICY job_dead_letters_tenant ON job_dead_letters
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);


-- ROLLBACK:
-- DROP TABLE IF EXISTS job_dead_letters;
-- DROP TABLE IF EXISTS scheduled_jobs;
