-- The public API surface (docs/02 "Platform tables", docs/03, docs/06).
--
-- Three things an external integrator needs and the dashboard does not: a
-- credential that is not a browser session, a way to make a mutating request
-- twice without paying twice, and a way to be told something happened without
-- polling for it.
--
-- Each of the three has one property that carries it:
--
--   **API keys** are stored hashed and shown once. The hash is both the
--   lookup key and the proof the caller holds the key; the prefix is what the
--   UI displays. A key that could be read back out of the database is a key
--   that leaks with a database backup.
--
--   **Idempotency keys** store the request hash alongside the response.
--   Reusing a key with a *different* body is an error rather than a silent
--   replay of the wrong response — which is the failure that turns a retry
--   into a charge for something the caller never asked for.
--
--   **Outbound deliveries** are one row per (endpoint, event), carrying the
--   attempt count and the most recent response. An integrator debugging a
--   missing event needs to see what we sent, when, and what came back; "we
--   tried" is not an answer anyone can act on.

-- --------------------------------------------------------------- api keys
--
-- Prefixed random 32 bytes, sha256 hashed, shown once. The hash is the lookup
-- key; the prefix is only what the UI displays.
--
-- docs/06 said argon2id here, and is corrected in the same commit. The reason
-- is the one `packages/utils/src/crypto/tokens.ts` already gives about
-- refresh and invitation tokens: 32 bytes of CSPRNG output is 256 bits of
-- full entropy, so there is nothing to brute-force and a KDF buys nothing. It
-- costs, though. argon2id at the documented m=64MB,t=3,p=4 is roughly 100ms
-- and 64MB per verification, on a path that runs on *every* public API
-- request and that an unauthenticated caller can make us run by spraying
-- invalid keys.
--
-- Unsalted also means the hash can be the lookup key, which is what makes
-- `uq_apikey_hash` below load-bearing rather than decorative.

CREATE TABLE api_keys (
  id            uuid        PRIMARY KEY,
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text        NOT NULL,

  -- Display only, e.g. `rk_live_a1b2c3d4`. Deliberately not unique: two keys
  -- sharing a display prefix is cosmetic, and a unique index here would turn
  -- it into a refused key creation.
  key_prefix    text        NOT NULL,
  -- sha256 of the whole key. The lookup key, and never read back out.
  key_hash      bytea       NOT NULL,

  -- Intersected with the role of the principal that minted the key. A key can
  -- never exceed that role, and `billing:write` is never grantable — enforced
  -- in `packages/types/permissions.ts` and again at issue time.
  scopes        text[]      NOT NULL DEFAULT '{}',

  -- Written at most once per minute per key rather than per request: a
  -- timestamp update on every call turns a read path into a write path.
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The lookup, and the guard. One index probe per authenticated request, and a
-- hash computed over a constant collides on the second key rather than
-- quietly authenticating everybody.
--
-- Total rather than partial: a revoked key must still be found, so the caller
-- can be told the key was revoked rather than told it never existed. The
-- revocation check is the row, not the index.
CREATE UNIQUE INDEX uq_apikey_hash ON api_keys (key_hash);

-- For the UI, which lists a workspace's live keys by their visible prefix.
CREATE INDEX ix_apikey_prefix ON api_keys (key_prefix) WHERE revoked_at IS NULL;
CREATE INDEX ix_apikey_ws ON api_keys (workspace_id, created_at DESC);


-- ------------------------------------------------------- idempotency keys
--
-- docs/03: required on every POST that creates or charges, honoured for 24
-- hours. The row is claimed before the work starts, so two concurrent
-- requests with the same key cannot both run.

CREATE TABLE idempotency_keys (
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key           text        NOT NULL,
  -- Part of the primary key: the same idempotency key used against two
  -- different endpoints is two different requests, and collapsing them would
  -- replay a campaign launch as a contact import.
  endpoint      text        NOT NULL,

  -- What makes this safe. Reusing a key with a different body is
  -- `409 idempotency_key_reuse`, not a replay of a response that answers a
  -- question nobody asked.
  request_hash  bytea       NOT NULL,

  status        text        NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_code smallint,
  response_body jsonb,

  -- When the claim was taken. A row stuck `in_progress` past the lock
  -- timeout is a crashed request, and the sweeper releases it rather than
  -- leaving the caller unable to retry for 24 hours.
  locked_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,

  PRIMARY KEY (workspace_id, key, endpoint)
);

CREATE INDEX ix_idem_expiry ON idempotency_keys (expires_at);
CREATE INDEX ix_idem_stuck ON idempotency_keys (locked_at) WHERE status = 'in_progress';


-- ------------------------------------------------------ outbound webhooks
--
-- The endpoint row holds the subscription; the delivery rows hold the
-- evidence. Splitting them matters because the evidence is high-volume and
-- the subscription is not, and because an integrator debugging a missing
-- event needs the attempts rather than a counter.

CREATE TABLE outbound_webhook_endpoints (
  id            uuid        PRIMARY KEY,
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url           text        NOT NULL,

  -- A Secrets Manager ARN, never the secret. Same rule as provider
  -- credentials: the database stores a pointer (CLAUDE.md section 2).
  secret_ref    text        NOT NULL,
  -- The previous secret, live until `secret_rotated_at` + the overlap window,
  -- so a rotation does not break an integrator mid-deploy.
  previous_secret_ref text,
  secret_rotated_at timestamptz,

  events        text[]      NOT NULL,

  status        text        NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'failing', 'disabled')),

  -- `failing` is a warning state and `disabled` is terminal. The distinction
  -- exists so a customer whose endpoint was down for an hour is not treated
  -- like one whose endpoint has been gone for a week.
  consecutive_failures smallint NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  disabled_at   timestamptz,
  disabled_reason text,

  description   text,
  created_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_owe_ws ON outbound_webhook_endpoints (workspace_id, created_at DESC);
