<!-- Self-review, contradictions fixed and decisions required -->
> **Source of truth note.** This file is extracted from the Technical Design Document v0.1. Where it conflicts with `docs/17-review-findings.md` or `INVARIANTS.md`, those two files win — they contain the corrections from the independent adversarial review. Implement the corrected design, not the original where they differ.

# 25. Final self-review

This section is the document auditing itself. A design document of this length written in one pass will contradict itself; the useful question is whether the contradictions were found. Below: what was inconsistent and how it was resolved, what remains genuinely unresolved, and the consolidated list of decisions that need your answer rather than mine.

## 25.1 Contradictions found and fixed

| # | Where | The inconsistency | Resolution |
| --- | --- | --- | --- |
| 1 | Sections 2 and 12 | Section 2 initially described four process types; section 12 required a separate consumer for provider callbacks so that a webhook flood could not starve sending | Five process types are canonical: `api`, `track`, `ingest`, `worker`, `scheduler`. Section 2 corrected. |
| 2 | Sections 1 and 11 | Section 1 carried your original seven campaign states; section 11 needed six more to describe real transitions | Section 11 is canonical. Section 1 now points to it rather than restating a shorter list. |
| 3 | Sections 7 and 11 | The dunning ladder says scheduled campaigns are held rather than cancelled, but the campaign state machine had no state to hold them in | Added `held` as a first-class state with an explicit exit path back to `scheduled` on payment recovery. |
| 4 | Sections 8 and 10 | Failover re-dispatches a recipient to a second sender; the billable unit is a transition to `sent`, so a failover after a partial accept could meter twice | The `metered` boolean on `campaign_recipients` is flipped in the same transaction as the first `sent` transition and checked before any usage row is written. Failover cannot double-count because the second attempt finds the flag set. Section 10 now states this explicitly rather than leaving it implied by section 8. |
| 5 | Sections 0 and 14 | Section 0 demotes open tracking as unreliable under Apple Mail Privacy Protection; the analytics rollups originally presented open rate as the headline campaign metric | Click rate is the headline. Open rate is retained, labelled approximate in the API response and in the UI, and excluded from any automated decision such as engagement scoring thresholds. |
| 6 | Sections 15 and 16 | Section 15 requires 404 rather than 403 for cross-workspace access so that resource existence does not leak; the API error table listed 403 `forbidden` for that case | 404 `not_found` for cross-tenant. 403 is reserved for a member of the correct workspace lacking the permission. Section 16 corrected. |
| 7 | Sections 6 and 7 | The partial unique index `uq_sub_active_ws` allows one live subscription per workspace, but the upgrade flow described creating a new subscription and cancelling the old one | Upgrades modify the existing subscription item in place with proration. No second subscription row is ever created for the same workspace while one is live. |
| 8 | Sections 9 and 12 | The provider port exposes `sendBatch`, but the queue design gives each job a `jobId` of `send:{recipientId}`, which cannot address a batch | A batch job carries an array of recipient ids and a deterministic `jobId` derived from the sorted set. Idempotency remains at the recipient row, not the job: each recipient in the batch is guarded by its own state transition, so a partially applied batch replays safely. |
| 9 | Sections 18 and 21 | An early passage described running migrations at container start; section 18 later specified a one-off ECS task | The one-off task is canonical. Running migrations at boot means every scaled task races to migrate, and a rollback becomes ambiguous. Corrected. |
| 10 | Sections 14 and 24 | Section 14 described archiving old events; section 24 makes retention a plan-tier feature | Reconciled: retention is enforced by dropping partitions on a schedule driven by the workspace plan, and archived data is not restored on upgrade. See decision D5 below. |
| 11 | Sections 3 and 4 | Convention says UUIDv7 primary keys everywhere; `email_events` and `automation_events` use `BIGSERIAL` | Not a contradiction but an undocumented exception, now stated: append-only high-volume event tables use `BIGSERIAL` because the index locality matters more than the global uniqueness, and they are never referenced across service boundaries. |
| 12 | Sections 5 and 17 | The billing section insists provider webhooks are the only source of truth; the frontend has a `/billing/success` page reached by redirect | Consistent, but it was implicit. Section 17 now states that the success page renders a pending state and polls our own API until the webhook-derived subscription row appears, with a timeout that shows a support path rather than a false success. |

## 25.2 A real defect found during review

Worth separating from the list above because it would have shipped and broken in production.

