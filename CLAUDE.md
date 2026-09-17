# CLAUDE.md — Relayd

Relayd is a bring-your-own-provider email campaign orchestration SaaS. Customers connect their own SES / SendGrid / Mailgun / Brevo / SMTP credentials; we provide audience management, campaigns, sending pools, tracking, analytics, billing and anti-abuse. We never carry delivery reputation and we never hold a plaintext provider secret in the database.

This file is the operating manual for building it. Read it fully before writing any code, and re-read the relevant `docs/` file before starting any phase.

---

## 1. Where the truth lives, in priority order

1. `INVARIANTS.md` — 36 rules that must never break, each with the test that proves it. Highest authority.
2. `docs/17-review-findings.md` — the independent adversarial review. Supersedes the original design wherever they differ.
3. `BUILD-PLAN.md` — the phase-by-phase checklist you execute. One phase at a time, in order.
4. `docs/00` through `docs/16` — the full design, extracted from the Technical Design Document. Detailed and authoritative *except* where 1 and 2 correct it.

If two documents disagree, the lower-numbered item in this list wins. If something is not covered anywhere, stop and ask rather than invent.

## 2. Locked technology decisions

Do not substitute any of these without an explicit instruction from the owner.

| Layer | Decision | Notes |
|---|---|---|
| Language | TypeScript, `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` | Config in `docs/13-repo-and-coding-standards.md` |
| Runtime | Node.js 22 LTS | ESM, `NodeNext` module resolution |
| Package manager | pnpm workspaces + Turborepo | One monorepo, one container image |
| API | Express 5 | Strict route → controller → service → repository layering; Zod at every boundary |
| ORM | Drizzle | Never Prisma. We need partitioning, `COPY`, `FOR UPDATE SKIP LOCKED`, advisory locks, partial unique indexes |
| Database | PostgreSQL 16 | The only durable store. RLS enabled on every tenant table |
| Queue | Redis + BullMQ | Transport only. Never the system of record for anything |
| Frontend | React 18 + Vite + Tailwind + React Router + TanStack Query + React Hook Form + Zod + Recharts | TanStack Query is the only server-state mechanism. No Redux |
| Payments | Stripe direct + Stripe Tax | Not a merchant of record. No abstraction layer for a hypothetical second provider |
| Compute | AWS ECS Fargate ARM64 | Terraform in `infra/terraform` |
| Secrets | AWS Secrets Manager + KMS | Database stores an ARN, never a secret |
| Observability | Pino structured logs, Sentry, CloudWatch, Prometheus endpoint | One trace id from request → recipient → provider message id |
| Testing | Vitest, Testcontainers (Postgres, Redis), Playwright for e2e, k6 for load | |

## 3. Repository layout

```
relayd/
  apps/
    web/          React SPA
    api/          Express — dashboard API and public API (authenticated)
    edge/         Public, unauthenticated, high-volume: tracking pixel, click redirect,
                  unsubscribe, provider webhook ingest, Stripe webhook ingest.
                  Writes to queue only. (The original design had separate track/ingest apps;
                  the review merged them — see F33.)
    worker/       ONE app, entrypoints in src/entrypoints/{send,campaign,events,billing,io}.ts
    scheduler/    Leader-elected ticker. Direct Postgres connection, never through PgBouncer.
  packages/
    config/       Zod-parsed env. The ONLY place process.env is read.
    logger/       Pino, redaction, AsyncLocalStorage trace context.
    types/        Shared DTOs and branded ids (WorkspaceId, CampaignId, RecipientId ...).
    validation/   Zod schemas shared by api and web.
    utils/        crypto, dates, Result types.
    db/           Drizzle schema, migrations, repositories. The ONLY place db.* is called.
    queue/        BullMQ setup, typed job definitions, queue settings.
    email-providers/  The ProviderPort and adapters/{ses,smtp,sendgrid,mailgun,brevo}.
    billing/      Plans, features, entitlements, Stripe adapter, metering.
    campaigns/    Launch, snapshot, dispatch, state machine.
    audience/     Contacts, segments, import parsing.
    analytics/    Rollups, metric definitions.
    notifications/ Product email (verification, invites, dunning).
    testing/      Factories, containers, fake gateways, contract suites.
  infra/terraform/{modules,environments/{staging,production}}
  infra/docker/
  docs/           This plan.
```

