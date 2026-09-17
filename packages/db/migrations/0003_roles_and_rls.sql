-- 0003_roles_and_rls.sql
--
-- The two database roles and row-level security, per CLAUDE.md section 8 and
-- docs/06 section 15 ("L4 Postgres RLS as backstop").
--
-- RLS is layer four of four. Layers one to three (auth middleware,
-- authorization, the WorkspaceScope-typed repository) are where isolation is
-- actually enforced. This layer exists so that a bug in any of them is
-- contained rather than catastrophic, which is why docs/06 insists it is
-- enabled from day one: retrofitting means auditing every query ever written.
--
-- Immutable once merged (CLAUDE.md section 8).


-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
-- relayd_app   RLS enforced. Used by api, edge, and every single-workspace job.
-- relayd_global BYPASSRLS. Used ONLY by the cross-tenant job types allowlisted
--               in packages/queue/global-jobs.ts (INVARIANTS R20).
--
-- Created with LOGIN but no password. A role with LOGIN and no password cannot
-- authenticate under scram-sha-256, so this fails closed: the roles exist and
-- own their grants, but nothing can connect as them until an operator sets a
-- password out of band. Passwords never belong in a migration that is
-- committed to version control.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'relayd_app') THEN
    CREATE ROLE relayd_app LOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'relayd_global') THEN
    CREATE ROLE relayd_global LOGIN BYPASSRLS;
  END IF;
END
$$;

-- BYPASSRLS is set unconditionally so that a role created by an earlier hand
-- still ends up with the documented attribute, and relayd_app is explicitly
-- denied it in case someone granted it manually.
ALTER ROLE relayd_global BYPASSRLS;
ALTER ROLE relayd_app NOBYPASSRLS;


-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO relayd_app, relayd_global;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO relayd_app, relayd_global;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO relayd_app, relayd_global;

-- Tables created by later migrations inherit these grants automatically, so a
-- new table is never silently unreadable by the application.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO relayd_app, relayd_global;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO relayd_app, relayd_global;

-- Neither role may create objects. Schema changes are migrations only.
REVOKE CREATE ON SCHEMA public FROM relayd_app, relayd_global;


-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Applied to tenant-owned tables only.
--
-- users and sessions are deliberately NOT tenant-scoped. A user exists before
-- any workspace is chosen and may belong to several; the login, refresh and
-- password-reset paths all run with no workspace in context, so a workspace
-- predicate on those tables would make authentication impossible. They are
-- protected by layer three instead: their repositories live in
-- packages/db/repositories/global/ and are named exceptions.
--
-- The NULLIF is load-bearing. current_setting('app.workspace_id', true)
-- returns NULL when unset, but the empty string if something set it to ''.
-- Casting '' to uuid raises an error rather than denying access; NULLIF turns
-- it back into NULL, and `workspace_id = NULL` is NULL, which is not true, so
-- no rows are visible. Unset scope therefore fails closed.

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_tenant ON workspaces
  USING (id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_members_tenant ON workspace_members
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_invitations_tenant ON workspace_invitations
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

-- audit_logs.workspace_id is nullable: platform-level events belong to no
-- workspace. Those rows match no policy and are invisible to relayd_app by
-- design; they are read by operators through relayd_global.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_tenant ON audit_logs
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);


-- ROLLBACK:
-- DROP POLICY IF EXISTS audit_logs_tenant ON audit_logs;
-- DROP POLICY IF EXISTS workspace_invitations_tenant ON workspace_invitations;
-- DROP POLICY IF EXISTS workspace_members_tenant ON workspace_members;
-- DROP POLICY IF EXISTS workspaces_tenant ON workspaces;
-- ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE workspace_invitations NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE workspace_invitations DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE workspace_members NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE workspace_members DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE workspaces NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE workspaces DISABLE ROW LEVEL SECURITY;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM relayd_app, relayd_global;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM relayd_app, relayd_global;
-- REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM relayd_app, relayd_global;
-- REVOKE ALL ON ALL TABLES IN SCHEMA public FROM relayd_app, relayd_global;
-- REVOKE USAGE ON SCHEMA public FROM relayd_app, relayd_global;
-- DROP ROLE IF EXISTS relayd_global;
-- DROP ROLE IF EXISTS relayd_app;
