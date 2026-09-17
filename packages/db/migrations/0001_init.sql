-- 0001_init.sql
--
-- Throwaway migration. Its only purpose is to prove the runner applies a
-- migration, records it in _relayd_migrations, and does nothing at all on a
-- second run. It encodes no schema decision: the real tables arrive in Phase 1
-- (identity), and this table may be dropped then.
--
-- Immutable once merged (CLAUDE.md section 8). The runner checksums this file
-- and refuses to proceed if it changes after being applied.

CREATE TABLE relayd_init_check (
  id         integer     PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  note       text        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO relayd_init_check (note) VALUES ('phase 0 migration runner proof');

-- ROLLBACK: DROP TABLE relayd_init_check;
