# BUILD-PLAN.md — Relayd, phase by phase

Execute in order. A phase is done when every box is ticked **and** its gate passes. Do not start the next phase before that. Each phase lists the docs to read first and the `INVARIANTS.md` rules it must satisfy.

Estimates assume 3–4 engineers; they are a shape, not a promise. The gates are the commitment.

---

## Phase 0 — Foundations (weeks 1–2)

**Read first:** `CLAUDE.md`, `docs/13-repo-and-coding-standards.md`, `docs/01-architecture.md`, `docs/10-infrastructure.md`
**Invariants:** R33

- [x] pnpm workspace + Turborepo; `apps/{web,api,edge,worker,scheduler}` and every `packages/*` scaffolded as empty, typechecking packages
- [x] Root `tsconfig.base.json` with the strict settings from `docs/13`; branded id types in `packages/types`
- [x] `packages/config`: Zod-parsed env, fails fast on missing vars; the only `process.env` reader
- [x] `packages/logger`: Pino, redaction paths, `AsyncLocalStorage` trace context, request-id propagation
- [x] `packages/eslint-plugin-relayd` with the five custom rules from `CLAUDE.md` §7, wired as errors
- [x] `packages/db`: Drizzle configured for Postgres, migration runner, `uuidv7()` helper, `WorkspaceScope` branded type and `scoped(db, scope)` helper that issues `SET LOCAL app.workspace_id`
- [x] Throwaway migration `0001_init.sql` proving the runner works in staging
- [x] `apps/api`: Express 5 skeleton, error envelope middleware, request-id middleware, `/health` (dependency-free) and `/ready` (checks Postgres and Redis)
- [x] `apps/edge`: Express skeleton with the same health endpoints and **no** import from `apps/api`
- [x] `apps/worker`: BullMQ connection factory, graceful-shutdown harness (drain in-flight jobs on SIGTERM), five empty entrypoints
- [x] `apps/scheduler`: process skeleton with direct (non-pooled) Postgres connection
- [x] `apps/web`: Vite + React + Tailwind + React Router + TanStack Query provider, empty shell
- [x] `infra/docker`: one multi-stage Dockerfile (ARM64) producing one image; `CMD` selected by env var per process type; `docker-compose.yml` with Postgres 16 + Redis 7 for local dev
- [x] GitHub Actions: `lint`, `typecheck`, `test`, `build` on every PR; total under 8 minutes
- [x] `packages/testing`: Testcontainers Postgres + Redis harness; one integration test that migrates and rolls back
- [x] Root scripts from `CLAUDE.md` §4 all working

**Gate:**

1. **CI green on the empty app.** `lint`, `typecheck`, `test`, `build` and `docker-build` on every PR, in parallel, inside 8 minutes.
2. **Migration runner — proven by CI.** The runner applies `0001_init.sql` against a fresh Postgres 16 started by Testcontainers, records it, refuses a tampered checksum, and reverses cleanly via the migration's own `-- ROLLBACK:` block. CI sets `CI=true`, so an unreachable Docker daemon fails the job instead of skipping it, and `scripts/assert-integration-ran.mjs` fails the job if any integration test was skipped rather than run.
3. **`pnpm db:migrate` idempotent — proven by CI.** The real CLI is run twice against a fresh Postgres 16: the second run reports `no migrations pending`, exits 0, and leaves `_relayd_migrations` byte-identical (row dump plus an md5 over name, checksum and `applied_at`). The migration body does not re-execute either.
4. **Each of the five lint rules fails a deliberately bad commit.**
5. **`apps/` contains exactly `web, api, edge, worker, scheduler`** (INVARIANTS R33).

**Also run when Docker is available** — useful confirmation, not required for the gate, since criteria 2 and 3 are proven by CI:

```bash
docker compose -f infra/docker/docker-compose.yml up -d --wait
pnpm db:migrate && pnpm db:migrate      # second run: "no migrations pending", exit 0
docker buildx build --platform linux/arm64 -f infra/docker/Dockerfile .
```

**Timebox hard at two weeks.** If tooling is still being tuned in week three, ship what runs and move on.

---

## Phase 1 — Identity, workspaces, RBAC, tenant isolation (weeks 3–5)

**Read first:** `docs/02-database.md` §3 (identity tables), `docs/06-security-and-tracking.md` §15, `docs/03-api.md`
**Invariants:** R20, R36

