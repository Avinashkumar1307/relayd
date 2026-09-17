<!-- Database schema — baseline DDL plus review amendments -->
> **Source of truth note.** This file is extracted from the Technical Design Document v0.1. Where it conflicts with `docs/17-review-findings.md` or `INVARIANTS.md`, those two files win — they contain the corrections from the independent adversarial review. Implement the corrected design, not the original where they differ.

# 3. Database architecture, part 1: conventions, identity, audience

Every tenant-owned table carries a non-null `workspace_id` and a composite index leading with it. That single rule is what makes isolation enforceable and queries fast.

## Conventions

| Rule | Choice | Reason |
| --- | --- | --- |
| Primary keys | `uuid` v7 generated in app | Time-sortable so B-tree inserts stay at the right edge; no round trip for the id; no sequence leakage across tenants |
| Timestamps | `timestamptz`, always UTC | `timestamp` without zone is the single most common data bug in scheduling systems |
| Money | `bigint` minor units + `char(3)` currency | Never float, never `numeric` for money you send to a payment provider |
| Soft delete | `deleted_at timestamptz` on contacts, templates, campaigns only | Everything else hard-deletes. Soft delete everywhere is a query-correctness tax |
| Enums | Postgres `text` + `CHECK` constraint | `ALTER TYPE … ADD VALUE` cannot run in a transaction; `CHECK` can be changed in a normal migration |
| Naming | `snake_case`, plural tables, `fk_`, `uq_`, `ix_` prefixes | Consistent grep-ability |
| JSON | `jsonb`, always with a Zod parse on read | `json` loses the binary index |
| Tenant column | `workspace_id uuid NOT NULL` on every tenant table | Non-negotiable |

## Identity and workspace

```sql
CREATE TABLE users (
  id                uuid PRIMARY KEY,
  email             citext NOT NULL,
  email_verified_at timestamptz,
  password_hash     text,                       -- null when SSO-only
  name              text NOT NULL,
  avatar_url        text,
  mfa_secret_enc    bytea,                      -- KMS envelope, see s15
  mfa_enabled_at    timestamptz,
  last_login_at     timestamptz,
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','deleted')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_users_email ON users (email) WHERE status <> 'deleted';

CREATE TABLE workspaces (
  id             uuid PRIMARY KEY,
  name           text NOT NULL,
  slug           citext NOT NULL,
  owner_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','past_due','suspended','cancelled','deleted')),
  suspended_at   timestamptz,
  timezone       text NOT NULL DEFAULT 'UTC',
  default_currency char(3) NOT NULL DEFAULT 'USD',
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE UNIQUE INDEX uq_workspaces_slug ON workspaces (slug) WHERE deleted_at IS NULL;

CREATE TABLE workspace_members (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
  permissions_override jsonb,                   -- rare per-seat grants/denies
  invited_by   uuid REFERENCES users(id),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ws_member UNIQUE (workspace_id, user_id)
);
CREATE INDEX ix_ws_members_user ON workspace_members (user_id);

CREATE TABLE workspace_invitations (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        citext NOT NULL,
  role         text NOT NULL CHECK (role IN ('admin','editor','viewer')),
  token_hash   bytea NOT NULL,                  -- sha256 of the emailed token
  invited_by   uuid NOT NULL REFERENCES users(id),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_ws_invite_pending ON workspace_invitations (workspace_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX uq_ws_invite_token ON workspace_invitations (token_hash);

CREATE TABLE sessions (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash bytea NOT NULL,
  family_id       uuid NOT NULL,                -- rotation family, see s15
  user_agent      text,
  ip              inet,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  replaced_by     uuid REFERENCES sessions(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_sessions_refresh ON sessions (refresh_token_hash);
CREATE INDEX ix_sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;
```

Notes on choices here. `citext` for email avoids an entire class of duplicate-account bug. The refresh token is stored hashed with a `family_id` so that reuse of a rotated token can revoke the whole family — standard refresh-token-rotation theft detection. `owner_user_id` is `ON DELETE RESTRICT` so a workspace can never be orphaned.

## Audience