**Session-level advisory locks do not survive transaction-mode connection pooling.** Section 19 resolves the scheduler leader-election race with `pg_try_advisory_lock`, and section 24 makes PgBouncer in transaction mode mandatory at around a hundred thousand users. Under transaction pooling a session-scoped advisory lock is acquired on a backend that is immediately returned to the pool, so the lock is either lost or held by a connection that some other tenant's query now occupies. This is a genuinely nasty failure because it works perfectly in development and staging, where PgBouncer is absent.

Two corrections, both now in the design:

- The scheduler uses `pg_try_advisory_xact_lock` inside an explicit transaction that spans the leader tick, not the session-scoped variant. Transaction-scoped advisory locks release at commit and are safe under transaction pooling.
- The `scheduler` process connects directly to Postgres, bypassing PgBouncer entirely. It is a single task with a single connection; it gains nothing from pooling and it is the one place where session state matters.

The same audit was run over the other places session state is assumed. `SET LOCAL app.workspace_id` for RLS is transaction-scoped by construction and is therefore safe under transaction pooling — which is precisely why section 15 bans the bare `SET` form. Prepared statements are the other classic transaction-pooling hazard; the Drizzle configuration disables statement caching on the pooled connection path.

## 25.3 Tensions that remain unresolved, honestly

These are not contradictions to fix. They are places where the design accepts a cost and you should know it.

**SMTP is a second-class citizen and the document does not fully hide this.** Sections 9 and 13 give SMTP the same port interface as the API-based providers, but SMTP has no webhook channel. Delivery confirmation is best-effort, bounces arrive only if a return-path mailbox is monitored, and complaints mostly do not arrive at all. Every analytics number for an SMTP sender is therefore weaker than the same number for an SES sender, and the UI currently presents them identically. See decision D4.

**The entitlements projection can drift.** Section 8 makes `entitlements` a rebuildable materialised projection of subscriptions and plan features, which is the right call, but rebuildable is not the same as self-healing. Nothing in the design currently detects a drifted row; it is detected when a customer complains. A periodic reconciliation job comparing the projection against a recomputation is cheap and is not yet in the roadmap. Add it to phase 8.

**Analytics staying in Postgres is a bet with a known expiry.** Section 14 commits to Postgres to roughly five hundred million events. That is a real ceiling, and the migration away from it is a quarter of work that the roadmap does not budget for because it falls beyond the planning horizon. The bet is sound — adding ClickHouse on day one would be a clear mistake — but the expiry date is real and should be revisited annually rather than discovered.

**The permission matrix is finer-grained than the UI.** Section 15 defines `campaign:launch` separately from `campaign:write`, which is correct, but the frontend role editor in section 17 exposes four preset roles rather than individual permissions. Custom roles are not in the MVP, so the fine-grained matrix is currently machinery without a surface. This is deliberate — the matrix is what makes custom roles a later feature rather than a rewrite — but it is latent complexity carried before it pays.

**Cost figures in section 24 are unmeasured.** Stated there, repeated here because it matters: no number in the cost table came from a bill. They came from list prices and judgement.

## 25.4 Decisions required from you

Each of these was raised inline where it arose. They are collected here because none of them should be settled by me, and each one gets more expensive to reverse after the phase named in the last column.