- [x] commitlint + husky enforcing Conventional Commits (`docs/13` § Git says "enforced by commitlint"; nothing enforces it yet). Add lint-staged in the same commit so the five custom rules reject at `git commit`, not only in CI
- [x] Tables: `users`, `sessions`, `workspaces`, `workspace_members`, `workspace_invitations`, `audit_logs` (DDL in `docs/02`)
- [x] Two Postgres roles: `relayd_app` (RLS enforced) and `relayd_global` (BYPASSRLS); RLS policies on every tenant table using `current_setting('app.workspace_id', true)`
- [x] Repository layer: every method takes `WorkspaceScope` first; `packages/db/repositories/global/` for the named cross-tenant exceptions
- [x] CI reflection test enumerating all repository methods and asserting the scope parameter
- [x] Grep test: no bare `SET app.workspace_id` (broadened to `set_config(..., false)` and to a single owning file — see INVARIANTS R36)
- [x] Auth: register, verify email, login (Argon2id), refresh (rotating), logout, password reset; session listing and revocation
- [x] Workspace CRUD, invitations (create, accept, revoke), member role change, four preset roles and the full permission matrix from `docs/06` (`campaign:launch` ≠ `campaign:write`; `billing:write` owner-only)
- [x] Authorization middleware: non-member → 404; member without permission → 403
- [x] Audit log writes for every mutating action, with actor, workspace, before/after
- [x] `packages/notifications`: transactional email for verification, invites and password reset via a single operator-owned provider connection — kept separate from customer sending forever
- [x] Frontend: `/login`, `/register`, verify-email, password reset, `/settings/workspace`, `/settings/team`, workspace switcher, auth guards, role-aware UI gating
- [x] **The six-part tenant-isolation suite** (`docs/06` §15) as `pnpm test:isolation`, promoted to a required CI check

**Gate:** A member of workspace A receives 404 for every workspace B resource; a repository method without `WorkspaceScope` fails to compile and fails the reflection test; `billing:write` cannot be attached to an API key (test exists even though API keys arrive in Phase 9); isolation suite is required on `main`.

---

## Phase 2 — Audience and import (weeks 6–8)

**Read first:** `docs/02-database.md` §3 (audience tables), `docs/00-product-and-scope.md`
**Invariants:** none new — but every repository here is scoped (R20)

- [x] Tables: `contacts` (partial unique index on lowercased email per workspace), `contact_lists`, `contact_list_members`, `tags`, `contact_tags`, `segments`, `suppressions`, `import_jobs`, `import_row_errors`
- [x] API: contact CRUD, bulk tag/untag, list membership, segment definition + preview with a hard count cap, suppression CRUD, presigned S3 upload, import start and status
- [x] Segments: a **fixed set of predicates** with preview count. No general query builder.
- [x] `contact-import` consumer: stream from S3, parse CSV/XLSX, validate, dedupe within file and against DB, `COPY` into staging table, merge, per-row errors; flat memory on 500k rows
- [x] Formula-injection neutralisation on export (cells beginning `= + - @`)
- [x] Frontend: `/audience/contacts` (server-side pagination and filtering), `/audience/lists`, `/audience/tags`, `/audience/imports` with live progress and failed-row CSV download, `/audience/suppressions`, column-mapping step
- [x] Tests: malformed CSV corpus, mixed encodings, BOM, CRLF, formula injection, 500k-row memory profile, duplicate-within-file and duplicate-against-db

**Gate:** 500k-row import with flat resident memory; report distinguishes created / updated / skipped-duplicate / failed with reasons; export neutralises every formula-injection cell.

---

## Phase 3 — Provider connections and sender accounts (weeks 9–11)

**Read first:** `docs/07-providers-and-routing.md` §9, `docs/06-security-and-tracking.md` (credentials, webhook ingest), `docs/17-review-findings.md` F4, F21, F22
**Invariants:** **R4**, R21, R22