```sql
CREATE TABLE contacts (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email         citext NOT NULL,
  email_domain  text GENERATED ALWAYS AS (split_part(lower(email::text),'@',2)) STORED,
  first_name    text,
  last_name     text,
  status        text NOT NULL DEFAULT 'subscribed'
                CHECK (status IN ('subscribed','unsubscribed','bounced','complained','cleaned')),
  source        text NOT NULL DEFAULT 'manual'
                CHECK (source IN ('manual','import','api','form','automation')),
  consent_status text NOT NULL DEFAULT 'unknown'
                CHECK (consent_status IN ('unknown','single_optin','double_optin','imported_declared')),
  consent_at    timestamptz,
  consent_ip    inet,
  consent_source text,
  attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_engaged_at timestamptz,
  engagement_score smallint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE UNIQUE INDEX uq_contacts_ws_email ON contacts (workspace_id, email) WHERE deleted_at IS NULL;
CREATE INDEX ix_contacts_ws_status ON contacts (workspace_id, status) WHERE deleted_at IS NULL;
CREATE INDEX ix_contacts_ws_created ON contacts (workspace_id, created_at DESC);
CREATE INDEX ix_contacts_attrs ON contacts USING gin (attributes jsonb_path_ops);
CREATE INDEX ix_contacts_domain ON contacts (workspace_id, email_domain);

CREATE TABLE contact_lists (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text,
  member_count integer NOT NULL DEFAULT 0,        -- denormalised, reconciled nightly
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_list_name UNIQUE (workspace_id, name)
);

> **Phase 2 correction (implemented).** `contact_list_members` and
> `contact_tags` reference `(id, workspace_id)` compositely rather than
> `id` alone, and `contacts`, `contact_lists`, `tags` and `import_jobs` each
> carry a `UNIQUE (id, workspace_id)` to support that.
>
> With plain foreign keys, a list from workspace A and a contact from
> workspace B satisfy both constraints independently and produce a membership
> row straddling two tenants. RLS does not catch it either: the row carries one
> `workspace_id` and looks legitimate from both sides. `docs/06` section 15
> part 4 requires that "adding B's contact to A's list fails" — the composite
> key is what makes it fail in the database rather than only in a service that
> remembered to check.

CREATE TABLE contact_list_members (
  workspace_id uuid NOT NULL,
  list_id      uuid NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
  contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_at     timestamptz NOT NULL DEFAULT now(),
  added_by     text NOT NULL DEFAULT 'manual',
  PRIMARY KEY (list_id, contact_id)
);
CREATE INDEX ix_clm_contact ON contact_list_members (contact_id);
CREATE INDEX ix_clm_ws_list ON contact_list_members (workspace_id, list_id);

CREATE TABLE tags (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         citext NOT NULL,
  color        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_tag_name UNIQUE (workspace_id, name)
);

CREATE TABLE contact_tags (
  workspace_id uuid NOT NULL,
  contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id       uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  tagged_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);
CREATE INDEX ix_contact_tags_tag ON contact_tags (tag_id);

CREATE TABLE segments (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  definition    jsonb NOT NULL,                  -- AST, see below
  kind          text NOT NULL DEFAULT 'dynamic' CHECK (kind IN ('dynamic','static')),
  cached_count  integer,
  cached_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_segment_name UNIQUE (workspace_id, name)
);

CREATE TABLE suppressions (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email         citext NOT NULL,
  email_hash    bytea NOT NULL,                  -- sha256, for fast set membership
  reason        text NOT NULL
                CHECK (reason IN ('unsubscribe','hard_bounce','complaint','manual','global_block','invalid')),
  scope         text NOT NULL DEFAULT 'workspace'
                CHECK (scope IN ('workspace','campaign','list')),
  scope_ref_id  uuid,
  source_event_id uuid,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_suppression ON suppressions (workspace_id, email, scope, COALESCE(scope_ref_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX ix_suppressions_hash ON suppressions (workspace_id, email_hash);
```

## Segment definition AST

Segments are stored as a validated JSON AST and compiled to SQL server-side. Never store user SQL.

```json
{
  "op": "and",
  "children": [
    { "op": "in_list", "listId": "018f..." },
    { "op": "not", "child": { "op": "has_tag", "tagId": "018f..." } },
    { "op": "attr", "path": "country", "cmp": "eq", "value": "AE" },
    { "op": "engaged", "event": "click", "withinDays": 90 }
  ]
}
```

The compiler emits parameterised SQL with a hard cap on AST depth (6) and node count (40). `engaged` predicates resolve against the pre-aggregated `contact_engagement` rollup, not the raw event partitions, because a segment preview must return in under 2 seconds.

## Import staging

> **Phase 2 correction (implemented).** The table below is named `import_jobs`,
> not `contact_imports`, and a second table `import_row_errors` holds per-row
> failures. `BUILD-PLAN.md` Phase 2 and `docs/15-roadmap.md` both name those
> two tables, and `BUILD-PLAN.md` outranks this file (`CLAUDE.md` section 1).
> Columns are otherwise exactly as given below.
>
> `import_row_errors` exists because Phase 2 requires per-row errors and a
> failed-row CSV download. Keeping them in a table means the UI can page
> through failures without fetching an object from S3, and local development
> needs no object store at all. `error_report_s3_key` and `error_summary`
> remain for the exported report.

```sql
CREATE TABLE contact_imports (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  s3_key        text NOT NULL,
  original_filename text NOT NULL,
  byte_size     bigint NOT NULL,
  file_type     text NOT NULL CHECK (file_type IN ('csv','tsv','xlsx')),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','mapping','validating','processing','completed','failed','cancelled')),
  column_mapping jsonb,
  options       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {updateExisting, addToListIds, tagIds, consentDeclaration}
  total_rows    integer,
  processed_rows integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  failed_count  integer NOT NULL DEFAULT 0,
  error_report_s3_key text,
  error_summary jsonb,
  created_by    uuid REFERENCES users(id),
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_imports_ws_status ON contact_imports (workspace_id, status, created_at DESC);
```

`options.consentDeclaration` is mandatory and recorded: the importer must assert where consent came from. It is stored on every contact created by that import. This is what lets you defend a workspace when a provider or a regulator asks, and it is what lets you suspend a workspace that lied.


---

# 4. Database architecture, part 2: delivery, campaigns, events, analytics

`campaign_recipients` is the heart of the system. It is the idempotency key, the state machine, the progress counter and the billing evidence, all in one row.

## Providers, senders, pools

