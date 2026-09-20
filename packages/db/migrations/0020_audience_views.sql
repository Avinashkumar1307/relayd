-- 0020_audience_views.sql
--
-- What D1's saved-view tabs, D3's archive action, D7's Source filter and the
-- Export button on D1/D7 need and the schema does not already have.
--
-- Four changes, each one forced by an endpoint the web app already calls.
-- Everything else those pages need is a query over tables that exist.
--
--   1. contact_saved_views — D1 draws a strip of view tabs and a "+ Save
--      view" button. A view is a named filter; there is nowhere to put one
--      today. Not a column on `contacts` and not localStorage: the frame
--      shows the same tabs to every member of the workspace, so it is
--      workspace state, and workspace state lives in Postgres.
--
--   2. contact_lists.archived_at — D3's card menu has Archive, and an
--      archived list stays visible and read-only rather than disappearing.
--      A nullable timestamp rather than a boolean, per the brief and because
--      the card's footnote is "Archived 1 Sep 2026" — a boolean would make
--      that date unrecoverable.
--
--   3. export_jobs — POST /exports must answer with an id that names
--      something. Redis is transport (CLAUDE.md section 9), so the intent to
--      export is recorded here and a worker will drain it. Until that worker
--      exists the row sits in `pending`, which is at least true; an endpoint
--      that returns a fabricated id is not.
--
--   4. suppressions.source_campaign_id — D7 prints "the campaign that caused
--      it" in its Source column and filters on it, and the sources endpoint
--      lists the distinct ones. `source_event_id` cannot serve that: it
--      points into `email_events`, which is partitioned by time and is the
--      largest table in the system, and resolving a filter dropdown through
--      it would be a scan of every partition. This is the one column that
--      makes the question answerable with an index. It is nullable and
--      nothing populates it yet — a manual or imported suppression has no
--      campaign, and the events worker must start writing it for a bounce or
--      a complaint. Until then the endpoint honestly returns nothing.
--
-- Immutable once merged (CLAUDE.md section 8).


-- ---------------------------------------------------------------------------
-- 1. Saved views
-- ---------------------------------------------------------------------------
-- `key` is the slug the tab strip sends back as ?view=; `filters` is the
-- stored predicate, validated by the same Zod schema the contacts list uses,
-- so a view can never hold a filter the list endpoint would refuse.
CREATE TABLE contact_saved_views (
  id           uuid        PRIMARY KEY,
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key          text        NOT NULL,
  label        text        NOT NULL,
  -- { status?, q? } — deliberately the subset the contacts list can serve.
  filters      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid        REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Leads with workspace_id, and is the lookup the list endpoint does on
  -- every ?view= request.
  CONSTRAINT uq_saved_view_key UNIQUE (workspace_id, key)
);


-- ---------------------------------------------------------------------------
-- 2. List archival
-- ---------------------------------------------------------------------------
ALTER TABLE contact_lists ADD COLUMN archived_at timestamptz;


-- ---------------------------------------------------------------------------
-- 3. Export jobs
-- ---------------------------------------------------------------------------
-- One jsonb `filters` rather than a column per filter and an id array: what
-- an export selects is whatever the page that asked for it was showing, and
-- freezing that into columns now means a migration every time a page gains a
-- filter. The consumer validates it against the same schema the list
-- endpoint uses.
CREATE TABLE export_jobs (
  id           uuid        PRIMARY KEY,
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource     text        NOT NULL
               CHECK (resource IN ('contacts','suppressions','lists','tags','segments')),
  status       text        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','running','completed','failed','cancelled')),
  -- { status?, q?, view?, reason?, source?, ids?: string[] }
  filters      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  row_count    integer,
  s3_key       text,
  error        text,
  requested_by uuid        REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  completed_at timestamptz
);

CREATE INDEX ix_export_jobs_ws_created ON export_jobs (workspace_id, created_at DESC);


-- ---------------------------------------------------------------------------
-- 4. Suppression provenance
-- ---------------------------------------------------------------------------
ALTER TABLE suppressions ADD COLUMN source_campaign_id uuid;

-- Composite, like every other cross-table reference in the audience schema:
-- a plain FK would accept workspace A's suppression pointing at workspace B's
-- campaign, and RLS would not see anything wrong with the row.
--
-- The column list on SET NULL is not decoration. A bare ON DELETE SET NULL
-- would null every column in the key — workspace_id included — and
-- workspace_id is NOT NULL, so deleting a campaign would fail with a
-- constraint violation on a table nobody was looking at. PostgreSQL 15 added
-- the column list for exactly this case; we target 16.
ALTER TABLE suppressions ADD CONSTRAINT fk_suppressions_source_campaign
  FOREIGN KEY (source_campaign_id, workspace_id)
  REFERENCES campaigns (id, workspace_id) ON DELETE SET NULL (source_campaign_id);

-- The index for this column is NOT here: `suppressions` is populated, and a
-- plain CREATE INDEX takes ACCESS EXCLUSIVE for the duration of the build.
-- Suppression is re-checked at send time (CLAUDE.md section 12), so that lock
-- stalls the send path. It is CREATE INDEX CONCURRENTLY in 0023, its own
-- migration, per CLAUDE.md section 8.


-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Both new tables are tenant-owned. The coverage test derives the list from
-- the Drizzle schema, so omitting one here fails the build.
ALTER TABLE contact_saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_saved_views FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_saved_views_tenant ON contact_saved_views
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY export_jobs_tenant ON export_jobs
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);


-- ROLLBACK:
-- ALTER TABLE suppressions DROP CONSTRAINT IF EXISTS fk_suppressions_source_campaign;
-- ALTER TABLE suppressions DROP COLUMN IF EXISTS source_campaign_id;
-- DROP TABLE IF EXISTS export_jobs;
-- ALTER TABLE contact_lists DROP COLUMN IF EXISTS archived_at;
-- DROP TABLE IF EXISTS contact_saved_views;