- [x] Tables: `provider_connections` (holds Secrets Manager ARN, `endpoint_token`, `webhook_secret_arn` — never a secret), `sender_accounts`, `sender_identities`, `provider_webhook_events` (with `provider_connection_id`, `dedupe_key`, `matched`)
- [x] `ProviderPort` interface per `docs/07`: `send`, `sendBatch`, `verifyCredentials`, `getLimits`, `capabilities`; `ProviderError { kind, affects, retryAfterMs }`; stateless credentials per call; `recipientId` correlation on input and outcome
- [x] `send-with-limits.ts` wrapper — the **only** entry point to any adapter (rate limiter and daily quota are wired in Phase 6, but the wrapper and the grep test exist now)
- [x] Adapters in this order: **SES**, then **SMTP**, then **SendGrid**. Mailgun and Brevo are SHOULD-tier; do not build them now. No Google Workspace (D6).
- [x] Error scrubbing at the adapter boundary; Sentry `beforeSend` denylist; credential-canary test (R22)
- [x] Secrets: path scheme `relayd/{env}/ws/{workspaceId}/conn/{connectionId}`; in-memory cache ≤ 5 min; audit row per fetch
- [x] **Per-connection webhook ingest** in `apps/edge`: `POST /ingest/v1/{provider}/{endpointToken}`; token → connection; signature verified with that connection's secret; persist to inbox; return 200 < 200 ms; unmatched events stored, never applied (R4)
- [x] API: connect / verify / rotate / disconnect per provider; sender CRUD; identity verification status; test-send; endpoint URL shown once per connection
- [x] `provider-verify` recurring job (via `scheduled_jobs`, Phase 5 — stub the schedule now)
- [x] Frontend: `/providers` connection cards with health, per-provider credential forms, `/senders` with verification status and daily-limit display, SMTP labelled **best-effort** (D4)
- [x] `packages/testing/contract.spec.ts`: ~40 cases every adapter must pass — recorded fixtures locally, sandbox accounts in CI

**Gate:** Every adapter passes the contract suite unchanged; a wrong credential yields a typed `ProviderError`, not a stack trace; no provider SDK importable outside its adapter dir; the R4 cross-tenant webhook test passes; the credential canary appears nowhere.

---

## Phase 4 — Templates and rendering (weeks 12–13)

**Read first:** `docs/00-product-and-scope.md`, `docs/02-database.md` §4 (templates)

- [x] Tables: `templates`, `template_versions` (published versions immutable)
- [x] Rendering engine: merge tags with defaults, missing-field behaviour, plain-text auto-generation, deterministic output
- [x] HTML sanitiser with the XSS corpus as a test fixture
- [x] API: template CRUD, publish version, render-preview with sample contact, test-send
- [x] Frontend: `/templates`, `/templates/create` (HTML editor + merge-tag picker, desktop/mobile preview, plain-text editor). **No drag-and-drop builder.**
- [x] Campaigns will record `template_version_id` at launch (Phase 6) — expose the id now

**Gate:** Sanitiser strips every payload in the corpus; a missing merge field renders its default; a published version cannot be mutated.

---

## Phase 5 — Queue and worker platform (weeks 14–15)

**Read first:** `docs/04-campaign-engine-and-queues.md` §12 and amendments H, `docs/17-review-findings.md` F23
**Invariants:** R23, R35

- [x] Tables: `job_dead_letters`, `scheduled_jobs`
- [x] All queues declared with explicit settings (`docs/04` amendments H): `email-send`, `campaign-launch`, `campaign-dispatch`, `recipient-sweeper`, `campaign-reconcile`, `event-ingest`, `analytics-rollup`, `billing-webhook`, `billing-refetch`, `billing-reconcile`, `billing-processing`, `contact-import`, `provider-verify`, `outbound-webhook`
- [x] `email-send`: `lockDuration 120_000`, `maxStalledCount 0`, bounded `removeOnComplete`/`removeOnFail`
- [x] DLQ handler writing `job_dead_letters`; replay endpoint (operator-scoped)
- [x] `scheduler`: reads `scheduled_jobs`, computes due work each tick, leader-elected via `pg_try_advisory_xact_lock` inside a transaction spanning the tick, direct Postgres connection (R35). **No BullMQ repeatables** (R23).
- [x] Graceful shutdown proven: SIGTERM mid-job → job completes or is released, never lost
- [x] Internal operator console (unstyled): queue depths, DLQ inspection and replay
- [x] Tests: kill leader mid-tick → exactly one successor; SIGTERM mid-job → no loss; DLQ replay restores exactly once; Redis flush → scheduler still enqueues due jobs

**Gate:** Rolling deployment with 10,000 queued synthetic jobs: zero lost, zero duplicate executions.

---

## Phase 6 — Campaign engine, sending, tracking, ingestion (weeks 16–22)

