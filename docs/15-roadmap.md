<!-- Development roadmap by phase -->
> **Source of truth note.** This file is extracted from the Technical Design Document v0.1. Where it conflicts with `docs/17-review-findings.md` or `INVARIANTS.md`, those two files win — they contain the corrections from the independent adversarial review. Implement the corrected design, not the original where they differ.

# 23. Development roadmap by phase

## What changed from your ordering, and why

Your phase list had tracking at 8, inbound webhooks at 9, RBAC at 11, billing at 12 and automations at 14. Four changes, each with a reason that costs money if ignored.

**Tracking and inbound provider webhooks move into the same phase as sending.** A system that can send but cannot ingest bounces and complaints is not a smaller version of the product — it is a machine for destroying your customers' sender reputation and, through them, your own standing with SES and SendGrid. Suppression-on-bounce is not a feature that comes later; it is part of the definition of being allowed to send at all. These three ship together or none of them ships.

**Billing moves ahead of the public API, automations and analytics polish.** The gate is not the first email, it is the first external paying customer. Retrofitting metering into a send path that already exists is one of the two or three most reliably painful things in this entire plan, because the billable-unit transaction boundary described in section 8 has to be threaded through code that was written without it. Build the meter when you build the pipe.

**RBAC stops being a phase.** Permission checks and the `WorkspaceScope` repository discipline from section 15 are built in phase 1 and enforced by CI from phase 1. You cannot add tenant isolation to eighty endpoints later; you can only audit eighty endpoints later, which is a far worse job.

**Automations leave the MVP.** They move to phase 13, after launch. Reasoning is in section 24.

## Phase overview

| # | Phase | Ships when | Gate to proceed |
| --- | --- | --- | --- |
| 0 | Foundations | Week 1–2 | CI green on an empty app, one migration applied in staging |
| 1 | Identity, workspaces, RBAC, isolation | Week 3–5 | Tenant-isolation suite passes in CI |
| 2 | Audience and import | Week 6–8 | 500k-row import completes under flat memory |
| 3 | Provider connections and senders | Week 9–11 | All adapters pass the shared contract suite |
| 4 | Templates and rendering | Week 12–13 | Sanitiser blocks the XSS corpus |
| 5 | Queue and worker platform | Week 14–15 | Scheduler survives leader kill, DLQ replay works |
| 6 | Campaign engine, sending, tracking, ingestion | Week 16–22 | 50k-recipient campaign, zero duplicate sends |
| 7 | Analytics rollups and dashboards | Week 23–25 | Rollups match raw within 0.1 percent |
| 8 | Billing end to end | Week 26–30 | Full billing test matrix green |
| 9 | Public API, API keys, outbound webhooks | Week 31–33 | Rate limits and key scoping enforced |
| 10 | Production AWS, CI/CD, DR | Week 34–36 | Timed restore drill inside RTO |
| 11 | Security hardening and anti-abuse | Week 37–39 | Pen-test findings closed, abuse ladder live |
| 12 | Load testing and scaling | Week 40–42 | 1M sends per day sustained in staging |
| 13 | Automations | Post-launch | — |
| 14 | Adaptive routing, deliverability tooling | Post-launch | — |

Week numbers assume three to four engineers. They are a shape, not a commitment. The gates are the real content: each one is a thing that either passes or does not, with no room for optimism.

## Phase 0 — Foundations

**Objective.** Make the boring decisions once so nobody relitigates them in month four. Nothing user-visible ships.

| Stream | Work |
| --- | --- |
| Repo | Monorepo per section 21, pnpm workspaces, Turborepo, five app entrypoints scaffolded as empty processes |
| DB | Drizzle configured, migration runner wired, `uuidv7` helper, base conventions doc, one throwaway migration proven in staging |
| API | Express 5 skeleton, error envelope, request-id middleware, `/health` and `/ready` only |
| Frontend | Vite app shell, Tailwind config, router skeleton, TanStack Query provider |
| Worker | BullMQ connection factory, graceful shutdown harness, no queues yet |
| Platform | Dockerfiles, docker-compose for local Postgres and Redis, GitHub Actions running lint plus typecheck plus test, the five custom ESLint rules from section 21 |
| Tests | Testcontainers Postgres harness, one integration test that migrates and rolls back |

