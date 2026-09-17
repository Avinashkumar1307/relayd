-- 0005_audience.sql
--
-- Contacts, lists, tags, segments, suppressions and imports.
-- DDL follows docs/02-database.md section 3 ("Audience", "Import staging").
--
-- Two deliberate departures from docs/02, both recorded in docs/16 section 27:
--
--   1. contact_imports is named import_jobs, and import_row_errors is added.
--      BUILD-PLAN Phase 2 and docs/15 both name those two tables; docs/02 has
--      contact_imports and no errors table. BUILD-PLAN outranks docs/02
--      (CLAUDE.md section 1).
--
--   2. The join tables carry composite foreign keys on (id, workspace_id)
--      rather than plain ones. See the comment above contact_list_members.
--
-- Immutable once merged (CLAUDE.md section 8).


-- ---------------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------------
CREATE TABLE contacts (
  id               uuid        PRIMARY KEY,
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email            citext      NOT NULL,
  -- Generated, so segment predicates on domain need no function index and
  -- cannot disagree with the address they were derived from.
  email_domain     text        GENERATED ALWAYS AS (split_part(lower(email::text), '@', 2)) STORED,
  first_name       text,
  last_name        text,
  status           text        NOT NULL DEFAULT 'subscribed'
                   CHECK (status IN ('subscribed','unsubscribed','bounced','complained','cleaned')),
  source           text        NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('manual','import','api','form','automation')),
  -- Consent is not decoration. docs/00: consent-based sending is an enforced
  -- product constraint, and this is the evidence when a provider asks.
  consent_status   text        NOT NULL DEFAULT 'unknown'
                   CHECK (consent_status IN ('unknown','single_optin','double_optin','imported_declared')),
  consent_at       timestamptz,
  consent_ip       inet,
  consent_source   text,
  attributes       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  last_engaged_at  timestamptz,
  engagement_score smallint    NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

-- citext gives the case folding; the partial predicate frees the address again
-- once a contact is soft-deleted.
CREATE UNIQUE INDEX uq_contacts_ws_email ON contacts (workspace_id, email)
  WHERE deleted_at IS NULL;

CREATE INDEX ix_contacts_ws_status  ON contacts (workspace_id, status) WHERE deleted_at IS NULL;
CREATE INDEX ix_contacts_ws_created ON contacts (workspace_id, created_at DESC);
CREATE INDEX ix_contacts_attrs      ON contacts USING gin (attributes jsonb_path_ops);
CREATE INDEX ix_contacts_domain     ON contacts (workspace_id, email_domain);

-- Referenced by the composite foreign keys below.
ALTER TABLE contacts ADD CONSTRAINT uq_contacts_id_ws UNIQUE (id, workspace_id);


-- ---------------------------------------------------------------------------
-- lists
-- ---------------------------------------------------------------------------
CREATE TABLE contact_lists (
  id           uuid        PRIMARY KEY,
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  description  text,
  -- Denormalised and reconciled nightly. Never the source of truth for a
  -- send: a campaign snapshots its recipients (docs/00).
  member_count integer     NOT NULL DEFAULT 0,
  created_by   uuid        REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_list_name UNIQUE (workspace_id, name)
);

ALTER TABLE contact_lists ADD CONSTRAINT uq_contact_lists_id_ws UNIQUE (id, workspace_id);