The product. Plan seven weeks. **Internal sequencing:** launch + snapshot → single-sender dispatch → guard/sweeper/reconcilers → tracking endpoints → inbound event processing with the rank lattice → pool routing → pause/resume/cancel → retry and failover. Do not build pool routing before single-sender sending works end to end.

**Read first:** `docs/04-campaign-engine-and-queues.md` (all), `docs/07-providers-and-routing.md` §10, `docs/06-security-and-tracking.md` §13, `docs/11-failure-scenarios-and-races.md`, `docs/17-review-findings.md` F1–F3, F5–F16, F27–F31
**Invariants:** R1, R2, R3, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R16, R20, R27, R28, R29, R30, R31, R32

Schema
- [x] `campaigns` with the extended state set (`draft, scheduled, validating, queueing, sending, pausing, paused, cancelling, cancelled, completed, completed_with_errors, held, failed`)
- [x] `campaign_recipients` with `state` (incl. `delivery_uncertain`), `metered`, `attempt_count`, `attempt_token`, `queued_at`, `provider_attempt_started_at`, `delivery_state`, `delivery_rank`, `terminal_at`, `provider_message_id`, `provider_connection_id`; `fillfactor 80`; partial active index; stale-attempt index; `trg_guard_metered` (R14, R27)
- [x] `campaign_counters` (R13), `sender_daily_usage` (R8), `campaign_events`, `tracked_links`, `email_events` (range-partitioned, `is_bot`), `sending_pools`, `sending_pool_members`
- [x] `usage_records` with unique `idempotency_key` (billing plans arrive in Phase 8; the ledger row is written from day one — see Phase 8 risk note)

Engine
- [x] Launch: guarded transition (R29), entitlement row `FOR SHARE` (R28 — stub entitlement = unlimited until Phase 8), audience snapshot into `campaign_recipients`, `template_version_id` pinned, counters initialised
- [x] Dispatcher: claim `pending` with `FOR UPDATE SKIP LOCKED` in batches of 500, mark `queued` + `queued_at`, commit, enqueue with `jobId = send:{recipientId}`; window bounded at 5,000
- [x] Send worker: guarded transition to `sending` first (R1) → suppression + campaign-state recheck (R30) → `send-with-limits` (R9, R10, R11; daily quota R8) → provider call with timeout below lock (R2) and deterministic `Message-ID` → single commit transaction: `sent`, `metered=true`, `usage_records`, `sender_daily_usage`, `campaign_counters`
- [x] `recipient-sweeper` (R3, R5) and `campaign-reconcile` (R12, hourly counter recount R13)
- [x] Retry as delayed jobs on `email-send` (not a separate consumer); `retry-failed` never touches `metered` (R14)
- [x] Batch sends ≤ 100 with ambiguous-failure → `delivery_uncertain` (R31)
- [x] Pools: round-robin and failover; shared Redis bucket per `provider_connection_id`; rate-limit rejections cool down, never reroute
- [x] Pause / resume / cancel with transient-state deadlines; a running campaign always completes under dunning restrictions (`held` state for scheduled ones)

Tracking and ingestion (`apps/edge`)
- [x] HMAC-signed tracking tokens (`16B message_token || 4B linkIndex || 1B kind` + 10-byte MAC, key-id prefix); open pixel and click redirect resolving URL from `tracked_links` by index
- [x] One-click unsubscribe **POST only**; GET confirmation page; `List-Unsubscribe` + `List-Unsubscribe-Post` headers on every message (R6)
- [x] Bot heuristics → `is_bot` (R6); IP hashing with daily rotating salt
- [x] `event-ingest` consumer: resolve within connection scope (R4), dedupe key (R32), rank lattice (R16), always write `email_events`, suppression on hard bounce and complaint, `delivery_uncertain` reconciliation on matching message id

API and frontend
- [x] Campaign CRUD, audience attach with preview count, schedule, launch (`Idempotency-Key`), pause, resume, cancel, clone, retry-failed, `progress` from counters; pool CRUD
- [x] Seven-step wizard, pre-flight checklist on review step, `/campaigns` list with live progress, `/campaigns/:id` detail with recipient-level state, search and `deliveryUncertain` count

Tests
- [ ] Every row in `INVARIANTS.md` sections A–C tagged Phase 6, with test paths filled in
- [ ] The full race matrix in `docs/11` as executable tests
- [ ] Chaos run: kill workers randomly during a 50k send; zero duplicate provider accepts; every recipient terminal