**Done when.** A pull request runs the full CI matrix in under eight minutes, a migration applied in staging is visible in the staging database, and all five lint rules fail a deliberately bad commit.

**Depends on.** Nothing.

**Risk.** Over-engineering the scaffold. Timebox this to two weeks hard. If the monorepo tooling is still being tuned in week three, ship the simplest thing that runs five processes and move on.

## Phase 1 — Identity, workspaces, RBAC, tenant isolation

**Objective.** Every later phase inherits its safety properties from this one. Get the scope plumbing right or pay forever.

| Stream | Work |
| --- | --- |
| DB | `users`, `sessions`, `workspaces`, `workspace_members`, `workspace_invitations`, `audit_logs`; RLS enabled with `SET LOCAL app.workspace_id`; BYPASSRLS role for workers |
| API | Register, verify email, login, refresh, logout, workspace CRUD, invite, accept invite, member role change, session listing |
| Frontend | `/login`, `/register`, verify-email, `/settings/workspace`, `/settings/team`, workspace switcher, auth guards, role-aware UI gating |
| Worker | Transactional email for verification and invites via a single operator-owned provider connection, kept separate from customer sending forever |
| Tests | The six-part tenant-isolation suite from section 15, promoted to a required CI check on day one |

**Done when.** A member of workspace A receives 404 for every workspace B resource; a repository method called without `WorkspaceScope` fails to compile; the CI reflection test enumerates every repository method and confirms the scope parameter; `billing:write` cannot be attached to an API key.

**Depends on.** Phase 0.

**Risk.** The temptation to skip RLS because the repository layer already scopes queries. Do not. RLS is the backstop that catches the one query someone writes at 2 a.m. during an incident. It costs a day now.

## Phase 2 — Audience and import

**Objective.** Contacts, the structures that group them, and an import path that survives a customer uploading a 400 MB export from their old tool.

| Stream | Work |
| --- | --- |
| DB | `contacts` with the partial unique index on lowercased email per workspace, `contact_lists`, `contact_list_members`, `tags`, `contact_tags`, `segments`, `suppressions`, `import_jobs`, `import_row_errors` |
| API | Contact CRUD, bulk tag and untag, list membership, segment definition and preview with a hard count cap, suppression CRUD, presigned S3 upload, import start and status |
| Frontend | `/audience/contacts` with server-side pagination and filtering, `/audience/lists`, `/audience/tags`, `/audience/imports` with live progress, `/audience/suppressions`, column-mapping step, failed-row CSV download |
| Worker | `contact-import` consumer: stream from S3, parse, validate, dedupe within file and against the database, `COPY` into a staging table, merge, emit per-row errors |
| Tests | Malformed CSV corpus, mixed encodings, BOM, CRLF, formula-injection payloads, 500k-row memory profile, duplicate-within-file and duplicate-against-db cases |

**Done when.** A 500k-row file imports with flat resident memory, the import report distinguishes created, updated, skipped-duplicate and failed with reasons, and every cell beginning with an equals, plus, minus or at character is neutralised on export.

**Depends on.** Phase 1.

**Risk.** Segments. The temptation is a general-purpose query builder. Ship a fixed set of predicates in MVP with a preview count and an explicit cap; a Turing-complete segment language is how you get queries nobody can index.

## Phase 3 — Provider connections and sender accounts

**Objective.** The abstraction from section 9, implemented for real, with credentials that never touch the database in plaintext.

| Stream | Work |
| --- | --- |
| DB | `provider_connections` holding a Secrets Manager ARN and never a secret, `sender_accounts`, `sender_identities`, `provider_webhook_events` |
| API | Connect, verify, rotate, disconnect per provider; sender CRUD; identity verification status; test-send endpoint |
| Frontend | `/providers` connection cards with health state, per-provider credential forms, `/senders` with verification status and daily-limit display |
| Worker | `provider-verify` recurring job refreshing connection health and reported limits; credential-rotation handler |
| Tests | The shared `contract.spec.ts` of roughly forty cases that every adapter must pass, run against sandbox accounts in CI and against recorded fixtures locally |

