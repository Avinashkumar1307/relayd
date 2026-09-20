-- 0021_archival.sql
--
-- Archival for templates (design frame F1's Active / Archived tabs) and for
-- campaigns (G1's "Archive" row action on completed, cancelled and failed
-- campaigns).
--
-- Why a new column rather than reusing something that exists
--
--   `deleted_at` is already on both tables and is emphatically not this.
--   A soft delete hides a row from every read and frees its name; archiving
--   keeps the row addressable, keeps its name reserved, and keeps its report
--   readable. Overloading `deleted_at` would mean "archive" and "delete"
--   became the same button with two labels, and un-deleting would then have
--   to exist as a supported operation — which it is not.
--
--   `campaigns.status` is also not this. Archiving is orthogonal to the state
--   machine: a completed campaign that is archived is still completed, and
--   adding `archived` to the CHECK constraint would destroy the one fact the
--   report is built on. Every transient state in that enum has a reconciler
--   and a deadline (R12); a state that means "filed away" would need neither
--   and would be the first exception.
--
-- Both columns are nullable with no default, so this is a catalogue-only
-- ALTER on PostgreSQL 11+ — no table rewrite, and the ACCESS EXCLUSIVE lock
-- is held for the duration of the catalogue update only.
--
-- No new index. Both tables already carry a composite index leading with
-- `workspace_id` (`ix_templates_ws_updated`, `ix_campaigns_ws_status`), and
-- `archived_at IS NULL` is a filter applied to the handful of rows those
-- indexes already narrow to — a workspace has tens of templates and
-- thousands of campaigns, not millions. Adding a partial index here would be
-- a guess at a shape we have not measured, and it would have to be
-- CREATE INDEX CONCURRENTLY in its own migration when we do (CLAUDE.md
-- section 8).
--
-- No RLS changes: both tables already have ENABLE/FORCE ROW LEVEL SECURITY
-- and a tenant policy from 0007 and 0009. A new column on an existing table
-- inherits them.
--
-- Immutable once merged (CLAUDE.md section 8).


ALTER TABLE templates  ADD COLUMN archived_at timestamptz;
ALTER TABLE campaigns  ADD COLUMN archived_at timestamptz;

COMMENT ON COLUMN templates.archived_at IS
  'Set when the template is archived (F1''s Archived tab). Not a delete: the row stays readable, its name stays reserved, and unarchive clears it.';

COMMENT ON COLUMN campaigns.archived_at IS
  'Set when a terminal campaign is filed away (G1''s Archive action). Orthogonal to status: an archived campaign keeps the status it finished in.';


-- ROLLBACK:
-- ALTER TABLE campaigns DROP COLUMN IF EXISTS archived_at;
-- ALTER TABLE templates DROP COLUMN IF EXISTS archived_at;
