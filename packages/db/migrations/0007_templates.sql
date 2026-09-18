-- 0007_templates.sql
--
-- Templates and their versions. DDL follows docs/02-database.md section 4
-- ("Templates").
--
-- The property that matters here is immutability. A campaign records the
-- template_version_id it rendered (Phase 6), so editing that version later
-- would rewrite what a customer has already sent — the report would describe
-- content that never went out. Enforced in the database rather than trusted
-- to the service, by a trigger that refuses any UPDATE to a published row.
--
-- Two deliberate departures from docs/02, both recorded in docs/16 section 27:
--
--   1. template_versions gains published_at and published_by. docs/02 has no
--      notion of publishing, but BUILD-PLAN Phase 4 requires "publish version"
--      and "published versions immutable", which needs a point at which a
--      version stops being a draft. A row with published_at NULL is a draft
--      and may be edited freely.
--
--   2. Composite foreign keys on (id, workspace_id), as in 0005 and 0006, so a
--      version cannot belong to a template in another workspace.
--
-- Immutable once merged (CLAUDE.md section 8).


-- ---------------------------------------------------------------------------
-- templates

CREATE TABLE templates (
  id                 uuid        PRIMARY KEY,
  workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               text        NOT NULL,
  category           text,
  -- FK added after template_versions exists, below.
  current_version_id uuid,
  created_by         uuid        REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,

  CONSTRAINT uq_template_ws UNIQUE (id, workspace_id)
);

-- Partial on deleted_at, so a name freed by a soft delete can be reused.
CREATE UNIQUE INDEX uq_template_name ON templates (workspace_id, name)
  WHERE deleted_at IS NULL;
CREATE INDEX ix_templates_ws_updated ON templates (workspace_id, updated_at DESC)
  WHERE deleted_at IS NULL;


-- ---------------------------------------------------------------------------
-- template_versions
--
-- html_source is what the author wrote; html_compiled is what will be sent,
-- after sanitisation. Both are kept: the author must be able to edit their own
-- markup back, and we must never re-derive what was sent from input that has
-- since been re-sanitised by a newer allowlist.

CREATE TABLE template_versions (
  id            uuid        PRIMARY KEY,
  workspace_id  uuid        NOT NULL,
  template_id   uuid        NOT NULL,
  version       integer     NOT NULL,

  subject       text        NOT NULL,
  preheader     text,
  html_source   text        NOT NULL,
  html_compiled text        NOT NULL,
  text_body     text        NOT NULL,
  design_json   jsonb,

  -- Discovered merge tags and their defaults, so a launch-time check can ask
  -- "is every required tag resolvable" without re-parsing the HTML.
  variables     jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- NULL means draft. Set once, never cleared (see the trigger below).
  published_at  timestamptz,
  published_by  uuid        REFERENCES users(id),

  created_by    uuid        REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_tpl_version UNIQUE (template_id, version),
  CONSTRAINT uq_tpl_version_ws UNIQUE (id, workspace_id),
  CONSTRAINT fk_tpl_version_template FOREIGN KEY (template_id, workspace_id)
    REFERENCES templates (id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX ix_tpl_versions_template ON template_versions (template_id, version DESC);

ALTER TABLE templates ADD CONSTRAINT fk_tpl_current
  FOREIGN KEY (current_version_id) REFERENCES template_versions(id) ON DELETE SET NULL;


-- ---------------------------------------------------------------------------
-- A published version is immutable
--
-- The same shape as the write-once guard on campaign_recipients.metered
-- (INVARIANTS R14): a BEFORE UPDATE trigger that raises rather than a CHECK,
-- because the rule compares the old row to the new one.
--
-- Deletion is left to the foreign key: a version disappears only when its
-- template does, and a template with sent campaigns is soft-deleted.

CREATE OR REPLACE FUNCTION guard_published_template_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION
      'template_versions.% is published and cannot be modified', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Publishing is the one transition allowed on a draft, and it is one-way.
  IF NEW.published_at IS NULL AND OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'a published template version cannot be returned to draft'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_published_template_version
  BEFORE UPDATE ON template_versions
  FOR EACH ROW EXECUTE FUNCTION guard_published_template_version();


-- ---------------------------------------------------------------------------
-- Row-level security

ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates FORCE ROW LEVEL SECURITY;
CREATE POLICY templates_tenant ON templates
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY template_versions_tenant ON template_versions
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);


-- ROLLBACK:
-- DROP TRIGGER IF EXISTS trg_guard_published_template_version ON template_versions;
-- DROP FUNCTION IF EXISTS guard_published_template_version();
-- ALTER TABLE templates DROP CONSTRAINT IF EXISTS fk_tpl_current;
-- DROP TABLE IF EXISTS template_versions;
-- DROP TABLE IF EXISTS templates;