**Order within the phase.** SES first because it is the strictest and will expose abstraction leaks early. Then SMTP because it is the most widely usable and the weakest in feedback. Then SendGrid, Mailgun, Brevo. Google Workspace last, and only if demand justifies it — the roughly two thousand recipients per day ceiling and the restricted-scope security assessment make it a poor return on a month of work.

**Done when.** Every adapter passes the contract suite unchanged, a wrong credential produces a typed `ProviderError` with `kind` and `affects` rather than a stack trace, and no provider SDK is importable outside its adapter directory.

**Depends on.** Phase 1.

**Risk.** Building the abstraction from one provider. Write the port against SES and SMTP simultaneously; a port shaped by a single implementation is an implementation with extra steps.

## Phase 4 — Templates and rendering

**Objective.** Safe authoring, deterministic rendering, and previews that tell the truth.

| Stream | Work |
| --- | --- |
| DB | `templates`, `template_versions` with immutable published versions |
| API | Template CRUD, version publish, render-preview with sample contact, test-send |
| Frontend | `/templates`, `/templates/create` with an HTML editor plus a block editor if time allows, merge-tag picker, desktop and mobile preview, plain-text fallback editor |
| Worker | None |
| Tests | XSS corpus against the sanitiser, merge-tag resolution including missing fields and default values, plain-text auto-generation, template rendering determinism |

**Done when.** The sanitiser strips every payload in the corpus, a missing merge field renders its configured default rather than a literal token, and a campaign records the template version id it rendered so a later edit cannot change history.

**Depends on.** Phase 2 for contact fields.

**Risk.** Scope creep into a drag-and-drop email builder. That is a quarter of work on its own. MVP ships an HTML editor with merge tags and a small set of prebuilt layouts.

## Phase 5 — Queue and worker platform

**Objective.** The operational substrate from section 12 before anything important runs on it.

| Stream | Work |
| --- | --- |
| DB | `job_dead_letters`, scheduler leader-election table |
| API | Internal-only queue depth and DLQ inspection endpoints behind operator auth |
| Frontend | Operator console, unstyled and internal |
| Worker | All nine queues declared with their concurrency, timeout, backoff and retention settings; DLQ handler; `scheduler` with `pg_try_advisory_lock` leader election; graceful shutdown that drains in-flight jobs before exit |
| Tests | Kill the leader mid-tick and assert exactly one successor; SIGTERM mid-job and assert no job loss; DLQ replay restores a job to its queue exactly once |

**Done when.** A rolling ECS deployment completes with zero lost jobs and zero duplicate executions under a synthetic load of ten thousand queued jobs.

**Depends on.** Phase 0.

**Risk.** Treating BullMQ defaults as adequate. They are not. Every queue gets explicit settings, and `removeOnComplete` bounded by count and age or Redis memory becomes the outage.

## Phase 6 — Campaign engine, sending, tracking and ingestion

**Objective.** The product. This is the largest phase by a wide margin and should be planned as roughly seven weeks, not three.

| Stream | Work |
| --- | --- |
| DB | `campaigns` with the extended state set, `campaign_recipients` as the durable state machine, `campaign_events`, `tracked_links`, `email_events` partitioned monthly, `sending_pools`, `sending_pool_members` |
| API | Campaign CRUD, audience attach with preview count, schedule, launch, pause, resume, cancel, clone, retry-failed, progress polling; pool CRUD; the two public tracking routes on the separate `track` service |
| Frontend | Seven-step wizard, review step with a real pre-flight checklist, `/campaigns` list with live progress, `/campaigns/:id` detail with recipient-level state and search |
| Worker | `campaign-launch` snapshotter, dispatcher with the bounded five thousand job window and `FOR UPDATE SKIP LOCKED` claims of five hundred, `email-send` consumer with `jobId` of `send:{recipientId}`, `email-retry`, `webhook-processing` ingesting provider callbacks, suppression-on-bounce-and-complaint |
| Tests | The full race-condition matrix from section 19, duplicate-send assertions, pause and cancel under load, provider failover, out-of-order provider events, tracking token forgery attempts |

