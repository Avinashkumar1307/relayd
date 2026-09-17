<!-- Architectural decision records -->
> **Source of truth note.** This file is extracted from the Technical Design Document v0.1. Where it conflicts with `docs/17-review-findings.md` or `INVARIANTS.md`, those two files win — they contain the corrections from the independent adversarial review. Implement the corrected design, not the original where they differ.

# 22. Architectural decision records

Fourteen decisions, each with the options considered, the call, and what it costs. These go in `docs/adr/` as individual files and are amended, never rewritten, when a decision changes.

## ADR-001 Modular monolith, not microservices

**Context.** Small team, unproven product, workload with genuinely different scaling profiles (request-serving vs batch sending vs webhook absorption).

**Options.** (a) Single process for everything. (b) Modular monolith, one codebase, several deployable process types. (c) Microservices per domain.

**Decision.** (b).

**Reason.** The scaling profiles differ, so (a) means scaling the dashboard to handle a send burst. But the *domains* are tightly coupled — a send touches audience, delivery, campaigns, billing and analytics — so (c) would turn every feature into a distributed transaction across four repositories with a team too small to own them.

**Trade-offs.** One deploy pipeline and shared dependency versions; a bad dependency upgrade affects everything. Module boundaries are enforced by lint and review rather than by the network, so they need discipline.

**Consequences.** Package boundaries must be respected from day 1 so extraction stays possible. `track` and `ingest` are extracted immediately because they are genuinely independent.

## ADR-002 Drizzle over Prisma

**Context.** Heavy use of partitioning, bulk loads, row locks and analytical SQL.

**Options.** Prisma; Drizzle; Kysely; raw `pg` with a query builder.

**Decision.** Drizzle, with `postgres.js` as the driver.

**Reason.** Full section 2 comparison. Five of six high-weight criteria favour Drizzle, and the sixth (migration tooling) is one where hand-written SQL is an advantage for this schema.

**Trade-offs.** Weaker migration diffing; a less mature ecosystem; requires SQL fluency on the team. Kysely was close but has a thinner schema story.

**Consequences.** Migrations are hand-reviewed SQL. Onboarding docs must include the schema conventions in section 3.

## ADR-003 Redis + BullMQ for queueing

**Context.** Millions of jobs, delayed jobs, retries, priorities, and a team already running Redis for caching and rate limiting.

**Options.** BullMQ on Redis; SQS; pgboss on Postgres; Kafka.

**Decision.** BullMQ, with SQS as a fallback if Redis operations become painful.

**Reason.** Best throughput-per-complexity for this shape of work, first-class TypeScript, and delayed jobs and rate limiting come free. Kafka is the wrong tool — this is a job queue, not an event log. pgboss would avoid a second datastore but puts high-churn queue load on the database that also serves the dashboard.

**Trade-offs.** Redis becomes operationally critical; jobs are lost if Redis is lost. Mitigated by keeping all state in Postgres, so queue contents are reconstructible (section 12).

## ADR-004 Provider abstraction via a typed port with classified errors

**Context.** Six providers with incompatible APIs, error vocabularies and webhook formats.

**Options.** Direct SDK calls with branching; Nodemailer for everything; a custom port per provider.

**Decision.** Custom port, section 9, with a shared contract test suite.

**Reason.** Nodemailer covers SMTP well but flattens API-specific behaviour — batch sending, quota reporting and webhook parsing all disappear. The error classification is the part that actually keeps provider knowledge out of business logic.

**Trade-offs.** Each new provider is real work, roughly a week including contract tests.

## ADR-005 Shared-database multi-tenancy with `workspace_id` plus RLS

**Context.** Thousands of tenants, most small.

**Options.** Database per tenant; schema per tenant; shared tables with a tenant column.

**Decision.** Shared tables, `workspace_id` everywhere, RLS as a backstop.

**Reason.** Database-per-tenant makes migrations, connection pooling and cross-tenant analytics untenable past a few hundred tenants. Schema-per-tenant has the same migration problem in slower motion.

**Trade-offs.** A bug can cross tenants, so four enforcement layers and a dedicated test suite are mandatory. A very large enterprise customer wanting physical isolation would need a separate deployment.

## ADR-006 Stripe direct, not a merchant of record

**Context.** UAE-based entity selling globally, section 5.

**Options.** Stripe; Paddle or Lemon Squeezy as MoR; Razorpay; multiple from day 1.

**Decision.** Stripe with Stripe Tax; Razorpay considered later for Indian domestic volume.

**Reason.** Category risk with MoRs for bulk-email tooling; superior subscription primitives; fee difference at scale.

**Trade-offs.** You carry the tax registration and filing burden, which needs a professional adviser and possibly a finance hire. Revisit if the customer mix turns out to be mostly small international consumers.