| ID | Decision | My recommendation | Must be settled by |
| --- | --- | --- | --- |
| D1 | Merchant of record. Section 5 recommends Stripe direct with Stripe Tax over Paddle or Lemon Squeezy, on the grounds that MoR providers treat bulk-email tooling as an elevated-risk category and can deplatform you with little recourse. If your go-to-market is mostly small international self-serve customers rather than UAE and India business accounts, the compliance burden you avoid with an MoR may outweigh roughly two points of fee and the category risk. | Stripe direct. Revisit only if self-serve international becomes the dominant channel. | Phase 8 start |
| D2 | Partition `campaign_recipients` by hash of `campaign_id` on day one, or wait until roughly a hundred million rows. Partitioning later is an online migration on your largest and hottest table. Partitioning now costs query-planning complexity and thirty-two partitions to maintain from the first campaign. | Wait, but write the migration during phase 12 so it is ready rather than urgent. | Phase 6 schema freeze |
| D3 | Default behaviour when a worker crashes after the provider accepted a message but before the `sent` transition committed. The system cannot distinguish this from a crash before acceptance. Resending risks a duplicate email to a real person; not resending risks a silent miss. | Do not resend. Flag the recipient `delivery_uncertain` and surface the count in the campaign report. Make it configurable per workspace for customers who would rather duplicate than miss. | Phase 6 |
| D4 | SMTP bounce handling. Either require a VERP return-path with an IMAP mailbox we poll for SMTP senders above some volume threshold, or label SMTP explicitly as best-effort with degraded reporting and no automatic suppression on bounce. | Label it best-effort for MVP with a clear UI warning; build VERP polling in the SHOULD tier once you know how many customers actually use raw SMTP at volume. | Phase 3 |
| D5 | Whether archived analytics events are restored when a workspace upgrades to a longer retention tier. Restoration means keeping the data you told the customer you dropped, which undermines both the cost control and the retention promise. | No. Retention applies forward from the upgrade. State it plainly in the pricing page rather than in the terms of service. | Phase 8 |
| D6 | Google Workspace as a provider. Section 3 deprioritises it: roughly two thousand recipients per day, and a restricted-scope Google security assessment that costs real money and weeks of calendar time. | Do not build it for MVP. Revisit only against named customer demand. | Phase 3 |
| D7 | Free tier. The document assumes paid plans throughout and never settles whether a free tier exists. This is not merely pricing — a free tier is the single largest anti-abuse exposure in the product, because it gives an attacker a sending surface at zero cost. | If there is a free tier, cap it hard at a few hundred sends per month, require a verified sender identity, and exclude it from pool routing entirely. | Phase 8 |

D7 was not in any earlier section. It surfaced during this review, which is the point of doing one.


---

# 26. If I were the lead engineer

You asked for an independent opinion rather than a summary of yours. Here it is, stated as decisions rather than options.

## 26.1 The architecture I would actually build

One TypeScript monorepo. Five deployable entrypoints from one image: `api`, `track`, `ingest`, `worker`, `scheduler`. PostgreSQL as the only durable store, with Drizzle rather than Prisma because this product needs partitioning, `COPY`, `SELECT ... FOR UPDATE SKIP LOCKED`, advisory locks and partial unique indexes on day one, and every one of those is a fight with Prisma. Redis for BullMQ and for rate-limit token buckets, on separate instances once volume justifies it. ECS Fargate on ARM64. Stripe direct, not a merchant of record. React with Vite, TanStack Query as the only server-state mechanism, and no Redux.

The four structural commitments that everything else rests on:

**`campaign_recipients` is a durable per-recipient state machine, not a join table.** This single decision buys pause, resume, cancel, retry-failed, exactly-once metering, per-recipient debugging, and failover correctness. It costs a row per recipient per campaign and eventual partitioning. It is the best trade in the document.

**Tenant scope is a type, not a convention.** Every repository method takes a branded `WorkspaceScope` as its first parameter, enforced by a custom lint rule and a CI reflection test, with Postgres RLS as the backstop. The reason to do this in week three rather than month eight is that it is a two-day job now and an eighty-endpoint audit later. It also happens to be what makes workspace-level sharding possible at the far end of section 24.

**Locks are the last resort, not the first.** Eleven of the eighteen races in section 19 are resolved by a unique constraint or a guarded conditional update, three by `FOR UPDATE SKIP LOCKED`, one by a transaction-scoped advisory lock. Zero by a Redis distributed lock. Redlock is where correctness goes to become probabilistic, and a database that already offers real locks makes it unnecessary.

**Webhook handlers converge rather than apply.** Persist to an inbox table with a unique provider event id, return 200 fast, then have a worker re-fetch the object from the provider and reconcile against a stored state version. Out-of-order delivery, duplicate delivery and missed delivery all collapse into the same handled case. This is the difference between billing that mostly works and billing you can sleep through.

## 26.2 What I would not build

Microservices. Kubernetes. A service mesh. Event sourcing. CQRS. GraphQL. ClickHouse. A drag-and-drop email builder. A general-purpose segment query language. Automations. Adaptive routing. Multi-region. A custom job queue. An in-house feature-flag system. Redis distributed locks. Any abstraction layer over Stripe intended to make a second payment provider easy — you will not add one, and if you do, the abstraction you guessed will be wrong.

Most of these are not bad ideas. They are ideas whose cost lands now and whose benefit lands at a scale you have not reached and may not reach.

## 26.3 What I would build first, in order