## 4. Commands

Create these in the root `package.json` during Phase 0 and keep them working forever.

```
pnpm dev            # docker-compose up postgres+redis, then all apps in watch mode
pnpm build          # turbo build
pnpm typecheck      # tsc -b across the workspace
pnpm lint           # eslint including the five custom rules in section 7
pnpm test           # vitest unit + integration (Testcontainers)
pnpm test:isolation # the tenant-isolation suite — required CI check
pnpm test:contract  # provider adapter contract suite against recorded fixtures
pnpm test:billing   # the billing matrix against Stripe test mode (needs STRIPE_TEST_KEY)
pnpm db:generate    # drizzle-kit generate
pnpm db:migrate     # run migrations (local); in ECS this is a one-off task, never at boot
pnpm db:reset       # drop, recreate, migrate, seed (local only)
```

## 5. How to work this plan

- **One phase at a time**, in `BUILD-PLAN.md` order. Do not start a phase until the previous phase's gate passes.
- **Within a phase, one checklist item per commit** where practical. Conventional Commits: `feat(campaigns): guarded sending transition`.
- **Before coding a phase**, read its `docs/` references listed in `BUILD-PLAN.md`. Before touching the send path, billing or anything tenant-scoped, re-read `INVARIANTS.md`.
- **Tests first for anything in INVARIANTS.md.** Write the failing test that proves the invariant, then make it pass.
- **Definition of done for every PR:** typecheck clean, lint clean (including custom rules), tests green, no new `TODO` without a linked issue, migration reviewed against section 8 below, and the phase gate criteria updated in `BUILD-PLAN.md` (tick the box).
- **When the docs are silent**, ask. When the docs are wrong, say so and propose the fix — do not quietly work around them.
- **Never** write code for a FUTURE-tier feature (automations, adaptive routing, Google Workspace adapter) even if it seems easy. The schema leaves room for them; the code does not include them.

## 6. Architecture rules (machine-enforced where possible)

1. **Layering.** `route → controller → service → repository`. Controllers parse and validate with Zod and call one service. Services hold business logic and throw `AppError` subclasses. Repositories are the only code that touches Drizzle.
2. **Scope is a type.** Every repository method takes a branded `WorkspaceScope` as its **first** parameter. A CI reflection test enumerates all repository methods and fails if any lacks it. No exceptions except explicitly named cross-tenant repositories in `packages/db/repositories/global/`.
3. **Four process types**, one image: `api`, `edge`, `worker`, `scheduler`. `edge` must never import from `apps/api`; it depends on `packages/queue`, `packages/db` (read-mostly) and `packages/utils` only.
4. **Provider port.** Adapters live only in `packages/email-providers/adapters/*`. The rate limiter and the daily-quota check live *inside* the adapter call path so no consumer can forget them.
5. **Errors.** One `AppError` base class with a code enum. One Express error middleware maps to the error envelope in `docs/03-api.md`. Workers distinguish retryable from permanent errors explicitly. Never swallow an error to return a default.
6. **Logging.** Structured fields, never interpolated strings. Redaction configured centrally in `packages/logger`. Provider errors are scrubbed into `ProviderError` at the adapter boundary before they can reach a log, Sentry or the UI.

## 7. The five custom ESLint rules

These encode the architecture. Build them in Phase 0 as a local ESLint plugin (`packages/eslint-plugin-relayd`) and make them errors, not warnings.

| Rule | What it forbids |
|---|---|
| `relayd/no-db-outside-repositories` | `db.select`, `db.insert`, `db.update`, `db.delete`, `db.execute` outside `packages/db/repositories/**` |
| `relayd/no-plan-literals` | String literals matching plan codes (`free`, `starter`, `pro`, `business`, `enterprise`) in comparisons outside `packages/billing/plans/**` |
| `relayd/no-provider-sdk-imports` | Importing `@aws-sdk/client-sesv2`, `nodemailer`, `@sendgrid/*`, `mailgun.js`, `@getbrevo/*`, `stripe` outside their adapter directories |
| `relayd/no-process-env` | `process.env` outside `packages/config/**` |
| `relayd/no-console` | `console.*` anywhere in `apps/**` and `packages/**` |