**Internal sequencing.** Launch and snapshot first, then single-sender dispatch, then pool routing, then pause and resume and cancel, then tracking endpoints, then inbound webhook ingestion, then retry and failover. Do not build pool routing before single-sender sending works end to end.

**Done when.** A fifty thousand recipient campaign completes with every recipient in a terminal state, zero duplicate provider accepts under a chaos run that kills workers mid-send, pause takes effect within one dispatcher tick, bounces suppress within seconds of the provider callback, and a forged tracking token is rejected without touching the database.

**Depends on.** Phases 2, 3, 4, 5.

**Risk.** This phase is where schedule optimism goes to die. If it is running two weeks long, cut pool routing to single-sender sending and ship; routing is an optimisation, correctness is not.

## Phase 7 — Analytics rollups and dashboards

**Objective.** Turn the event stream into numbers a customer trusts.

| Stream | Work |
| --- | --- |
| DB | `campaign_stats`, `campaign_daily_stats`, `provider_stats`, `device_stats`, `link_stats`, `contact_engagement` |
| API | Campaign analytics, link analytics, provider analytics, device analytics, workspace overview, CSV export |
| Frontend | `/dashboard`, `/campaigns/:id/analytics` with Recharts, link heat table, the open-rate caveat rendered in the UI rather than buried in docs |
| Worker | `analytics-processing`: thirty-second incremental rollup from the Redis dirty set plus the hourly authoritative recompute |
| Tests | Rollup-versus-raw reconciliation, partition boundary correctness, late-arriving events, timezone handling on daily buckets |

**Done when.** Incremental and authoritative rollups agree within 0.1 percent across a seeded ten million event dataset, and the dashboard labels opens as an approximate signal affected by privacy proxies.

**Depends on.** Phase 6.

**Risk.** Dashboard sprawl. Four charts that are correct beat twelve that disagree with each other.

## Phase 8 — Billing end to end

**Objective.** Everything in sections 5 through 8, live. This is the gate before external signups open.

| Stream | Work |
| --- | --- |
| DB | `billing_customers`, `plans`, `features`, `plan_features`, `prices`, `subscriptions`, `subscription_items`, `invoices`, `payments`, `refunds`, `payment_methods`, `coupons`, `discounts`, `entitlements`, `usage_records`, `usage_aggregates`, `billing_events`, `payment_webhook_events` |
| API | Checkout session creation, billing portal session, subscription read, plan-change pre-check returning `422 plan_downgrade_blocked`, upgrade, scheduled downgrade, cancel at period end, cancel immediately, invoice list, usage read, the Stripe webhook endpoint |
| Frontend | `/billing`, `/billing/plans`, `/billing/checkout`, `/billing/success` polling backend state rather than trusting the redirect, `/billing/cancel`, `/billing/invoices`, `/billing/payment-method`, usage meters, past-due banner, downgrade blocker dialog |
| Worker | `billing-webhook` convergent handler that re-fetches from Stripe and compares `provider_state_version`; `billing-processing` for entitlement rebuilds and the dunning ladder; metering wired into the send path inside the same transaction as the `sent` transition |
| Tests | The twelve critical billing cases from section 20, plus the metering invariants: retry does not double-count, failover does not double-count, suppressed recipients never count, refunds do not claw back usage, mid-period upgrade does not reset the counter |

**Done when.** Every case in the billing matrix passes against Stripe test mode including deliberately duplicated and deliberately reordered webhooks; entitlements can be dropped and rebuilt from subscriptions with byte-identical output; a frontend that never receives the success redirect still converges to the right state within one poll interval.

**Depends on.** Phase 6 for the metering point, phase 1 for workspace ownership.