## ADR-007 Provider-mirrored billing with locally-owned entitlements

**Context.** Billing state must be authoritative somewhere.

**Options.** Query the provider on every entitlement check; mirror everything locally; fully local billing with the provider as a dumb charging rail.

**Decision.** Mirror money objects, own plans and entitlements locally.

**Reason.** Querying Stripe on every send is impossible at 2,000 sends/second. Fully local billing means reimplementing proration, dunning and tax. The mirror gives local read speed with the provider as the source of truth for money.

**Trade-offs.** Drift is possible, so reconciliation is mandatory. Webhook processing becomes business-critical.

## ADR-008 Transactional metering with a Redis read cache

**Context.** Usage is money and must be exact; it is also read on every send.

**Options.** Live count; Redis counters flushed periodically; transactional Postgres counters with a Redis cache; an event-sourced meter.

**Decision.** Transactional Postgres with an append-only `usage_records` ledger, plus a Redis cache for gates.

**Reason.** Only the transactional option makes the counter and its evidence provably consistent, because both are written in the same transaction as the state change that caused them.

**Trade-offs.** Hot-row contention at high volume, addressed by batching then sharding (section 8).

## ADR-009 HMAC tracking tokens with server-side link resolution

**Context.** Public, high-volume, unauthenticated endpoints.

**Options.** Sequential ids; UUID lookup; signed tokens; encrypted payloads.

**Decision.** HMAC-signed opaque tokens carrying `message_token` plus a link index.

**Reason.** Verifiable without a database hit, unforgeable, non-enumerable, and structurally incapable of becoming an open redirect.

**Trade-offs.** Key rotation needs a key-id prefix and a 13-month overlap window.

## ADR-010 Inbox-table webhook processing with convergent handlers

**Context.** At-least-once, unordered delivery from seven external systems.

**Options.** Process inline in the request; queue the payload; persist to an inbox then queue the id.

**Decision.** Persist to an inbox table, enqueue the row id, and have the worker re-fetch current state from the provider.

**Reason.** Persisting first means a queue failure cannot lose an event. Re-fetching makes handlers convergent, which dissolves the entire out-of-order problem class rather than trying to sequence events.

**Trade-offs.** An extra provider API call per event, and a provider outage delays processing rather than corrupting state — the right trade.

## ADR-011 ECS Fargate on ARM, not EC2 or Kubernetes

**Context.** No dedicated platform engineer.

**Options.** EC2 with ECS; Fargate; EKS; App Runner; Lambda.

**Decision.** Fargate, ARM64.

**Reason.** Fargate removes node management entirely. EKS is a full-time job. Lambda fits the tracking endpoints but not long-running workers, and mixing both doubles the deployment model. App Runner cannot express the worker fleet.

**Trade-offs.** Roughly 20–30% more expensive than equivalent EC2 at steady state, and slower task start than warm EC2. Revisit above roughly $3,000/month of Fargate spend.

## ADR-012 Secrets Manager with split read and write roles

**Context.** Customer provider credentials are the most sensitive data we hold.

**Options.** Encrypted columns with an app-held key; Secrets Manager; Parameter Store; HashiCorp Vault.

**Decision.** Secrets Manager, with the API role able to write but not read, and only the worker role able to read.

**Reason.** The asymmetry is the whole point: the internet-facing service that accepts credentials cannot read them back, so a compromised API container cannot dump every customer's sending credentials.

**Trade-offs.** Per-secret cost at tens of thousands of workspaces (mitigated by one secret per provider connection, not per field); an API call on cache miss.

## ADR-013 Recipient snapshot at launch, not live audience resolution

**Context.** Audiences change while campaigns run.

**Options.** Resolve the audience continuously; snapshot at launch.

**Decision.** Snapshot into `campaign_recipients` at launch, including merge data.

**Reason.** It makes progress, pause, resume, retry and billing all well-defined, and it makes "who did we send this to and what did they see?" answerable a year later. Continuous resolution makes every one of those questions ambiguous.

**Trade-offs.** Someone added to a list after launch does not receive that campaign, which must be explained in the UI. Storage of one row per recipient per campaign, which is the cost of an audit trail.

## ADR-014 Open-rate demotion

**Context.** Apple MPP and image proxying make opens unreliable.

**Options.** Report opens as the primary metric like most tools; drop open tracking; keep it but demote it with explicit bot and prefetch flags.

**Decision.** Keep, flag, demote, and make clicks the headline metric.

**Reason.** Reporting an inflated number as truth is a correctness failure that customers make budget decisions on. Removing it entirely loses a real directional signal and breaks comparison with tools they are migrating from.

**Trade-offs.** Our open rates will look lower than a competitor's for the same campaign, which is a sales conversation. The honest framing is a differentiator with sophisticated buyers and a friction point with unsophisticated ones.