## 8. Database rules

- UUIDv7 primary keys generated in the app, except append-only high-volume event tables (`email_events`, `automation_events`) which use `BIGSERIAL` for index locality.
- Every tenant-owned table has a non-null `workspace_id` and a composite index leading with it.
- **RLS on every tenant table.** Policies read `current_setting('app.workspace_id', true)`. Transactions set it with `SET LOCAL` — a bare `SET` is banned by a test that greps the codebase. `SET LOCAL` is transaction-scoped and therefore safe under PgBouncer transaction pooling.
- Two database roles: `relayd_app` (RLS enforced; used by `api`, `edge`, and all single-workspace jobs) and `relayd_global` (BYPASSRLS; used only by an allowlisted set of cross-tenant job types listed in `packages/queue/global-jobs.ts`).
- Migrations are numbered SQL files, immutable once merged, with a `-- ROLLBACK:` comment. `CREATE INDEX CONCURRENTLY` always in its own migration. Expand-then-contract for any column change. Migrations run as a one-off ECS task before the service update — **never at container boot**.
- `campaign_recipients`: `fillfactor = 80`, aggressive autovacuum, partial index on active states only, `metered` column protected by a write-once trigger. See `INVARIANTS.md` R1, R5, R14, R27.
- `email_events` partitioned by range on `occurred_at`; weekly to start, daily above ~1M events/day; partitions created 7 days ahead by the scheduler with `lock_timeout` set.
- Never hash-partition `campaign_recipients` in the MVP (decision D2). Write and test the migration in Phase 12 so it is ready.

## 9. Queue rules

- **Redis is transport.** Postgres is the system of record for intent and state. Every place Redis would hold the only copy of something has a Postgres-backed reconciler.
- Every queue declares explicit `concurrency`, `lockDuration`, `attempts`, `backoff`, `removeOnComplete` and `removeOnFail` bounds. Defaults are never accepted.
- `email-send`: `lockDuration: 120_000`, `maxStalledCount: 0`, provider call timeout 30 s (API) / 60 s (SMTP), batch size ≤ 100. `jobId = send:{recipientId}` is a dedupe **optimisation only**; the durable guard is the state transition in Postgres.
- Idempotency for every consumer is a guarded `UPDATE ... WHERE state IN (...) RETURNING`; zero rows means exit cleanly.
- Recurring work is driven from the `scheduled_jobs` table in Postgres by the `scheduler` process. **BullMQ repeatable jobs are not used.**
- The rate limiter fails **closed**: Redis unreachable means do not send, throw retryable.
- Full queue table with settings: `docs/04-campaign-engine-and-queues.md`, amendments section H.

## 10. Billing rules

- Stripe owns money objects (charges, invoices, subscription status, refunds, payment methods). We own plans, features, limits, entitlements, usage and the workspace ↔ Stripe mapping.
- The `billing_customers` row is written **before** the Stripe customer is created; `client_reference_id` and `metadata.billing_customer_id` are set on every Checkout Session; webhooks resolve through metadata.
- Webhook handlers: verify signature → insert into `payment_webhook_events` (unique on provider event id) → return 200 in under 200 ms → mark the object dirty in `billing_refetch_queue`. A separate consumer re-fetches each object at most once per 30 s and reconciles by `provider_state_version`.
- `entitlements` is a rebuildable projection of `subscriptions` × `plan_features`. A nightly `billing-reconcile` job compares local rows with Stripe and emits a divergence metric.
- **Billable unit:** a `campaign_recipients` row transitioning to `sent` for the first time. `metered` is write-once. `usage_records` has a unique `idempotency_key = send:{recipientId}`. Retries, failover, bounces, complaints, `delivery_uncertain` and suppressed recipients never count. Refunds never claw back usage. Upgrades never reset the counter.
- Entitlement checks are server-side only, inside the same transaction as the action they gate (`FOR SHARE` on the entitlement row at launch).
- Frontend never trusts the checkout redirect; `/billing/success` polls our API until the webhook-derived row exists, with a server-side session lookup fallback after 10 s.

