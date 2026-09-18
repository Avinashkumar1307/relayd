-- The partition-maintenance schedule (INVARIANTS R25).
--
-- Held back from 0010 deliberately: that migration seeds only schedules whose
-- queue exists, and `partition-maintenance` had none. A schedule naming a
-- queue that does not exist throws on every tick, which is worse than the gap
-- it would fill. The queue arrives with this migration's commit.
--
-- 0010's closing comment says this lands "in Phase 7", which is here. That
-- comment is left as written: migrations are immutable once merged (CLAUDE.md
-- section 8) and `runMigrations` checksums them, so editing a merged file —
-- even its comments — makes `db:migrate` fail on every database that has
-- already applied it. A stale comment is cheaper than that, and this note is
-- where the correction belongs.
--
-- 03:17 rather than 03:00. Every scheduled job in every system is written for
-- the top of the hour, and this one takes a brief lock on the busiest table
-- we have; an odd minute costs nothing and avoids the crowd.
--
-- ON CONFLICT DO NOTHING, like 0010: `db:migrate` stays idempotent, and an
-- operator who disables this does not have it re-enabled by the next deploy.

INSERT INTO scheduled_jobs (name, cron, queue, payload, next_run_at) VALUES
  ('partition-maintenance', '17 3 * * *', 'partition-maintenance', '{}'::jsonb, now())
ON CONFLICT (name) DO NOTHING;


-- ROLLBACK:
-- DELETE FROM scheduled_jobs WHERE name = 'partition-maintenance';