```sql
CREATE TABLE provider_connections (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_type  text NOT NULL
                 CHECK (provider_type IN ('ses','sendgrid','mailgun','brevo','smtp','google')),
  name           text NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','verifying','active','degraded','disabled','revoked','error')),
  credential_ref text NOT NULL,                 -- Secrets Manager ARN, never the secret
  credential_version integer NOT NULL DEFAULT 1,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- region, host, port, api base, non-secret only
  capabilities   jsonb NOT NULL DEFAULT '{}'::jsonb,  -- discovered: webhooks, templates, batch size
  webhook_secret_ref text,
  quota_snapshot jsonb,                         -- last known provider-reported limits
  quota_checked_at timestamptz,
  last_verified_at timestamptz,
  last_error     jsonb,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_provider_name UNIQUE (workspace_id, name)
);
CREATE INDEX ix_provider_ws_status ON provider_connections (workspace_id, status);

CREATE TABLE sender_identities (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id    uuid NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('domain','email')),
  value          citext NOT NULL,               -- example.com or hi@example.com
  verification_status text NOT NULL DEFAULT 'pending'
                 CHECK (verification_status IN ('pending','verified','failed','expired')),
  dkim_status    text, spf_status text, dmarc_status text,
  dns_records    jsonb,
  verified_at    timestamptz,
  last_checked_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_identity UNIQUE (provider_id, kind, value)
);

CREATE TABLE sender_accounts (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id     uuid NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  identity_id     uuid NOT NULL REFERENCES sender_identities(id) ON DELETE RESTRICT,
  from_email      citext NOT NULL,
  from_name       text NOT NULL,
  reply_to        citext,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','paused','cooling_down','disabled','failed')),
  daily_limit     integer,                       -- operator-set, must be <= provider limit
  hourly_limit    integer,
  concurrency_limit smallint NOT NULL DEFAULT 4,
  warmup_stage    smallint,
  health_score    smallint NOT NULL DEFAULT 100 CHECK (health_score BETWEEN 0 AND 100),
  consecutive_failures smallint NOT NULL DEFAULT 0,
  cooldown_until  timestamptz,
  last_send_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sender UNIQUE (workspace_id, provider_id, from_email)
);
CREATE INDEX ix_sender_selectable ON sender_accounts (workspace_id, status, health_score DESC)
  WHERE status = 'active';

CREATE TABLE sending_pools (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  strategy      text NOT NULL DEFAULT 'weighted'
                CHECK (strategy IN ('round_robin','weighted','failover','least_loaded')),
  is_default    boolean NOT NULL DEFAULT false,
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_pool_name UNIQUE (workspace_id, name)
);
CREATE UNIQUE INDEX uq_pool_default ON sending_pools (workspace_id) WHERE is_default;

CREATE TABLE sending_pool_members (
  workspace_id      uuid NOT NULL,
  pool_id           uuid NOT NULL REFERENCES sending_pools(id) ON DELETE CASCADE,
  sender_account_id uuid NOT NULL REFERENCES sender_accounts(id) ON DELETE CASCADE,
  weight            smallint NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 1000),
  priority          smallint NOT NULL DEFAULT 100,   -- lower first, for failover
  enabled           boolean NOT NULL DEFAULT true,
  PRIMARY KEY (pool_id, sender_account_id)
);
```

`credential_ref` holds a Secrets Manager ARN. The database never holds a customer's SES key or SMTP password, so a Postgres dump is not a credential breach. Section 15.

## Templates

```sql
CREATE TABLE templates (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  category      text,
  current_version_id uuid,                     -- FK added after template_versions
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE TABLE template_versions (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  template_id   uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  subject       text NOT NULL,
  preheader     text,
  html_source   text NOT NULL,                  -- author input (MJML or raw HTML)
  html_compiled text NOT NULL,                  -- sanitised, inlined, ready to send
  text_body     text NOT NULL,
  design_json   jsonb,                          -- visual builder state
  variables     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- discovered merge tags + defaults
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_tpl_version UNIQUE (template_id, version)
);
ALTER TABLE templates ADD CONSTRAINT fk_tpl_current
  FOREIGN KEY (current_version_id) REFERENCES template_versions(id) ON DELETE SET NULL;
```

Versions are immutable. A campaign pins `template_version_id`, so editing a template never mutates an in-flight or already-sent campaign. This also makes "what exactly did we send?" answerable a year later.

## Campaigns and recipients

