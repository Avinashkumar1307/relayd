-- 0023_suppressions_source_index.sql
--
-- The index behind D7's "Source" filter, built without taking the table out.
--
-- 0020 added `suppressions.source_campaign_id`. Indexing it belongs here and
-- not there for one reason: `suppressions` is a populated table on the send
-- path. Suppression is re-checked at send time (CLAUDE.md section 12), so a
-- plain CREATE INDEX — which holds ACCESS EXCLUSIVE until the build finishes
-- — would stall every dispatcher on the box for as long as the scan takes.
-- CLAUDE.md section 8: CREATE INDEX CONCURRENTLY, always in its own
-- migration.
--
-- Partial, because the column is null for every suppression that did not come
-- from a campaign, which is most of them: an import, a complaint webhook and
-- a manual entry all leave it null. The filter only ever asks for the rows
-- that have one.
--
-- CONCURRENTLY cannot run inside a transaction block, so this file opts out of
-- the runner's wrapping transaction. That has a consequence worth stating: a
-- failed CONCURRENTLY build leaves an INVALID index behind rather than rolling
-- back. If this migration fails, drop the index and run it again — the
-- ROLLBACK below is also the recovery.

-- RELAYD:no-transaction

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_suppressions_ws_source
  ON suppressions (workspace_id, source_campaign_id)
  WHERE source_campaign_id IS NOT NULL;

-- ROLLBACK:
-- DROP INDEX CONCURRENTLY IF EXISTS ix_suppressions_ws_source;