## 11. Security rules

- Non-members receive **404** for another workspace's resources, never 403. 403 is for a member lacking permission.
- `billing:write` is owner-only and can never be attached to an API key. `campaign:launch` is separate from `campaign:write`.
- Provider webhook ingest is **per connection**: `POST /ingest/v1/{provider}/{endpointToken}`. Signature verified with that connection's own secret. Event → recipient lookup is scoped to `(workspace_id, provider_connection_id)`. Unmatched events are stored with `matched = false` and never mutate anything.
- One-click unsubscribe acts on **POST only** (RFC 8058, `List-Unsubscribe-Post` header). GET renders a confirmation page and changes nothing.
- Tracking tokens are HMAC-signed opaque blobs; click URLs are resolved from `tracked_links` by index so open redirect is structurally impossible. IPs are hashed with a daily rotating salt.
- Secrets Manager paths: `relayd/{env}/ws/{workspaceId}/conn/{connectionId}`; IAM scoped by prefix; decrypted material cached in memory ≤ 5 minutes; every fetch emits an audit row.
- Anti-abuse launch set is a hard requirement before Phase 11 gate: verified sender identity before send; 500 sends/day cap for accounts under 7 days old; consent attestation at import and launch; complaint-rate auto-pause at 0.3%; launch-time phishing lint and link reputation; global cross-workspace block list.
- A test asserts a known credential string never appears in any serialised error or log line.

## 12. Things to never do

- Never use a Redis distributed lock (Redlock or otherwise). Use a unique index, a guarded update, `FOR UPDATE SKIP LOCKED`, or `pg_try_advisory_xact_lock` — in that order of preference.
- Never use session-level `pg_try_advisory_lock`; only the transaction-scoped `_xact_` variant, and only from the `scheduler` which connects directly to Postgres.
- Never compute campaign progress or completion with `COUNT(*)` over `campaign_recipients` in a request path. Use `campaign_counters`.
- Never treat a provider's accepted response as "delivered". It means accepted for delivery.
- Never reset `metered` to false. The trigger will reject it; do not remove the trigger.
- Never check suppression only at snapshot time. Re-check at send time.
- Never let a transient state (`validating`, `queueing`, `pausing`, `cancelling`, `sending` on a recipient) exist without a timeout and a reconciler.
- Never run migrations at container start.
- Never put `SET app.workspace_id` (without `LOCAL`) anywhere.
- Never build FUTURE-tier features. Never add a GraphQL layer, microservices split, Kubernetes, event sourcing, ClickHouse, or a second payment provider abstraction.

## 13. Decision defaults

These are the owner's open decisions (`docs/16-self-review-and-decisions.md`). Until the owner answers, build to these defaults and flag any code that depends on them with `// DECISION:Dn`.

| ID | Default |
|---|---|
| D1 | Stripe direct + Stripe Tax. No merchant of record. |
| D2 | `campaign_recipients` unpartitioned; write and test the hash-partition migration in Phase 12. |
| D3 | Crash after provider accept: do **not** resend. Recipient becomes `delivery_uncertain`, unbilled, surfaced in the campaign report. Per-workspace override flag exists but defaults off. |
| D4 | SMTP is labelled best-effort in the UI; no automatic bounce suppression for SMTP senders in MVP. |
| D5 | Archived analytics are **not** restored on plan upgrade. |
| D6 | No Google Workspace adapter in MVP. |
| D7 | **No free tier.** If the owner adds one: hard cap of 300 sends/month, verified identity required, excluded from pool routing, counted in the new-account abuse ladder. |

## 14. Definition of done for the whole MVP

All Phase 0–12 gates in `BUILD-PLAN.md` ticked; every row of `INVARIANTS.md` has a passing test referenced by file path; a 50,000-recipient campaign completes under a chaos run with zero duplicate provider accepts; the full billing matrix passes against Stripe test mode including duplicated and reordered webhooks; a timed restore drill completes inside the one-hour RTO; the tenant-isolation suite is a required CI check on `main`.