```sql
CREATE TABLE campaigns (
  id                 uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               text NOT NULL,
  type               text NOT NULL DEFAULT 'regular'
                     CHECK (type IN ('regular','ab_test','transactional')),
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','validating','scheduled','queueing','running',
                                       'paused','pausing','cancelling','cancelled',
                                       'completed','completed_with_errors','failed')),
  template_version_id uuid REFERENCES template_versions(id) ON DELETE RESTRICT,
  subject_override   text,
  sending_pool_id    uuid REFERENCES sending_pools(id) ON DELETE RESTRICT,
  sender_account_id  uuid REFERENCES sender_accounts(id) ON DELETE RESTRICT,
  audience           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {listIds, segmentIds, tagIds, excludeListIds}
  tracking           jsonb NOT NULL DEFAULT '{"opens":true,"clicks":true}'::jsonb,
  throttle_per_hour  integer,
  scheduled_at       timestamptz,
  timezone           text,
  recipient_count    integer NOT NULL DEFAULT 0,
  sent_count         integer NOT NULL DEFAULT 0,
  failed_count       integer NOT NULL DEFAULT 0,
  suppressed_count   integer NOT NULL DEFAULT 0,
  snapshot_at        timestamptz,
  launched_at        timestamptz,
  launched_by        uuid REFERENCES users(id),
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  paused_at          timestamptz,
  idempotency_key    text,
  cloned_from        uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX ix_campaigns_ws_status ON campaigns (workspace_id, status, created_at DESC);
CREATE INDEX ix_campaigns_due ON campaigns (scheduled_at)
  WHERE status = 'scheduled';
CREATE UNIQUE INDEX uq_campaign_idem ON campaigns (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The most important table in the system.
CREATE TABLE campaign_recipients (
  id                 uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL,
  campaign_id        uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id         uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  email              citext NOT NULL,            -- snapshot, not a join
  merge_data         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- snapshot at launch
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','queued','sending','sent','failed',
                                       'suppressed','cancelled','bounced','complained')),
  attempt_count      smallint NOT NULL DEFAULT 0,
  sender_account_id  uuid REFERENCES sender_accounts(id) ON DELETE SET NULL,
  provider_id        uuid REFERENCES provider_connections(id) ON DELETE SET NULL,
  provider_message_id text,
  message_token      bytea NOT NULL,             -- 16 random bytes; basis of tracking tokens
  metered            boolean NOT NULL DEFAULT false,
  error_code         text,
  error_detail       text,
  queued_at          timestamptz,
  sent_at            timestamptz,
  failed_at          timestamptz,
  next_attempt_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_cr_campaign_contact ON campaign_recipients (campaign_id, contact_id);
CREATE UNIQUE INDEX uq_cr_token ON campaign_recipients (message_token);
CREATE INDEX ix_cr_dispatch ON campaign_recipients (campaign_id, status, id)
  WHERE status IN ('pending','queued');
CREATE INDEX ix_cr_provider_msg ON campaign_recipients (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX ix_cr_retry ON campaign_recipients (next_attempt_at)
  WHERE status = 'failed' AND next_attempt_at IS NOT NULL;
```

Five things this table buys us at once:

1. `uq_cr_campaign_contact` makes double-sending structurally impossible, no lock required.
2. `metered boolean` makes billing idempotent: usage is incremented in the same transaction that flips it false→true. Section 8.
3. `merge_data` snapshotting means a contact edited mid-campaign does not change what the remaining recipients receive, and a deleted contact does not break the send.
4. `message_token` is the tracking primitive; the token in the pixel URL derives from it, so a leaked URL reveals nothing joinable.
5. `ix_cr_dispatch` is a partial index that shrinks to nothing as the campaign completes, so dispatch stays fast on a 10M-row table.

At very large scale `campaign_recipients` is partitioned by `HASH (campaign_id)` into 32 partitions. Do this from day 1 if you expect campaigns above 1M recipients; otherwise adopt it at the 100M-row mark. **Decision required.**

## Events

One table, partitioned monthly, for everything that happens to a message.

```sql
CREATE TABLE email_events (
  id                    uuid NOT NULL,
  workspace_id          uuid NOT NULL,
  campaign_id           uuid,
  campaign_recipient_id uuid,
  contact_id            uuid,
  provider_id           uuid,
  event_type            text NOT NULL
    CHECK (event_type IN ('queued','sent','delivered','deferred','bounce','complaint',
                          'open','click','unsubscribe','reject','failed')),
  bounce_class          text,          -- hard | soft | block | suppressed
  provider_message_id   text,
  provider_event_id     text,
  link_id               uuid,
  url                   text,
  user_agent            text,
  ip_hash               bytea,         -- hashed, never raw IP, see s15
  geo_country           char(2),
  device_type           text,
  client_family         text,
  is_bot                boolean NOT NULL DEFAULT false,
  is_prefetch           boolean NOT NULL DEFAULT false,   -- Apple MPP / scanner heuristic
  payload               jsonb,
  occurred_at           timestamptz NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (occurred_at);

CREATE TABLE email_events_2026_09 PARTITION OF email_events
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

-- per partition
ALTER TABLE email_events_2026_09 ADD PRIMARY KEY (id, occurred_at);
CREATE UNIQUE INDEX uq_ee_dedup_2026_09 ON email_events_2026_09
  (provider_id, provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX ix_ee_campaign_2026_09 ON email_events_2026_09 (campaign_id, event_type, occurred_at);
CREATE INDEX ix_ee_recipient_2026_09 ON email_events_2026_09 (campaign_recipient_id);
CREATE INDEX ix_ee_ws_time_2026_09 ON email_events_2026_09 (workspace_id, occurred_at DESC);
```

Partitions are created 3 months ahead by the scheduler and detached-then-archived to S3 Parquet past the plan's retention window. `(provider_id, provider_event_id)` unique per partition is the webhook dedup guarantee. Section 13.

## Tracked links and analytics rollups

