-- 0002_identity.sql
--
-- Identity and workspace tables. DDL follows docs/02-database.md section 3
-- ("Identity and workspace") and the audit_logs definition from its
-- "Platform tables" subsection.
--
-- RLS policies and the two database roles are NOT here. They are the next
-- checklist item and land in 0003.
--
-- Immutable once merged (CLAUDE.md section 8). The runner checksums this file
-- and refuses to proceed if it changes after being applied.

-- citext gives case-insensitive uniqueness without a functional index on
-- lower(email). docs/02 specifies it for users.email, workspaces.slug and
-- workspace_invitations.email. Available on RDS; the migration role must have
-- privileges to create it.
CREATE EXTENSION IF NOT EXISTS citext;


-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                 uuid        PRIMARY KEY,
  email              citext      NOT NULL,
  email_verified_at  timestamptz,
  password_hash      text,
  name               text        NOT NULL,
  avatar_url         text,
  mfa_secret_enc     bytea,
  mfa_enabled_at     timestamptz,
  last_login_at      timestamptz,
  status             text        NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','suspended','deleted')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Partial, so a deleted account's address can be reused.
CREATE UNIQUE INDEX uq_users_email ON users (email) WHERE status <> 'deleted';


-- ---------------------------------------------------------------------------
-- workspaces
-- ---------------------------------------------------------------------------
CREATE TABLE workspaces (
  id                uuid        PRIMARY KEY,
  name              text        NOT NULL,
  slug              citext      NOT NULL,
  owner_user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status            text        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','past_due','suspended','cancelled','deleted')),
  suspended_at      timestamptz,
  timezone          text        NOT NULL DEFAULT 'UTC',
  default_currency  char(3)     NOT NULL DEFAULT 'USD',
  settings          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE UNIQUE INDEX uq_workspaces_slug ON workspaces (slug) WHERE deleted_at IS NULL;


-- ---------------------------------------------------------------------------
-- workspace_members
-- ---------------------------------------------------------------------------
CREATE TABLE workspace_members (
  id                    uuid        PRIMARY KEY,
  workspace_id          uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id               uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                  text        NOT NULL
                        CHECK (role IN ('owner','admin','editor','viewer')),
  permissions_override  jsonb,
  invited_by            uuid        REFERENCES users(id),
  joined_at             timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ws_member UNIQUE (workspace_id, user_id)
);

-- "which workspaces does this user belong to" - the workspace switcher.
CREATE INDEX ix_ws_members_user ON workspace_members (user_id);


-- ---------------------------------------------------------------------------
-- workspace_invitations
-- ---------------------------------------------------------------------------
CREATE TABLE workspace_invitations (
  id            uuid        PRIMARY KEY,
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email         citext      NOT NULL,
  role          text        NOT NULL CHECK (role IN ('admin','editor','viewer')),
  token_hash    bytea       NOT NULL,
  invited_by    uuid        NOT NULL REFERENCES users(id),
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One live invitation per address per workspace; superseded ones do not block.
CREATE UNIQUE INDEX uq_ws_invite_pending ON workspace_invitations (workspace_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX uq_ws_invite_token ON workspace_invitations (token_hash);


-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id                  uuid        PRIMARY KEY,
  user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash  bytea       NOT NULL,
  family_id           uuid        NOT NULL,
  user_agent          text,
  ip                  inet,
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  replaced_by         uuid        REFERENCES sessions(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_sessions_refresh ON sessions (refresh_token_hash);
CREATE INDEX ix_sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;


-- ---------------------------------------------------------------------------
-- audit_logs (range-partitioned on occurred_at)
-- ---------------------------------------------------------------------------
-- No primary key: a partitioned table's PK must include the partition key, and
-- docs/02 declares id as NOT NULL without one. This is an append-only log and
-- uniqueness of id is not relied upon.
CREATE TABLE audit_logs (
  id             uuid        NOT NULL,
  workspace_id   uuid,
  actor_type     text        NOT NULL
                 CHECK (actor_type IN ('user','api_key','system','provider')),
  actor_id       uuid,
  action         text        NOT NULL,
  resource_type  text        NOT NULL,
  resource_id    uuid,
  before         jsonb,
  after          jsonb,
  request_id     text,
  ip             inet,
  user_agent     text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (occurred_at);

CREATE INDEX ix_audit_ws_time ON audit_logs (workspace_id, occurred_at DESC);

-- A partitioned table with no partitions rejects every insert, so the first
-- months are seeded here. Ongoing creation belongs to the scheduler, which
-- does not exist until Phase 5. See the review note for this migration.
CREATE TABLE audit_logs_2026_09 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
CREATE TABLE audit_logs_2026_10 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE audit_logs_2026_11 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');

-- Catches anything outside the seeded ranges so an audit write can never fail
-- a user request. Rows landing here must be drained before the matching
-- monthly partition can be attached.
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;


-- ROLLBACK:
-- DROP TABLE IF EXISTS audit_logs;  -- cascades to its partitions
-- DROP TABLE IF EXISTS sessions;
-- DROP TABLE IF EXISTS workspace_invitations;
-- DROP TABLE IF EXISTS workspace_members;
-- DROP TABLE IF EXISTS workspaces;
-- DROP TABLE IF EXISTS users;
-- citext is left installed: other tables will depend on it and dropping an
-- extension is not safely reversible.