Week one is not the campaign wizard. It is a single vertical slice: one user, one workspace, one SES connection, one sender, one hardcoded HTML body, one contact, one send, one delivery event ingested, one row in `email_events`. No UI beyond what is needed to trigger it. That slice touches auth, scope, credentials, the provider port, the queue, the state machine and ingestion, and it will expose more design error in five days than another month of documentation would.

Then widen it: many contacts, then import, then templates, then the wizard, then pools, then pause and cancel, then billing. Depth first, then breadth. The opposite order — building a beautiful campaign wizard against a send path that does not exist — is the most common way this specific product fails.

## 26.4 What I would postpone without guilt

Mailgun and Brevo adapters until a customer names them. Google Workspace probably forever. The public API until after billing. Weighted routing. Custom roles. Device analytics. A/B testing. Multi-currency. Annual plans. Anything with the word *optimisation* in it. Each of these is real value; none of them is the difference between a product that works and one that does not.

## 26.5 Where I would spend disproportionate effort

Five places, and I would accept being slower elsewhere to fund them.

**The send path's exactly-once properties.** Every hour here saves a day of incident response and a conversation with a customer about why their list got mailed twice.

**The provider contract test suite.** Forty cases every adapter must pass, written before the second adapter exists. This is what keeps the abstraction honest and makes adding a provider a two-day job rather than a two-week one.

**The tenant-isolation test suite.** Six tests as a required CI check. The cost of the leak this prevents is the company.

**The billing test matrix.** Duplicated webhooks, reordered webhooks, failed payments, mid-period changes, downgrade blocks. Billing bugs are the only bugs that simultaneously lose money, lose trust and take weeks to detect.

**Anti-abuse, before launch rather than after.** Your entire delivery capability depends on relationships with providers and on domain reputation. Both are easier to protect than to repair, and a single spam campaign through an unverified free account can cost you an SES account.

## 26.6 Top 10 risks

Ordered by expected cost, not by likelihood.

| # | Risk | Why it is dangerous | Mitigation |
| --- | --- | --- | --- |
| 1 | Abuse through your platform damages provider relationships | Spammers actively seek out new bulk-email tools with weak controls. You can lose SES or SendGrid access for your own operational sending, and acquire a reputation that follows the domain. | The full launch-set anti-abuse ladder in section 15, live before signups open, not after |
| 2 | Duplicate sends to real recipients | Unrecoverable and highly visible. Customers forgive slow; they do not forgive mailing their list twice. | Recipient state machine, `jobId` idempotency, the section 19 matrix as executable tests, D3 settled deliberately |
| 3 | Cross-tenant data leak | Existential for a B2B tool holding customer contact lists. One incident ends enterprise sales. | Four isolation layers, CI-enforced, plus RLS backstop |
| 4 | Billing drift between Stripe and your database | Silently overcharging or undercharging, discovered by a customer. Reconciliation after months of drift is manual and awful. | Convergent webhook handlers, re-fetch and compare, plus the reconciliation job flagged in 25.3 |
| 5 | Phase 6 overruns and everything compresses | The largest phase; overrun eats the time budgeted for billing and security, which are the two phases nobody should compress. | Cut pool routing to single-sender sending before cutting anything in phases 8 or 11 |
| 6 | Provider API changes or rate-limit policy shifts | Outside your control and can break sending for a subset of customers overnight. | Adapter isolation, contract tests against sandboxes in CI, failover across pools |
| 7 | Postgres becomes the bottleneck earlier than expected | The scaling profile is unmeasured; the wall could arrive at a third of the assumed volume. | Phase 12 measures it properly; D2 keeps the partitioning migration ready |
| 8 | Deliverability blamed on you when it is the customer's list | Support burden and churn from a problem you did not cause and cannot fully fix. | Consent attestation, launch-time linting, honest reporting, and complaint-rate auto-pause that protects them from themselves |
| 9 | Scope creep into automations or a visual builder mid-build | Both are quarters of work that feel like weeks. | The MVP boundary in section 24, treated as a commitment rather than a suggestion |
| 10 | Key-person concentration | A four-person team with one person who understands the send path is one resignation from a stall. | Pair on phase 6, document the state machine transitions as tests rather than prose |

## 26.7 Top 10 architectural mistakes I would expect this project to make

These are predictions, offered so you can recognise them early.