```sql
CREATE TABLE tracked_links (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  campaign_id   uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  url           text NOT NULL,
  url_hash      bytea NOT NULL,
  label         text,
  position      smallint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_link UNIQUE (campaign_id, url_hash)
);

CREATE TABLE campaign_stats (
  campaign_id   uuid PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL,
  recipients    integer NOT NULL DEFAULT 0,
  sent          integer NOT NULL DEFAULT 0,
  delivered     integer NOT NULL DEFAULT 0,
  bounced_hard  integer NOT NULL DEFAULT 0,
  bounced_soft  integer NOT NULL DEFAULT 0,
  complained    integer NOT NULL DEFAULT 0,
  opens_total   integer NOT NULL DEFAULT 0,
  opens_unique  integer NOT NULL DEFAULT 0,
  opens_unique_nonbot integer NOT NULL DEFAULT 0,
  clicks_total  integer NOT NULL DEFAULT 0,
  clicks_unique integer NOT NULL DEFAULT 0,
  unsubscribed  integer NOT NULL DEFAULT 0,
  failed        integer NOT NULL DEFAULT 0,
  last_event_at timestamptz,
  computed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaign_daily_stats (
  workspace_id uuid NOT NULL,
  campaign_id  uuid NOT NULL,
  day          date NOT NULL,
  metric       text NOT NULL,
  value        bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, day, metric)
);
CREATE INDEX ix_cds_ws_day ON campaign_daily_stats (workspace_id, day);

CREATE TABLE link_stats (
  workspace_id uuid NOT NULL,
  link_id      uuid NOT NULL REFERENCES tracked_links(id) ON DELETE CASCADE,
  campaign_id  uuid NOT NULL,
  clicks_total integer NOT NULL DEFAULT 0,
  clicks_unique integer NOT NULL DEFAULT 0,
  PRIMARY KEY (link_id)
);

CREATE TABLE provider_stats (
  workspace_id uuid NOT NULL,
  provider_id  uuid NOT NULL,
  day          date NOT NULL,
  attempted    integer NOT NULL DEFAULT 0,
  accepted     integer NOT NULL DEFAULT 0,
  delivered    integer NOT NULL DEFAULT 0,
  bounced      integer NOT NULL DEFAULT 0,
  complained   integer NOT NULL DEFAULT 0,
  errors       integer NOT NULL DEFAULT 0,
  p95_latency_ms integer,
  PRIMARY KEY (provider_id, day)
);

CREATE TABLE device_stats (
  workspace_id uuid NOT NULL,
  campaign_id  uuid NOT NULL,
  device_type  text NOT NULL,
  client_family text NOT NULL,
  opens        integer NOT NULL DEFAULT 0,
  clicks       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, device_type, client_family)
);

CREATE TABLE contact_engagement (
  workspace_id uuid NOT NULL,
  contact_id   uuid NOT NULL,
  last_sent_at timestamptz,
  last_open_at timestamptz,
  last_click_at timestamptz,
  sends_90d    integer NOT NULL DEFAULT 0,
  opens_90d    integer NOT NULL DEFAULT 0,
  clicks_90d   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (contact_id)
);
CREATE INDEX ix_ce_ws_click ON contact_engagement (workspace_id, last_click_at DESC NULLS LAST);
```

`contact_engagement` exists solely so segment predicates like "clicked in the last 90 days" never touch a partitioned event table. It is updated incrementally by the analytics worker and rebuilt nightly.

## Platform tables

```sql
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  key_prefix    text NOT NULL,                  -- rk_live_a1b2, shown in UI
  key_hash      bytea NOT NULL,                 -- argon2id of the full key
  scopes        text[] NOT NULL DEFAULT '{}',
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_apikey_hash ON api_keys (key_hash);
CREATE INDEX ix_apikey_prefix ON api_keys (key_prefix) WHERE revoked_at IS NULL;

CREATE TABLE audit_logs (
  id            uuid NOT NULL,
  workspace_id  uuid,
  actor_type    text NOT NULL CHECK (actor_type IN ('user','api_key','system','provider')),
  actor_id      uuid,
  action        text NOT NULL,                  -- campaign.launched, billing.plan_changed
  resource_type text NOT NULL,
  resource_id   uuid,
  before        jsonb,
  after         jsonb,
  request_id    text,
  ip            inet,
  user_agent    text,
  occurred_at   timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (occurred_at);
CREATE INDEX ix_audit_ws_time ON audit_logs (workspace_id, occurred_at DESC);

CREATE TABLE outbound_webhook_endpoints (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url          text NOT NULL,
  secret_ref   text NOT NULL,
  events       text[] NOT NULL,
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','paused','failing','disabled')),
  consecutive_failures smallint NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  workspace_id uuid NOT NULL,
  key          text NOT NULL,
  endpoint     text NOT NULL,
  request_hash bytea NOT NULL,
  status       text NOT NULL CHECK (status IN ('in_progress','completed')),
  response_code smallint,
  response_body jsonb,
  locked_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, key, endpoint)
);
```

Billing tables are in section 6. Automation tables are deferred and sketched in section 24.


---

# 6. Billing, part 2: domain model and schema

The provider owns money movement. You own entitlements. The mirror between them is a cache that must be rebuildable from the provider at any moment.

## Ownership boundary

| Object | Authoritative owner | Why | Do we mirror it? |
| --- | --- | --- | --- |
| Payment method, card details | Provider | PCI scope. Never touch a PAN | Metadata only (brand, last4, expiry) |
| Charge, payment attempt | Provider | They move the money | Yes, for display and reconciliation |
| Invoice amounts, tax | Provider | Tax engine and sequential numbering live there | Yes, plus our own local number if legally required |
| Subscription status, period boundaries | Provider | Renewals happen on their clock | Yes — this mirror drives entitlements |
| Refunds, disputes | Provider | Their lifecycle | Yes |
| Coupon redemption | Provider | Enforced at checkout | Yes, read-only |
| **Plans, features, limits** | **Us** | Product decisions, not billing decisions | Provider only knows the price |
| **Entitlements** | **Us** | Derived from the mirror | n/a |
| **Usage counters** | **Us** | We are the meter | Pushed to provider only for metered overage items |
| **Which workspace a subscription belongs to** | **Us** | Provider metadata is a hint, not a key | n/a |