-- The composite foreign keys here are the point of this table's shape.
--
-- Plain FKs on list_id and contact_id would each be satisfied by a list from
-- workspace A and a contact from workspace B, producing a membership row that
-- straddles two tenants. RLS would not catch it either: the row carries one
-- workspace_id and looks legitimate from both sides.
--
-- Referencing (id, workspace_id) makes that unrepresentable. docs/06 section
-- 15 part 4 requires "adding B's contact to A's list fails"; this is what
-- makes it fail in the database rather than only in a service that remembered
-- to check.
CREATE TABLE contact_list_members (
  workspace_id uuid        NOT NULL,
  list_id      uuid        NOT NULL,
  contact_id   uuid        NOT NULL,
  added_at     timestamptz NOT NULL DEFAULT now(),
  added_by     text        NOT NULL DEFAULT 'manual',
  PRIMARY KEY (list_id, contact_id),
  CONSTRAINT fk_clm_list
    FOREIGN KEY (list_id, workspace_id)
    REFERENCES contact_lists (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT fk_clm_contact
    FOREIGN KEY (contact_id, workspace_id)
    REFERENCES contacts (id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX ix_clm_contact ON contact_list_members (contact_id);
CREATE INDEX ix_clm_ws_list ON contact_list_members (workspace_id, list_id);


-- ---------------------------------------------------------------------------
-- tags
-- ---------------------------------------------------------------------------
CREATE TABLE tags (
  id           uuid        PRIMARY KEY,
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         citext      NOT NULL,
  color        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_tag_name UNIQUE (workspace_id, name)
);

ALTER TABLE tags ADD CONSTRAINT uq_tags_id_ws UNIQUE (id, workspace_id);

CREATE TABLE contact_tags (
  workspace_id uuid        NOT NULL,
  contact_id   uuid        NOT NULL,
  tag_id       uuid        NOT NULL,
  tagged_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id),
  CONSTRAINT fk_ct_contact
    FOREIGN KEY (contact_id, workspace_id)
    REFERENCES contacts (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT fk_ct_tag
    FOREIGN KEY (tag_id, workspace_id)
    REFERENCES tags (id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX ix_contact_tags_tag ON contact_tags (tag_id);


-- ---------------------------------------------------------------------------
-- segments
-- ---------------------------------------------------------------------------
CREATE TABLE segments (
  id           uuid        PRIMARY KEY,
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  -- A validated AST, compiled to parameterised SQL server-side. User SQL is
  -- never stored and never executed (docs/02, "Segment definition AST").
  definition   jsonb       NOT NULL,
  kind         text        NOT NULL DEFAULT 'dynamic' CHECK (kind IN ('dynamic','static')),
  cached_count integer,
  cached_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_segment_name UNIQUE (workspace_id, name)
);


-- ---------------------------------------------------------------------------
-- suppressions
-- ---------------------------------------------------------------------------
-- "A suppressed address is never sent to, ever" (docs/00, core aggregates).
CREATE TABLE suppressions (
  id              uuid        PRIMARY KEY,
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email           citext      NOT NULL,
  -- sha256, for set membership at send time without touching the text column.
  email_hash      bytea       NOT NULL,
  reason          text        NOT NULL
                  CHECK (reason IN ('unsubscribe','hard_bounce','complaint','manual','global_block','invalid')),
  scope           text        NOT NULL DEFAULT 'workspace'
                  CHECK (scope IN ('workspace','campaign','list')),
  scope_ref_id    uuid,
  source_event_id uuid,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- COALESCE so a workspace-wide suppression (null scope_ref_id) still collides
-- with itself; a plain unique index would let unlimited duplicates through,
-- because NULL is never equal to NULL.
CREATE UNIQUE INDEX uq_suppression
  ON suppressions (workspace_id, email, scope, COALESCE(scope_ref_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX ix_suppressions_hash ON suppressions (workspace_id, email_hash);


-- ---------------------------------------------------------------------------
-- imports
-- ---------------------------------------------------------------------------
CREATE TABLE import_jobs (
  id                  uuid        PRIMARY KEY,
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  s3_key              text        NOT NULL,
  original_filename   text        NOT NULL,
  byte_size           bigint      NOT NULL,
  file_type           text        NOT NULL CHECK (file_type IN ('csv','tsv','xlsx')),
  status              text        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','mapping','validating','processing','completed','failed','cancelled')),
  column_mapping      jsonb,
  -- {updateExisting, addToListIds, tagIds, consentDeclaration}
  options             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  total_rows          integer,
  processed_rows      integer     NOT NULL DEFAULT 0,
  created_count       integer     NOT NULL DEFAULT 0,
  updated_count       integer     NOT NULL DEFAULT 0,
  skipped_count       integer     NOT NULL DEFAULT 0,
  failed_count        integer     NOT NULL DEFAULT 0,
  error_report_s3_key text,
  error_summary       jsonb,
  created_by          uuid        REFERENCES users(id),
  started_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_imports_ws_status ON import_jobs (workspace_id, status, created_at DESC);

ALTER TABLE import_jobs ADD CONSTRAINT uq_import_jobs_id_ws UNIQUE (id, workspace_id);

-- Per-row failures, kept in the database rather than only in an S3 report.
--
-- BUILD-PLAN Phase 2 requires "per-row errors" and a "failed-row CSV
-- download". A table means the UI can page through failures without fetching
-- an object from S3, and local development needs no object store at all.
-- Bounded per import so a file of 500,000 bad rows cannot write 500,000 rows
-- here — the count on import_jobs.failed_count stays authoritative.
CREATE TABLE import_row_errors (
  id           bigserial   PRIMARY KEY,
  workspace_id uuid        NOT NULL,
  import_id    uuid        NOT NULL,
  -- 1-based, as the user sees it in their spreadsheet.
  row_number   integer     NOT NULL,
  column_name  text,
  error_code   text        NOT NULL,
  message      text        NOT NULL,
  -- The offending row, for the downloadable error report. Never re-parsed.
  raw_value    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_ire_import
    FOREIGN KEY (import_id, workspace_id)
    REFERENCES import_jobs (id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX ix_import_row_errors_import ON import_row_errors (import_id, row_number);


-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Every table above is tenant-owned, so every one gets a policy. The coverage
-- test derives the list from the Drizzle schema, so omitting one here fails
-- the build rather than shipping an unprotected table.
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY contacts_tenant ON contacts
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE contact_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_lists FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_lists_tenant ON contact_lists
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE contact_list_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_list_members FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_list_members_tenant ON contact_list_members
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
CREATE POLICY tags_tenant ON tags
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE contact_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_tags_tenant ON contact_tags
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE segments FORCE ROW LEVEL SECURITY;
CREATE POLICY segments_tenant ON segments
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppressions FORCE ROW LEVEL SECURITY;
CREATE POLICY suppressions_tenant ON suppressions
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY import_jobs_tenant ON import_jobs
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE import_row_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_row_errors FORCE ROW LEVEL SECURITY;
CREATE POLICY import_row_errors_tenant ON import_row_errors
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);


-- ROLLBACK:
-- DROP TABLE IF EXISTS import_row_errors;
-- DROP TABLE IF EXISTS import_jobs;
-- DROP TABLE IF EXISTS suppressions;
-- DROP TABLE IF EXISTS segments;
-- DROP TABLE IF EXISTS contact_tags;
-- DROP TABLE IF EXISTS tags;
-- DROP TABLE IF EXISTS contact_list_members;
-- DROP TABLE IF EXISTS contact_lists;
-- DROP TABLE IF EXISTS contacts;