1. **Treating the recipient row as expendable and computing state from events.** It feels cleaner. It makes pause, resume and metering nearly impossible to get right.
2. **Adding scope checks at the service layer instead of the repository layer.** Services get bypassed. Repositories do not.
3. **Reaching for a Redis lock the first time two workers race.** There is almost always a unique index or a guarded update that solves it deterministically.
4. **Trusting the provider's success response as the definition of sent.** It means accepted for delivery, and the gap between those two things is where duplicates and phantom sends live.
5. **Letting the frontend decide entitlements.** A plan check in React is a UI affordance, never an enforcement point. Every limit is enforced server-side or it is not enforced.
6. **Hardcoding plan logic.** You already flagged this and you are right to. The lint rule banning plan-code string literals outside the plans package is what actually prevents it.
7. **Building the provider abstraction against one provider.** It produces an interface shaped like SES with the word *Provider* in its name.
8. **Running migrations at container start.** Works with one task. Races with four, and makes rollback ambiguous.
9. **Unbounded queue retention.** BullMQ defaults will fill Redis, and Redis filling is an outage rather than a degradation.
10. **Adding indexes reactively during incidents.** Every index added under pressure is one nobody reviews, and they accumulate into write amplification that causes the next incident.

## 26.8 The honest bottom line

This is a well-scoped product built on a conventional stack, and conventional is the correct choice here — nothing in email campaign orchestration requires novel infrastructure. The hard parts are not the technologies; they are exactly-once semantics on the send path, tenant isolation, billing correctness and abuse prevention. All four are solvable with care and none of them is solvable by adding a tool.

The realistic risk is not that you build the wrong architecture. It is that phase 6 takes eleven weeks instead of seven, phases 8 and 11 get compressed to compensate, and you launch with billing that has not been adversarially tested and anti-abuse that is a to-do list. If you protect anything in this plan, protect those two phases.

## 26.9 Approval gate

Per your instruction, no code has been written. This document is the deliverable for this stage.

Before implementation starts, I need three things from you:

1. **Approval of the architecture** as described in sections 2 through 18, or a list of what you want changed. The five expensive-to-reverse decisions from section 0 are the ones worth arguing about now: the billable-unit definition, `campaign_recipients` as a durable state machine, tenant isolation at the repository layer, day-one partitioning of event tables, and KMS-enveloped provider credentials.
2. **Answers to the seven decisions in section 25.4**, or at minimum to D1, D2, D3 and D7, which gate phases 3, 6 and 8. D4, D5 and D6 can be deferred a few weeks without cost.
3. **Confirmation of the phase order** in section 23, particularly the four departures from your original sequencing.

Once those are settled, I would start with phase 0 and phase 1 together, delivered as reviewable increments rather than one drop: repo scaffold and CI first, then the schema and migrations, then auth and workspaces, then the isolation test suite. Say the word and I will begin with the phase 0 scaffold.

---

# 27. Implementation decision log

Dated record of every point where implementation departed from this document or
from `INVARIANTS.md`, and why. Added as the phases run.

## 2026-09-17 — R36 broadened to cover `set_config(..., false)`

**Changed:** the R36 row in `INVARIANTS.md`.

R36 originally read "`SET LOCAL app.workspace_id` only; a bare `SET
app.workspace_id` never appears", with a grep over `packages/**` and `apps/**`
as its proving test.

Phase 0 implemented scope setting as `set_config('app.workspace_id', $1, true)`
rather than the literal `SET LOCAL` statement, because `SET LOCAL` is a utility
statement that accepts no bind parameters and the literal form would require
interpolating a workspace id into SQL text. The third argument `true` means
`is_local`, so the semantics are identical.

That creates a hole the original rule cannot see. `set_config('app.workspace_id',
x, false)` is exactly the banned session-scoped write, and a grep for `SET` will
never match it. Under PgBouncer transaction pooling either form outlives the
transaction and is inherited by whichever tenant borrows the connection next —
which is the cross-tenant read R36 exists to prevent.

R36 now names both forbidden forms and names `packages/db/src/scope.ts` as the
only file permitted to write the setting at all. The proving test enforces all
three claims and is itself tested against known-bad and known-good fixtures,
because a scanner that matches nothing is indistinguishable from one that works.

Approved by the owner before the change. The correction belongs in
`INVARIANTS.md` rather than only here, since `INVARIANTS.md` is the highest
authority in `CLAUDE.md` section 1 and a rule that is wrong there is wrong
everywhere.

---

*End of Technical Design Document v0.1. Sections 0 through 26 complete.*