The rule that falls out: **a webhook never creates the mapping from provider object to workspace.** The mapping is created by us at checkout and stored before the customer ever reaches the payment page. A webhook that references an unknown customer is a hard alert, not an auto-create.

## Plans, features, entitlements

Three tables, no `if (plan === 'PRO')` anywhere:

```sql
CREATE TABLE features (
  key          text PRIMARY KEY,               -- 'campaigns.monthly_emails'
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('boolean','limit','quota')),
  unit         text,                           -- 'emails','contacts','seats','calls'
  reset_period text CHECK (reset_period IN ('never','daily','monthly','billing_period')),
  aggregation  text CHECK (aggregation IN ('count','max_concurrent','peak')),
  description  text
);

CREATE TABLE plans (
  id            uuid PRIMARY KEY,
  code          text NOT NULL UNIQUE,          -- 'free','growth','scale','agency'
  name          text NOT NULL,
  tier          smallint NOT NULL,             -- ordering for upgrade/downgrade logic
  description   text,
  is_public     boolean NOT NULL DEFAULT true,
  is_active     boolean NOT NULL DEFAULT true,
  trial_days    smallint NOT NULL DEFAULT 0,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_features (
  plan_id      uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature_key  text NOT NULL REFERENCES features(key) ON DELETE RESTRICT,
  enabled      boolean NOT NULL DEFAULT true,
  limit_value  bigint,                         -- NULL = unlimited
  overage_allowed boolean NOT NULL DEFAULT false,
  overage_price_id uuid,
  soft_limit_pct smallint DEFAULT 80,          -- warn threshold
  PRIMARY KEY (plan_id, feature_key)
);

CREATE TABLE prices (
  id              uuid PRIMARY KEY,
  plan_id         uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  provider        text NOT NULL DEFAULT 'stripe',
  provider_price_id text NOT NULL,
  currency        char(3) NOT NULL,
  unit_amount     bigint NOT NULL,             -- minor units
  interval        text NOT NULL CHECK (interval IN ('month','year','one_time')),
  interval_count  smallint NOT NULL DEFAULT 1,
  billing_scheme  text NOT NULL DEFAULT 'flat'
                  CHECK (billing_scheme IN ('flat','per_seat','metered','tiered')),
  meter_feature_key text REFERENCES features(key),
  tiers           jsonb,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_price_provider UNIQUE (provider, provider_price_id)
);
CREATE INDEX ix_prices_plan ON prices (plan_id, currency, interval) WHERE is_active;
```

Plan definitions live in a seed file under version control and are applied by migration, so staging and production cannot drift. Changing a plan's limits creates a **new plan row with a new code** (`growth_v2`); existing subscribers stay on `growth` until migrated deliberately. Never mutate a plan customers are on — that is how you silently downgrade paying users.

## Customers, subscriptions, entitlements

```sql
CREATE TABLE billing_customers (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  provider        text NOT NULL,
  provider_customer_id text NOT NULL,
  email           citext NOT NULL,
  name            text,
  billing_address jsonb,
  tax_id_type     text,
  tax_id_value    text,
  tax_exempt      text CHECK (tax_exempt IN ('none','exempt','reverse')),
  currency        char(3),
  default_payment_method_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_bc_workspace UNIQUE (workspace_id, provider),
  CONSTRAINT uq_bc_provider UNIQUE (provider, provider_customer_id)
);

CREATE TABLE subscriptions (
  id                 uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  customer_id        uuid NOT NULL REFERENCES billing_customers(id) ON DELETE RESTRICT,
  plan_id            uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  provider           text NOT NULL,
  provider_subscription_id text,               -- NULL for the free plan
  status             text NOT NULL
                     CHECK (status IN ('trialing','active','past_due','unpaid',
                                       'paused','cancelled','incomplete','incomplete_expired')),
  collection_method  text NOT NULL DEFAULT 'charge_automatically',
  currency           char(3) NOT NULL,
  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL,
  trial_end          timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  cancel_at          timestamptz,
  cancelled_at       timestamptz,
  ended_at           timestamptz,
  grace_period_end   timestamptz,
  pending_plan_id    uuid REFERENCES plans(id),  -- scheduled downgrade
  pending_effective_at timestamptz,
  provider_synced_at timestamptz NOT NULL DEFAULT now(),
  provider_state_version bigint NOT NULL DEFAULT 0,   -- ordering guard, see s7
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_sub_provider ON subscriptions (provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX uq_sub_active_ws ON subscriptions (workspace_id)
  WHERE status IN ('trialing','active','past_due','unpaid','paused');
CREATE INDEX ix_sub_period_end ON subscriptions (current_period_end) WHERE status = 'active';
CREATE INDEX ix_sub_grace ON subscriptions (grace_period_end) WHERE status = 'past_due';

CREATE TABLE subscription_items (
  id            uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL,
  price_id      uuid NOT NULL REFERENCES prices(id) ON DELETE RESTRICT,
  provider_item_id text,
  quantity      integer NOT NULL DEFAULT 1,
  metered       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_si_provider UNIQUE (provider_item_id)
);

CREATE TABLE entitlements (
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  feature_key    text NOT NULL REFERENCES features(key) ON DELETE RESTRICT,
  enabled        boolean NOT NULL DEFAULT true,
  limit_value    bigint,                       -- NULL = unlimited
  overage_allowed boolean NOT NULL DEFAULT false,
  source         text NOT NULL DEFAULT 'plan'
                 CHECK (source IN ('plan','override','trial','grandfathered','promo')),
  source_ref     uuid,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,
  version        bigint NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, feature_key)
);
```

