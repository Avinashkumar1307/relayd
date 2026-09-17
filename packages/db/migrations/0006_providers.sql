-- 0006_providers.sql
--
-- Provider connections, sender identities, sender accounts and the inbound
-- webhook inbox. DDL follows docs/02-database.md section 4 ("Providers and
-- senders"), with the amendments from docs/17-review-findings.md F4 folded in
-- rather than applied as later ALTERs.
--
-- Three deliberate departures from docs/02, all recorded in docs/16 §27:
--
--   1. endpoint_token and webhook_secret_arn are columns of the CREATE, not a
--      later ALTER. docs/02 lists them in its amendments block because the
--      original design predates F4; there is no table here to alter yet, and
--      a NOT NULL column added by ALTER to an empty table is the same thing
--      written twice.
--
--   2. provider_webhook_events is created in full. No document defines its
--      base table — docs/02 and docs/17 only ALTER it — so its columns are
--      derived from the ingest flow in docs/06 and the NormalisedEmailEvent
--      shape there.
--
--   3. Composite foreign keys on (id, workspace_id), as in 0005, so a sender
--      account belonging to workspace A cannot reference a provider
--      connection belonging to workspace B. RLS does not catch that: the row
--      carries one workspace_id and reads as legitimate from both sides.
--
-- sending_pools and sending_pool_members are deliberately NOT here. They
-- appear in the same docs/02 section but belong to Phase 6 routing, and
-- BUILD-PLAN Phase 3 item 1 does not list them.
--
-- Immutable once merged (CLAUDE.md section 8).


-- ---------------------------------------------------------------------------
-- provider_connections
--
-- credential_ref holds a Secrets Manager ARN. The database never holds a
-- customer's SES key or SMTP password, so a Postgres dump is not a credential
-- breach (docs/02 section 15, INVARIANTS R21).
--
-- endpoint_token is the unguessable per-connection webhook path segment from
-- F4. It is UNIQUE globally, not per workspace: it is resolved *before* any
-- workspace is known, so a collision between two workspaces would resolve an
-- event to the wrong tenant. That is the whole attack F4 describes.

CREATE TABLE provider_connections (
  id                 uuid        PRIMARY KEY,
  workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_type      text        NOT NULL
                     CHECK (provider_type IN ('ses','sendgrid','mailgun','brevo','smtp','google')),
  name               text        NOT NULL,
  status             text        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','verifying','active','degraded','disabled','revoked','error')),

  -- Secrets Manager ARN at relayd/{env}/ws/{workspaceId}/conn/{connectionId}
  -- (INVARIANTS R21, which outranks the older path in docs/07).
  credential_ref     text        NOT NULL,
  credential_version integer     NOT NULL DEFAULT 1,

  -- Non-secret only: region, host, port, api base. Enforced by review, not by
  -- the database; the credential itself never travels through this column.
  config             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  capabilities       jsonb       NOT NULL DEFAULT '{}'::jsonb,

  endpoint_token     text        NOT NULL,
  webhook_secret_arn text,

  quota_snapshot     jsonb,
  quota_checked_at   timestamptz,
  last_verified_at   timestamptz,
  last_error         jsonb,

  created_by         uuid        REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_provider_name UNIQUE (workspace_id, name),
  -- Referenceable by (id, workspace_id) so children cannot straddle tenants.
  CONSTRAINT uq_provider_conn_ws UNIQUE (id, workspace_id)
);

CREATE INDEX ix_provider_ws_status ON provider_connections (workspace_id, status);
CREATE UNIQUE INDEX uq_conn_endpoint_token ON provider_connections (endpoint_token);


-- ---------------------------------------------------------------------------
-- sender_identities
--
-- A domain or address the provider has verified. Sending from an unverified
-- identity is rejected by the provider, so this is the state the UI must show
-- before a campaign can be launched.

CREATE TABLE sender_identities (
  id                  uuid        PRIMARY KEY,
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id         uuid        NOT NULL,
  kind                text        NOT NULL CHECK (kind IN ('domain','email')),
  value               citext      NOT NULL,
  verification_status text        NOT NULL DEFAULT 'pending'
                      CHECK (verification_status IN ('pending','verified','failed','expired')),
  dkim_status         text,
  spf_status          text,
  dmarc_status        text,
  dns_records         jsonb,
  verified_at         timestamptz,
  last_checked_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_identity UNIQUE (provider_id, kind, value),
  CONSTRAINT uq_identity_ws UNIQUE (id, workspace_id),
  CONSTRAINT fk_identity_provider FOREIGN KEY (provider_id, workspace_id)
    REFERENCES provider_connections (id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX ix_identity_ws_provider ON sender_identities (workspace_id, provider_id);


-- ---------------------------------------------------------------------------
-- sender_accounts
--
-- A From address on a connection, with the limits and health the router reads.
--
-- identity_id is ON DELETE RESTRICT, not CASCADE: deleting a verified identity
-- out from under a sender that campaigns reference would leave those campaigns
-- unable to explain why they stopped.

CREATE TABLE sender_accounts (
  id                   uuid        PRIMARY KEY,
  workspace_id         uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id          uuid        NOT NULL,
  identity_id          uuid        NOT NULL,
  from_email           citext      NOT NULL,
  from_name            text        NOT NULL,
  reply_to             citext,
  status               text        NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','paused','cooling_down','disabled','failed')),

  -- Operator-set, and must never exceed what the provider permits. The
  -- guardrail is enforced in the send path (docs/07 section 10); this column
  -- only records the operator's intent.
  daily_limit          integer,
  hourly_limit         integer,
  concurrency_limit    smallint    NOT NULL DEFAULT 4,
  warmup_stage         smallint,
  health_score         smallint    NOT NULL DEFAULT 100 CHECK (health_score BETWEEN 0 AND 100),
  consecutive_failures smallint    NOT NULL DEFAULT 0,
  cooldown_until       timestamptz,
  last_send_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_sender UNIQUE (workspace_id, provider_id, from_email),
  CONSTRAINT uq_sender_ws UNIQUE (id, workspace_id),
  CONSTRAINT fk_sender_provider FOREIGN KEY (provider_id, workspace_id)
    REFERENCES provider_connections (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT fk_sender_identity FOREIGN KEY (identity_id, workspace_id)
    REFERENCES sender_identities (id, workspace_id) ON DELETE RESTRICT
);

-- Partial: the router only ever selects among active senders, and keeping the
-- disabled ones out of the index keeps it small and hot.
CREATE INDEX ix_sender_selectable ON sender_accounts (workspace_id, status, health_score DESC)
  WHERE status = 'active';


-- ---------------------------------------------------------------------------
-- provider_webhook_events
--
-- The inbound inbox. Every event a provider posts lands here first, verified
-- but unapplied, and a worker interprets it afterwards.
--
-- Three things make this table the enforcement point for F4 and R4:
--
--   provider_connection_id is resolved from the endpoint token in the URL, so
--   an event can only ever be attributed to the connection whose secret
--   signed it.
--
--   matched defaults to false. An event that resolves to no recipient of that
--   connection is stored and never applied. It is evidence, not an
--   instruction.
--
--   (provider_connection_id, dedupe_key) is UNIQUE, so a provider redelivering
--   the same event — which they all do — inserts nothing the second time.
--   ON CONFLICT DO NOTHING plus this index is the whole idempotency story.
--
-- BIGSERIAL rather than a uuid: this is append-only and high volume, and index
-- locality matters more than id unguessability for a row nobody addresses by
-- id from outside (CLAUDE.md section 8).

CREATE TABLE provider_webhook_events (
  id                     bigserial   PRIMARY KEY,
  workspace_id           uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_connection_id uuid        NOT NULL,
  provider_type          text        NOT NULL,

  -- The provider's own event id where it gives one, otherwise a hash of the
  -- payload. Never null: an event we cannot deduplicate is an event we will
  -- apply twice.
  dedupe_key             text        NOT NULL,

  matched                boolean     NOT NULL DEFAULT false,
  event_type             text,
  provider_message_id    text,
  recipient_email        citext,
  occurred_at            timestamptz,

  payload                jsonb       NOT NULL,
  received_at            timestamptz NOT NULL DEFAULT now(),
  processed_at           timestamptz,
  process_error          text,

  CONSTRAINT fk_pwe_connection FOREIGN KEY (provider_connection_id, workspace_id)
    REFERENCES provider_connections (id, workspace_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_pwe_dedupe
  ON provider_webhook_events (provider_connection_id, dedupe_key);

-- The worker claims unprocessed rows; the alarm counts unmatched ones.
CREATE INDEX ix_pwe_unprocessed ON provider_webhook_events (workspace_id, received_at)
  WHERE processed_at IS NULL;
CREATE INDEX ix_pwe_unmatched ON provider_webhook_events (workspace_id, received_at)
  WHERE NOT matched;


-- ---------------------------------------------------------------------------
-- Row-level security
--
-- NULLIF makes an unset scope fail closed: current_setting(..., true) returns
-- an empty string when app.workspace_id was never set, and ''::uuid raises
-- rather than matching nothing. NULLIF turns it into NULL, which matches no
-- row — a query with no scope returns nothing instead of erroring, which is
-- the behaviour the isolation suite asserts.

ALTER TABLE provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_connections_tenant ON provider_connections
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE sender_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE sender_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY sender_identities_tenant ON sender_identities
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE sender_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sender_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY sender_accounts_tenant ON sender_accounts
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE provider_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_webhook_events_tenant ON provider_webhook_events
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);


-- ROLLBACK:
-- DROP TABLE IF EXISTS provider_webhook_events;
-- DROP TABLE IF EXISTS sender_accounts;
-- DROP TABLE IF EXISTS sender_identities;
-- DROP TABLE IF EXISTS provider_connections;