**Risk.** Discovering in week 28 that the billable-unit transaction boundary does not fit the send path as built. Mitigate by writing the `usage_records` insert into the phase 6 send transaction from the start, even while plans and prices do not exist yet — a metered flag and a ledger row cost nothing before billing is live and save a rewrite after.

## Phase 9 — Public API, API keys, outbound webhooks

**Objective.** Let customers integrate without giving them a session cookie.

| Stream | Work |
| --- | --- |
| DB | `api_keys` with hashed secrets and scope arrays, `outbound_webhook_endpoints`, `outbound_webhook_deliveries` |
| API | Key issue, list, revoke; scoped key authentication middleware; per-key rate limiting; the outbound webhook subscription endpoints; versioned error envelope confirmed across every route |
| Frontend | `/settings/api` with one-time secret reveal, scope selection, last-used display, webhook endpoint management with signing-secret rotation and a delivery log |
| Worker | Outbound webhook delivery with exponential backoff and endpoint auto-disable after sustained failure |
| Tests | Scope enforcement per endpoint, `billing:write` refused on every key, rate-limit behaviour at the boundary, signature verification from a third-party perspective, idempotency-key replay |

**Done when.** An external integrator can create a contact, launch a campaign and receive a signed delivery event without ever touching the web app, and a key scoped to read cannot write anything.

**Depends on.** Phases 6 and 8.

## Phase 10 — Production AWS, CI/CD, disaster recovery

**Objective.** Two environments, reproducible, with a restore you have actually performed.

| Stream | Work |
| --- | --- |
| Platform | Terraform for VPC, subnets, security groups, ALB, five ECS Fargate ARM64 services, RDS with Multi-AZ in production, ElastiCache, S3, CloudFront, Route53, KMS, Secrets Manager, ECR |
| CI/CD | Build once and promote the same image digest, migrations as a one-off ECS task before service update, smoke tests against staging, manual approval to production, rollback by redeploying the previous digest |
| Observability | Sentry, CloudWatch dashboards and alarms, Prometheus metrics endpoint, the trace-id chain from section 18 verified end to end |
| Tests | Timed restore drill, failover test on RDS, deployment under load with zero dropped requests |

**Done when.** A restore from a point-in-time snapshot completes inside the one hour RTO with a stopwatch on it, a single email is traceable from request id through campaign recipient id to provider message id in one query, and a deliberately broken deploy rolls back in under five minutes.

**Risk.** The drill that is planned and never run. Put it on the calendar quarterly and treat a missed drill as an incident.

## Phase 11 — Security hardening and anti-abuse

**Objective.** Close the gap between built-in controls and adversarial reality.

Work: external penetration test; the graduated abuse-enforcement ladder live; verified-email-before-send and the five hundred per day new-account cap; consent attestation on import and launch; complaint-rate auto-pause at 0.3 percent; launch-time phishing lint; link reputation checks; the global cross-workspace block list; secret-scanning and dependency audit in CI; a documented incident-response runbook.

**Done when.** Every finding above informational is closed or has a written, dated acceptance; a seeded abusive account is stopped by the ladder without operator intervention.

**Risk.** Treating anti-abuse as a trust-and-safety problem to solve after growth. Your provider relationships and your domain reputation are the assets at stake, and both are easier to protect than to repair.

## Phase 12 — Load testing and scaling

**Objective.** Find the bottleneck before a customer does.

Work: k6 scenarios for API read and write; a one million send per day soak in staging against provider sandboxes; ten million event analytics soak; dispatcher throughput profiling; connection-pool sizing with PgBouncer evaluated; index review under production-shaped data; the first partition-maintenance automation validated at scale.

**Done when.** One million sends per day sustains for twenty-four hours with p99 dispatch latency inside target and no queue growing without bound; the profile from section 24 is confirmed or corrected with measured numbers.

## Phases 13 and 14 — post-launch

Phase 13 builds automations against the schema sketched in section 24. Phase 14 covers adaptive routing, deliverability tooling such as DMARC report ingestion and seed-list testing, and whatever the first fifty customers actually asked for — which will be different from this list, and should be.