`uq_sub_active_ws` is a partial unique index guaranteeing **one live subscription per workspace**. This single constraint kills an entire class of double-subscribe bug caused by a user opening two checkout tabs.

`entitlements` is a **materialised projection** of `plan_features` plus overrides. It is rewritten whenever the subscription changes and can always be rebuilt from scratch. The hot path reads this table (via Redis cache), never joins plans.

## Invoices, payments, refunds

```sql
CREATE TABLE invoices (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL,
  customer_id     uuid NOT NULL REFERENCES billing_customers(id) ON DELETE RESTRICT,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  provider        text NOT NULL,
  provider_invoice_id text NOT NULL,
  number          text,                        -- provider's number
  local_number    text,                        -- our sequential number, if required
  status          text NOT NULL
                  CHECK (status IN ('draft','open','paid','uncollectible','void')),
  currency        char(3) NOT NULL,
  subtotal        bigint NOT NULL,
  discount_total  bigint NOT NULL DEFAULT 0,
  tax_total       bigint NOT NULL DEFAULT 0,
  total           bigint NOT NULL,
  amount_paid     bigint NOT NULL DEFAULT 0,
  amount_due      bigint NOT NULL DEFAULT 0,
  amount_refunded bigint NOT NULL DEFAULT 0,
  tax_breakdown   jsonb,
  period_start    timestamptz,
  period_end      timestamptz,
  due_at          timestamptz,
  paid_at         timestamptz,
  voided_at       timestamptz,
  hosted_url      text,
  pdf_url         text,
  attempt_count   smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_inv_provider UNIQUE (provider, provider_invoice_id)
);
CREATE INDEX ix_inv_ws ON invoices (workspace_id, created_at DESC);
CREATE UNIQUE INDEX uq_inv_local_number ON invoices (local_number) WHERE local_number IS NOT NULL;

CREATE TABLE invoice_lines (
  id           uuid PRIMARY KEY,
  invoice_id   uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  price_id     uuid REFERENCES prices(id),
  description  text NOT NULL,
  quantity     bigint NOT NULL DEFAULT 1,
  unit_amount  bigint NOT NULL,
  amount       bigint NOT NULL,
  tax_rate_bp  integer,                        -- basis points
  tax_amount   bigint NOT NULL DEFAULT 0,
  proration    boolean NOT NULL DEFAULT false,
  period_start timestamptz,
  period_end   timestamptz
);

CREATE TABLE payments (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL,
  customer_id     uuid NOT NULL REFERENCES billing_customers(id),
  invoice_id      uuid REFERENCES invoices(id) ON DELETE SET NULL,
  provider        text NOT NULL,
  provider_payment_id text NOT NULL,
  payment_method_id uuid,
  status          text NOT NULL
                  CHECK (status IN ('requires_action','processing','succeeded','failed','cancelled')),
  currency        char(3) NOT NULL,
  amount          bigint NOT NULL,
  amount_refunded bigint NOT NULL DEFAULT 0,
  failure_code    text,
  failure_message text,
  succeeded_at    timestamptz,
  failed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_pay_provider UNIQUE (provider, provider_payment_id)
);

CREATE TABLE payment_methods (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  customer_id   uuid NOT NULL REFERENCES billing_customers(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  provider_pm_id text NOT NULL,
  type          text NOT NULL,                 -- card, sepa_debit, upi, netbanking
  brand         text, last4 char(4),
  exp_month     smallint, exp_year smallint,
  is_default    boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','expired','detached','requires_action')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_pm_provider UNIQUE (provider, provider_pm_id)
);
CREATE UNIQUE INDEX uq_pm_default ON payment_methods (customer_id) WHERE is_default;

CREATE TABLE refunds (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  payment_id    uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  invoice_id    uuid REFERENCES invoices(id),
  provider      text NOT NULL,
  provider_refund_id text NOT NULL,
  amount        bigint NOT NULL,
  currency      char(3) NOT NULL,
  reason        text,
  status        text NOT NULL CHECK (status IN ('pending','succeeded','failed','cancelled')),
  initiated_by  uuid REFERENCES users(id),
  entitlement_action text NOT NULL DEFAULT 'none'
                CHECK (entitlement_action IN ('none','revoke_immediately','revoke_at_period_end')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ref_provider UNIQUE (provider, provider_refund_id)
);

CREATE TABLE disputes (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  payment_id   uuid NOT NULL REFERENCES payments(id),
  provider     text NOT NULL,
  provider_dispute_id text NOT NULL UNIQUE,
  amount       bigint NOT NULL,
  reason       text,
  status       text NOT NULL,
  evidence_due_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coupons (
  id           uuid PRIMARY KEY,
  code         citext NOT NULL UNIQUE,
  provider_coupon_id text,
  kind         text NOT NULL CHECK (kind IN ('percent','fixed')),
  value        bigint NOT NULL,
  currency     char(3),
  duration     text NOT NULL CHECK (duration IN ('once','repeating','forever')),
  duration_months smallint,
  max_redemptions integer,
  redeemed_count integer NOT NULL DEFAULT 0,
  applies_to_plan_ids uuid[],
  valid_from   timestamptz,
  valid_until  timestamptz,
  is_active    boolean NOT NULL DEFAULT true
);

CREATE TABLE discounts (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE CASCADE,
  coupon_id     uuid NOT NULL REFERENCES coupons(id),
  provider_discount_id text,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

## Billing events and the webhook inbox

```sql
-- Raw inbox: written synchronously by the ingest service, before any processing.
CREATE TABLE payment_webhook_events (
  id                 uuid PRIMARY KEY,
  provider           text NOT NULL,
  provider_event_id  text NOT NULL,
  event_type         text NOT NULL,
  api_version        text,
  signature_verified boolean NOT NULL,
  payload            jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received','processing','processed','failed','ignored','quarantined')),
  attempts           smallint NOT NULL DEFAULT 0,
  last_error         text,
  workspace_id       uuid,                     -- resolved during processing
  provider_created_at timestamptz,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  CONSTRAINT uq_pwe UNIQUE (provider, provider_event_id)
);
CREATE INDEX ix_pwe_status ON payment_webhook_events (status, received_at)
  WHERE status IN ('received','failed');