**Gate:** 50,000-recipient campaign completes with every recipient terminal; zero duplicate provider accepts under chaos; pause takes effect within one dispatcher tick; bounces suppress within seconds of the callback; a forged tracking token is rejected without a DB read; `FLUSHALL` mid-campaign still completes.

**Risk note:** if this phase runs two weeks long, cut pool routing to single-sender sending and ship. Never cut anything in sections A–C of `INVARIANTS.md`.

---

## Phase 7 — Analytics rollups and dashboards (weeks 23–25)

**Read first:** `docs/08-analytics.md`, `docs/17-review-findings.md` F24–F26
**Invariants:** R24, R25, R26

- [x] Tables: `campaign_stats`, `campaign_daily_stats`, `provider_stats`, `device_stats`, `link_stats`, `contact_engagement`
- [x] `analytics-rollup`: 30 s incremental from Redis dirty set **plus** hourly full recompute over a bounded window (R24); `contact_engagement` derived from the hourly pass only (R26)
- [x] Partition maintenance job for `email_events` (R25)
- [x] API: campaign, link, provider, device analytics; workspace overview; CSV export; every rate response includes `botFiltered`
- [x] Frontend: `/dashboard`, `/campaigns/:id/analytics` (Recharts), link heat table; **click rate is the headline**, open rate labelled approximate
- [ ] Tests: rollup vs raw reconciliation within 0.1% over a seeded 10M-event set (**blocked: needs Postgres**); partition boundaries ✅; late-arriving events ✅; timezone buckets ✅ — see `packages/analytics/test/buckets.test.ts` and `partitions.test.ts`

**Gate:** Incremental and hourly rollups agree within 0.1%; dashboard labels opens as approximate; bot traffic excluded and reported.

---

## Phase 8 — Billing end to end (weeks 26–30)

The gate before external signups open.

**Read first:** `docs/05-billing.md` (all), `docs/02-database.md` §6, `docs/17-review-findings.md` F14, F15, F17–F19, F28
**Invariants:** R14, R15, R17, R18, R19, R28

- [x] Tables: `billing_customers`, `plans`, `features`, `plan_features`, `prices`, `subscriptions` (`uq_sub_active_ws`), `subscription_items`, `invoices`, `payments`, `refunds`, `payment_methods`, `coupons`, `discounts`, `entitlements`, `usage_aggregates` (with watermark, R15), `billing_events`, `payment_webhook_events`, `billing_refetch_queue`, `billing_reconciliation_runs`
- [x] `packages/billing/plans`: plan and feature definitions — the only place plan codes appear (lint rule)
- [x] Checkout: local `billing_customers` row first, then Stripe customer, then session with `client_reference_id` + metadata (R18)
- [x] Webhook path in `apps/edge`: verify → inbox insert → 200 fast → mark dirty (R17); `billing-refetch` coalesced consumer; `billing-webhook` failed jobs never discarded
- [x] Entitlements projection + rebuild command; entitlement checks server-side, `FOR SHARE` at launch (R28 — replace the Phase 6 stub)
- [x] Metering wired to the Phase 6 ledger; `usage_aggregates` with watermark (R15)
- [x] Plan change: upgrade immediate with proration (modify the existing subscription, never a second row); downgrade scheduled to period end with pre-check `422 plan_downgrade_blocked` listing over-limit features; cancel at period end; cancel immediately
- [x] Dunning ladder in `billing-processing`: past_due (0–14 d) → restricted (15–30 d, launch blocked, scheduled campaigns `held`) → suspended (31–90 d) → export offered → hard delete after three notices
- [x] `billing-reconcile` nightly job + divergence metric (R19)
- [x] API: checkout session, portal session, subscription read, plan-change pre-check, upgrade, downgrade, cancel, invoices, usage, webhook endpoint
- [ ] Frontend: `/billing`, `/billing/plans`, `/billing/checkout`, `/billing/success` (polls; server-side lookup fallback after 10 s), `/billing/cancel`, `/billing/invoices`, `/billing/payment-method`, usage meters, past-due banner, downgrade blocker dialog
- [ ] `pnpm test:billing`: the twelve critical cases in `docs/12-testing.md` + metering invariants + duplicated and reordered webhook replays

**Gate:** Full billing matrix green against Stripe test mode; entitlements dropped and rebuilt with byte-identical output; a frontend that never receives the success redirect converges within one poll; R14–R19 tests pass.