CREATE INDEX ix_owe_active ON outbound_webhook_endpoints (workspace_id)
  WHERE status IN ('active', 'failing');

-- One row per (endpoint, event). `attempt` counts the tries and the response
-- columns hold the most recent one, so a delivery that succeeded on the
-- fourth go reads as attempt 4 with a 200, and one still failing reads as its
-- last error. The unique index below is what makes a producer emitting the
-- same event twice send it once.
--
-- BIGSERIAL rather than a uuid: append-only, high-volume, and never
-- referenced from anywhere else, so index locality beats a sortable id
-- (CLAUDE.md section 8).
CREATE TABLE outbound_webhook_deliveries (
  id            bigserial,
  workspace_id  uuid        NOT NULL,
  endpoint_id   uuid        NOT NULL REFERENCES outbound_webhook_endpoints(id) ON DELETE CASCADE,

  event_type    text        NOT NULL,
  -- Ours, and sent in the payload. An integrator deduplicates on this, and a
  -- retry carries the same one — which is the whole reason a retry is safe
  -- for them to accept.
  event_id      uuid        NOT NULL,
  payload       jsonb       NOT NULL,

  attempt       smallint    NOT NULL DEFAULT 1,
  status        text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed', 'abandoned')),

  response_code smallint,
  -- Truncated by the caller. An endpoint returning a 2MB HTML error page must
  -- not be able to fill this table.
  response_body text,
  error         text,
  duration_ms   integer,

  scheduled_for timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE TABLE outbound_webhook_deliveries_2026_09 PARTITION OF outbound_webhook_deliveries
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE outbound_webhook_deliveries_2026_10 PARTITION OF outbound_webhook_deliveries
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

ALTER TABLE outbound_webhook_deliveries_2026_09 ADD PRIMARY KEY (id, created_at);
ALTER TABLE outbound_webhook_deliveries_2026_10 ADD PRIMARY KEY (id, created_at);

CREATE INDEX ix_owd_endpoint_2026_09 ON outbound_webhook_deliveries_2026_09
  (endpoint_id, created_at DESC);
CREATE INDEX ix_owd_endpoint_2026_10 ON outbound_webhook_deliveries_2026_10
  (endpoint_id, created_at DESC);

-- The work queue for the retry worker. Partial, so it stays small however
-- many delivered rows accumulate behind it.
CREATE INDEX ix_owd_due_2026_09 ON outbound_webhook_deliveries_2026_09 (scheduled_for)
  WHERE status = 'pending';
CREATE INDEX ix_owd_due_2026_10 ON outbound_webhook_deliveries_2026_10 (scheduled_for)
  WHERE status = 'pending';

-- One delivery per (endpoint, event), so a producer that emits the same event
-- twice does not send it twice. Retries increment `attempt` on this row
-- rather than inserting another.
CREATE UNIQUE INDEX uq_owd_event_2026_09 ON outbound_webhook_deliveries_2026_09
  (endpoint_id, event_id);
CREATE UNIQUE INDEX uq_owd_event_2026_10 ON outbound_webhook_deliveries_2026_10
  (endpoint_id, event_id);


-- --------------------------------------------------------------------- RLS

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY api_keys_tenant ON api_keys
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_tenant ON idempotency_keys
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE outbound_webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_webhook_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY outbound_webhook_endpoints_tenant ON outbound_webhook_endpoints
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

-- On the partitioned parent, so a partition the scheduler creates later is
-- covered without anybody remembering to enable it.
ALTER TABLE outbound_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY outbound_webhook_deliveries_tenant ON outbound_webhook_deliveries
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);


-- ROLLBACK:
-- DROP TABLE IF EXISTS outbound_webhook_deliveries;
-- DROP TABLE IF EXISTS outbound_webhook_endpoints;
-- DROP TABLE IF EXISTS idempotency_keys;
-- DROP TABLE IF EXISTS api_keys;