-- Domain-level audit trail: append-only, never updated.
CREATE TABLE billing_events (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL,
  subscription_id uuid,
  invoice_id      uuid,
  payment_id      uuid,
  type            text NOT NULL,               -- our normalised vocabulary
  source          text NOT NULL CHECK (source IN ('webhook','api','admin','system')),
  source_event_id uuid REFERENCES payment_webhook_events(id),
  actor_id        uuid,
  before          jsonb,
  after           jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_be_ws_time ON billing_events (workspace_id, occurred_at DESC);
CREATE INDEX ix_be_sub ON billing_events (subscription_id, occurred_at DESC);
```

The two-table split matters: `payment_webhook_events` is the transport-level record used for dedup and replay; `billing_events` is the business-level ledger you show a customer or an auditor. Never merge them.


---

# Review amendments — apply on top of everything above

These supersede the baseline where they differ.

## F — database changes

```sql
-- Recipient state machine: attempt intent, ordering lattice, bot marking
ALTER TABLE campaign_recipients
  ADD COLUMN provider_attempt_started_at TIMESTAMPTZ,
  ADD COLUMN attempt_token               UUID,
  ADD COLUMN queued_at                   TIMESTAMPTZ,
  ADD COLUMN delivery_rank               SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN terminal_at                 TIMESTAMPTZ;

ALTER TYPE recipient_state ADD VALUE 'delivery_uncertain';

-- HOT-friendly: terminal rows leave the index, updates stop writing index entries
ALTER TABLE campaign_recipients SET (fillfactor = 80,
  autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);

CREATE INDEX CONCURRENTLY ix_cr_active
  ON campaign_recipients (campaign_id, state)
  WHERE state IN ('pending','queued','sending');

CREATE INDEX CONCURRENTLY ix_cr_stale_attempt
  ON campaign_recipients (provider_attempt_started_at)
  WHERE state = 'sending';

-- metered is write-once (trigger function in section D, F14)
CREATE TRIGGER trg_guard_metered BEFORE UPDATE ON campaign_recipients
  FOR EACH ROW EXECUTE FUNCTION guard_metered();

-- Per-connection inbound webhook endpoints
ALTER TABLE provider_connections
  ADD COLUMN endpoint_token     TEXT NOT NULL,
  ADD COLUMN webhook_secret_arn TEXT;
CREATE UNIQUE INDEX uq_conn_endpoint_token ON provider_connections (endpoint_token);

-- Unmatched inbound events are stored, never applied
ALTER TABLE provider_webhook_events
  ADD COLUMN provider_connection_id UUID REFERENCES provider_connections(id),
  ADD COLUMN matched                BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN dedupe_key             TEXT NOT NULL;
CREATE UNIQUE INDEX uq_pwe_dedupe
  ON provider_webhook_events (provider_connection_id, dedupe_key);

-- Idempotent usage aggregation
ALTER TABLE usage_aggregates ADD COLUMN last_usage_record_id BIGINT NOT NULL DEFAULT 0;

-- Reconciliation audit
CREATE TABLE billing_reconciliation_runs (
  id          UUID PRIMARY KEY,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  checked     INTEGER NOT NULL DEFAULT 0,
  diverged    INTEGER NOT NULL DEFAULT 0,
  corrected   INTEGER NOT NULL DEFAULT 0,
  details     JSONB NOT NULL DEFAULT '[]'
);

-- Scheduler definitions leave Redis
CREATE TABLE scheduled_jobs (
  name        TEXT PRIMARY KEY,
  cron        TEXT NOT NULL,
  queue       TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  enabled     BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ NOT NULL
);

-- Bot traffic is stored and excluded, never dropped
ALTER TABLE email_events ADD COLUMN is_bot BOOLEAN NOT NULL DEFAULT false;
```

Plus three tables given in full in section D: `campaign_counters` (F13), `sender_daily_usage` (F8) and `billing_refetch_queue` (F17).

Partitioning: `email_events` daily above 1M events per day, weekly below. `campaign_recipients` stays unpartitioned until measured, with the hash-partition migration written and tested in advance.


Also: `campaign_counters`, `sender_daily_usage` and `billing_refetch_queue` are defined in full in `docs/17-review-findings.md` under F13, F8 and F17. Automations tables (`docs/00-product-and-scope.md`, section 24) are FUTURE and must not be created in the MVP.