---

## Phase 9 — Public API, API keys, outbound webhooks (weeks 31–33)

**Read first:** `docs/03-api.md`

- [ ] Tables: `api_keys` (hashed secrets, scope arrays), `outbound_webhook_endpoints`, `outbound_webhook_deliveries`
- [ ] Key issue (one-time reveal), list, revoke; scoped-key auth middleware; per-key rate limiting; `billing:write` refused on every key
- [ ] Idempotency-key replay support on all mutating public endpoints
- [ ] Outbound webhooks: signing secret rotation, delivery log, exponential backoff, auto-disable after sustained failure
- [ ] Frontend: `/settings/api`, webhook endpoint management
- [ ] Tests: scope enforcement per endpoint, signature verification from a third-party perspective, rate-limit boundary, idempotency replay

**Gate:** An external integrator can create a contact, launch a campaign and receive a signed delivery event without the web app; a read-scoped key cannot write anything.

---

## Phase 10 — Production AWS, CI/CD, disaster recovery (weeks 34–36)

**Read first:** `docs/10-infrastructure.md`, `docs/17-review-findings.md` F21, F34
**Invariants:** R21, R34

- [ ] Terraform: VPC, subnets, security groups, ALB, four ECS Fargate ARM64 services (+ scheduler as a single-task service), RDS Multi-AZ in production only, ElastiCache (one instance, keyspace prefixes), S3, CloudFront, Route53, KMS, Secrets Manager, ECR; VPC endpoints for S3, ECR, Secrets Manager, CloudWatch Logs
- [ ] IAM: `secretsmanager:GetSecretValue` scoped by resource prefix, never `*` (R21)
- [ ] CI/CD: build once, promote the same image digest; migrations as a one-off ECS task before service update; smoke tests against staging; manual approval to production; rollback = redeploy previous digest
- [ ] Observability: Sentry, CloudWatch dashboards and alarms (queue depth, DLQ size, unmatched-webhook rate, billing divergence, complaint rate), Prometheus endpoint, trace-id chain verified end to end
- [ ] Backups: PITR enabled; **timed restore drill** documented and executed

**Gate:** Restore from PITR inside the one-hour RTO with a stopwatch; first migration visible in the staging database; a single email traceable from request id → recipient id → provider message id in one query; a deliberately broken deploy rolls back in under five minutes.

---

## Phase 11 — Security hardening and anti-abuse (weeks 37–39)

**Read first:** `docs/06-security-and-tracking.md` §15 (anti-abuse), `docs/17-review-findings.md` F6, F20

- [ ] Verified email + verified sender identity before any send; 500 sends/day cap for accounts under 7 days; new accounts excluded from pool routing
- [ ] Consent attestation at import and at launch, stored with the campaign
- [ ] Complaint-rate auto-pause at 0.3%; graduated account enforcement ladder
- [ ] Launch-time phishing lint; link reputation checks; global cross-workspace block list
- [ ] External penetration test; findings above informational closed or accepted in writing
- [ ] Secret scanning and dependency audit in CI; incident-response runbook in `docs/runbooks/`
- [ ] D7 check: if a free tier was approved, its caps are implemented here

**Gate:** A seeded abusive account is stopped by the ladder without operator intervention; pen-test findings closed.

---

## Phase 12 — Load testing and scaling (weeks 40–42)

**Read first:** `docs/00-product-and-scope.md` §24.2, `docs/11-failure-scenarios-and-races.md`

- [ ] k6 scenarios for API read and write paths
- [ ] 1M sends/day soak for 24 h in staging against provider sandboxes; p99 dispatch latency inside target; no unbounded queue growth
- [ ] 10M-event analytics soak
- [ ] Dispatcher throughput profiling; PgBouncer transaction-mode evaluation (with R35/R36 verified under pooling); index review under production-shaped data
- [ ] Hash-partition migration for `campaign_recipients` written and tested, **not applied** (D2)
- [ ] Replace every unmeasured row in the scaling profile with measured numbers

**Gate:** 1M sends/day sustained for 24 h; scaling profile updated with real numbers.

---

## Post-launch (not in this plan)

Phase 13 — automations, against the schema sketch in `docs/00-product-and-scope.md` §24. Phase 14 — adaptive routing, deliverability tooling, and whatever the first fifty customers actually asked for.
