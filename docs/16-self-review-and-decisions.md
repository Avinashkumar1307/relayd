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

## 2026-09-17 — audit_logs partitioning, where docs/02 is silent

**Decided in the absence of guidance, in migration `0002_identity.sql`.**

`docs/02` declares `audit_logs ... PARTITION BY RANGE (occurred_at)` and then
defines no partitions. A range-partitioned table with no partitions rejects
every insert, so audit logging would fail on its first write. Something had to
be chosen.

Chosen: **monthly** partitions, seeded for 2026-09 through 2026-11, plus a
`DEFAULT` partition.

Monthly, because `docs/02` specifies weekly-to-daily only for `email_events`,
which is a per-recipient event stream; audit rows are per mutating action and
are orders of magnitude fewer.

The `DEFAULT` partition is the arguable half. With it, an audit write can never
fail a user's request because maintenance lapsed. Against it, rows that land in
`DEFAULT` block attaching the monthly partition covering the same range until
they are drained. Availability of the write path was judged more important than
tidiness of maintenance, since an audit row is written inside the same
transaction as the action it records.

Ongoing partition creation belongs to the `scheduler`, which does not exist
until Phase 5. The seeded partitions run out on **2026-12-01**. Until then the
`DEFAULT` partition absorbs everything, so nothing breaks, but the drain cost
grows.

Reversible without cost while the tables are empty. Revisit at Phase 5 when the
scheduler can create partitions ahead, as it will for `email_events` (R25).

## 2026-09-17 — drizzle-kit output moved out of migrations/

**Changed:** `packages/db/drizzle.config.ts`, and drizzle-kit 0.28 to 0.31.

`docs/01` describes the workflow as "drizzle-kit generate produces the SQL, a
human edits it, it is committed as an immutable numbered file". The config
pointed drizzle-kit's `out` at `packages/db/migrations/`, which is the
authoritative directory the runner reads.

That does not work. drizzle-kit writes files named like
`0000_great_imperial_guard.sql` and a `meta/` journal. The migration runner
rejected exactly that file for having no `-- ROLLBACK:` comment, and its
sequence numbering collides with the hand-written series. Generated output now
goes to `packages/db/drizzle-generated/`, which is git-ignored, and a human
copies from it into a numbered migration — which is what docs/01 describes.

drizzle-kit was also upgraded 0.28 to 0.31. 0.28 resolves modules as CommonJS
and cannot map the `.js` specifiers that `NodeNext` requires TypeScript sources
to write, so `pnpm db:generate` broke as soon as one schema file imported
another. Same tool, same locked ORM decision; a version bump only.

## 2026-09-17 — user_tokens table added, where docs/02 had no storage

**Added:** migration `0004_user_tokens.sql`.

`BUILD-PLAN` Phase 1 requires "verify email" and "password reset", and
`docs/03` lists `/auth/verify-email`, `/auth/forgot-password` and
`/auth/reset-password`. `docs/02` section 3 defines token storage for workspace
invitations and for session refresh, and for nothing else. The flows were
specified with no table to hold their tokens.

`user_tokens` fills that gap, shaped to match the invitation pattern docs/02
already uses: a sha256 of the emailed token, an expiry, and a `consumed_at`
that makes redemption single-use. Cross-tenant, like `users` and `sessions`,
because a password reset is performed by someone who cannot log in and has no
workspace in context — so it has no RLS policy and its repository lives in
`packages/db/repositories/global/`.

Single use is the part that matters: a reset link that still works after the
password changed is a second chance for whoever intercepted the email. A
successful reset also consumes every other outstanding reset for that user.

## 2026-09-17 — import tables renamed, and composite keys on the audience joins

**Changed:** `docs/02-database.md` section 3, in migration `0005_audience.sql`.

Two departures from `docs/02`, for different reasons.

**Naming.** `docs/02` defines `contact_imports`. `BUILD-PLAN.md` Phase 2 and
`docs/15-roadmap.md` both name `import_jobs` and `import_row_errors`, and
`BUILD-PLAN.md` outranks `docs/02` under `CLAUDE.md` section 1. Two documents
against one, and the higher authority is among the two. Implemented as
`import_jobs` with the columns `docs/02` specifies, plus `import_row_errors`
for the per-row failures Phase 2 requires. `error_report_s3_key` and
`error_summary` are kept, so the exported report still works; the table is
what lets the UI page failures without an object store, which also means local
development needs none.

**Composite foreign keys.** `docs/02` gives `contact_list_members` plain
foreign keys on `list_id` and `contact_id`. Each is satisfiable independently,
so a list belonging to workspace A and a contact belonging to workspace B
together produce a membership row that straddles two tenants — and RLS does
not catch it, because the row carries a single `workspace_id` and reads as
legitimate from both sides. The only thing standing between that and a
cross-tenant leak would be a service remembering to check.

`docs/06` section 15 lists exactly this as part 4 of the tenant-isolation
suite: "Cross-tenant FK test. Adding B's contact to A's list fails."
Referencing `(id, workspace_id)` makes it fail in the database. `contacts`,
`contact_lists`, `tags` and `import_jobs` each gained a `UNIQUE (id,
workspace_id)` to be referenceable that way — redundant against their primary
keys, and the price of making the wrong row unrepresentable.

The same shape will be wanted for every later join table that spans two
tenant-owned entities: campaign recipients, pool members, tracked links.

### 2026-09-17 — xlsx is read from a path, not a byte stream

`docs/06` section 12 requires a "streaming reader in a worker" for xlsx
uploads, and `BUILD-PLAN` Phase 2 item 4 says the consumer streams from S3.
The xlsx reader takes a filesystem path instead.

This is not a shortcut. An xlsx is a zip, and a zip's central directory — the
index naming every entry and its offset — is written at the *end* of the file.
A reader that only moves forwards cannot locate `xl/worksheets/sheet1.xml`
without first buffering the entire archive in memory, which is precisely what
the 512 MB cap exists to prevent. Every correct xlsx reader spools to disk
first.

The streaming requirement is met where it can be: the worksheet XML is parsed
incrementally with a SAX parser and rows are yielded as they are found, so
resident memory stays flat regardless of how many rows the sheet holds.
`spoolingSource` in `packages/audience/src/import/sources.ts` turns any
stream-only source into one that satisfies both halves of the port, streaming
to a temp file rather than collecting chunks.

Delimited files are unaffected and are still read as a pure byte stream, never
touching the disk.

### 2026-09-17 — the S3 import source is a port without an implementation

`BUILD-PLAN` Phase 2 item 4 says the consumer streams from S3. `ImportFileSource`
defines that contract and `localFileSource` implements it for development and
tests; the S3 adapter is not written.

This matches how `FileStorage` was already left in `apps/api` when the
presigned-upload item was taken: there is no bucket, no LocalStack and no
credentials on this machine, so an S3 adapter written now could not be run,
and an adapter nobody has run is not an implementation — it is a guess with an
import statement. The consumer is written entirely against the port, so the
adapter is a swap rather than a rewrite when the bucket exists in Phase 10.

### 2026-09-17 — the COPY-and-merge sink is unverified against a database

`packages/db/src/repositories/contact-import.ts` has never been executed. It is
the most database-specific code in the phase — a `COPY FROM STDIN` into a TEMP
staging table, then one upsert using `xmax = 0` to tell an insert from an
update — and none of it has met a real Postgres.

What is proven without one: the COPY text-format escaping, via a decoder
written to the documented rules and a round trip through it
(`packages/db/test/copy-escape.test.ts`). That is the part where a mistake is
silent — an unescaped tab does not error, it shifts every later column — so it
is the part worth proving early. The statements themselves are checked the
first time the runner meets the database.

### 2026-09-17 — @relayd/audience needs a browser entry point

The import and export helpers are shared between the API, the worker and the
web app deliberately: the column-mapping form must offer exactly the columns
the importer will find — same BOM handling, same quoting rules — and the
failed-row download must be neutralised by the same code that neutralises an
export. Reimplementing either in the web app is how the two drift apart.

The package root cannot be imported by a bundler, because it re-exports the
xlsx reader, which needs `node:fs`, `zlib` and a zip library. Vite does not
fail on these; it externalises them and ships stubs that throw when the code
runs, which is worse than a build error. `@relayd/audience/browser` exports
only the pure modules, and the root is unchanged for Node consumers.

### 2026-09-17 — the mapping step reads headers in the browser, except for xlsx

BUILD-PLAN Phase 2 item 6 requires a column-mapping step. For csv and tsv the
first 64 KB of the chosen file is parsed in the browser with the importer's own
parser, so the columns offered are the columns it will find.

An xlsx cannot be read there for the reason above, so the form asks for the
headings to be typed. The alternative — a second spreadsheet reader written
against browser APIs — is a large amount of security-sensitive code duplicated
for a form. A server-side header preview would be better and belongs with the
worker in Phase 5, when there is a queue to run it on.

### 2026-09-17 — POST /audience/imports/:id/mapping was missing

`importMappingSchema` existed in `packages/validation` from Phase 2 item 2 but
no route used it, so a created import had nowhere to send its column mapping
and `import_jobs.column_mapping` was never written. Added with item 6, which
is the first thing that needed it: the repository method is guarded on status
like every other transition, because re-mapping an import that is already
processing would change what it is doing halfway through the file.

### 2026-09-18 — what "mixed encodings" means, since no document says

`docs/15` requires the import corpus to cover "mixed encodings" and no
document says which. Two decisions, both made to fail loudly rather than
quietly:

**Byte-order marks are honoured; content is never sniffed.** UTF-16LE and
UTF-16BE are decoded correctly when marked, because Excel's "Unicode Text
(*.txt)" export is UTF-16LE with a mark and is a common way for a
non-technical user to produce a tab-separated file. Read as UTF-8 it arrives
with a NUL between every character: no error, just unusable contacts. UTF-32
is refused by name rather than mis-decoded. Guessing an encoding from content
is deliberately not done — that is how a file of English names reads correctly
and a file of Turkish ones does not.

**Bytes that are not valid UTF-8 are refused, not replaced.** A Windows-1252
file read as UTF-8 yields U+FFFD wherever an accented letter was, so "José"
imports as "Jos<?>" — a corrupted contact with no error attached, discovered
by the customer months later in a campaign. The parser now decodes with
`fatal: true` and returns a message naming the fix ("re-save as CSV UTF-8").
`onInvalidBytes: 'replace'` restores the old behaviour for a caller that wants
it; nothing sets it.

**Open question for the owner.** Windows-1252 and ISO-8859-1 files are common
in older CRM exports and carry no mark, so they are indistinguishable from
corrupt UTF-8. The options are to keep refusing them (current behaviour), or
to offer the user a "this file is Western European" choice on the mapping step
and decode accordingly. Automatic fallback is the one option not worth having:
it silently turns a genuinely corrupt UTF-8 file into plausible-looking
nonsense. Flagged rather than decided.

### 2026-09-18 — provider_webhook_events has no base table in any document

docs/02 and docs/17 both ALTER `provider_webhook_events` to add
`provider_connection_id`, `matched` and `dedupe_key`, and no document ever
creates it. Its columns in 0006 are derived from the ingest flow in docs/06
and the `NormalisedEmailEvent` shape there: the raw payload, the normalised
fields needed to match an event to a recipient, and the processing state.

Two choices inside that worth recording. `dedupe_key` is NOT NULL with no
default — an event that cannot be deduplicated is an event that will be
applied twice, so there is no sensible fallback and the adapter must produce
one (the provider's event id, or a hash of the payload). And the F4 amendments
are folded into the CREATE rather than applied as ALTERs, because adding a NOT
NULL column by ALTER to a table created three statements earlier is the same
thing written twice.

### 2026-09-18 — the secrets path in docs/07 is out of date

docs/07 §"Credential handling" gives
`relayd/{env}/workspace/{workspaceId}/provider/{providerId}`. INVARIANTS R21
and CLAUDE.md §11 both give `relayd/{env}/ws/{workspaceId}/conn/{connectionId}`.
INVARIANTS is the highest authority (CLAUDE.md §1), so 0006 and everything
after it use the `ws`/`conn` form. Noted here rather than edited into docs/07,
which carries a header saying INVARIANTS wins where they differ.

### 2026-09-18 — nothing checked the Drizzle schema against the migrations

The migrations are what runs; the Drizzle schema is what queries are built
from. When they drift, `tsc` is perfectly happy and the failure arrives at
runtime as `column "foo" does not exist`, from whichever query touches it
first — possibly months later.

`packages/db/test/schema-matches-migrations.test.ts` parses the committed SQL
and compares it with `getTableConfig` in both directions. It is weaker than
introspecting a live catalogue and available now, which introspection is not.
It found no existing drift across migrations 0001-0006.

### 2026-09-18 — the contract suite lives in @relayd/email-providers, not @relayd/testing

BUILD-PLAN Phase 3 item 11 calls it `packages/testing/contract.spec.ts` and
docs/07 puts it at `packages/email-providers/src/testing/contract.spec.ts`.
It is at the latter, exported as `runProviderContract` from
`@relayd/email-providers`.

Two reasons. The suite imports the port and `sendWithLimits`, so putting it in
`packages/testing` makes that package depend on `email-providers` purely to
host a file that belongs to it. And the root vitest config only collects
`{apps,packages}/*/test/**/*.test.ts`, so a `.spec.ts` inside `src/` would
never run — the suite is a function, and each adapter's own test file calls
it, which is also what makes the per-adapter skips (`scriptFailure` returning
false for a kind that provider cannot produce) readable.

The fake provider is exported alongside it, so packages downstream of the port
can drive it without a real provider.

### 2026-09-18 — SendGrid over fetch, not @sendgrid/mail

CLAUDE.md §7 forbids importing `@sendgrid/*` outside its adapter directory; it
does not require importing it at all. The adapter calls the v3 API with
`fetch`.

Three reasons. The SDK is a thin wrapper over one POST. It holds the API key in
module state, which fights the port's rule that adapters are stateless and
credentials arrive per call — with the SDK, two workspaces sending
concurrently would race over one global key. And an injected `fetch` makes the
whole adapter testable without a network, which is the difference between the
contract suite running here and not running at all.

### 2026-09-18 — redaction knows the credential, not just its shape

R22 says a known credential string must never appear in a serialised error.
The original implementation redacted by pattern — connection URLs,
Authorization headers, things shaped like an AWS or SendGrid key. Patterns are
guesses about shape, and the SendGrid contract test found the gap immediately:
a provider that echoes the key back inside its own prose ("Bad key <key>
rejected") defeats every pattern.

`redact` now takes the credential material actually in play, and every adapter
passes it via `secretsOf(credentials)`. The patterns remain as a second layer
for anything the caller did not know it was holding.

Secrets shorter than six characters are skipped: a two-character password
would match everywhere and redact the message into uselessness.

The classified branches never needed it — each writes its own message and
never quotes the provider, which is the reconstruction R22 actually asks for.
It matters for the unclassified fallback, which does quote the original
because an unclassifiable failure is otherwise undiagnosable.

### 2026-09-18 — edge imports @relayd/email-providers/webhooks, which CLAUDE.md §6.3 appears to forbid

**This one needs the owner's confirmation.** It is implemented, it is narrow,
and it is trivially reversible.

CLAUDE.md §6.3 says `edge` "depends on `packages/queue`, `packages/db`
(read-mostly) and `packages/utils` only", and the edge isolation test listed
`@relayd/email-providers` as forbidden. The reason is sound: `edge` is public,
unauthenticated and unpredictable in volume, and it must not inherit the
sending machinery's cold start or blast radius.

INVARIANTS R4 says the signature on an inbound provider event is verified with
that connection's own secret *at the ingest endpoint* — and the ingest
endpoint is in `edge`. That cannot be deferred to a worker: an endpoint that
enqueues before verifying accepts whatever anyone posts to it, and the queue
becomes the amplifier for exactly the attack F4 describes.

INVARIANTS outranks CLAUDE.md (CLAUDE.md §1), so R4 wins where they conflict.
But they need not conflict. `@relayd/email-providers/webhooks` is a subpath
containing only verification and parsing: everything reachable from it is
node:crypto and JSON. `apps/edge/test/isolation.test.ts` now allows that exact
specifier — never the package root — and a second test walks the subpath's
transitive imports and fails if any provider SDK becomes reachable from it. So
`edge` still does not carry the AWS SDK or nodemailer, which is what the rule
was protecting.

Both tests were negative-controlled: importing the root, adding an SDK import
to the subpath, and adding one transitively all fail.

**If the owner prefers the rule as written**, the alternative is a separate
package holding the two pure functions, at the cost of one more workspace
entry. Nothing else changes.

### 2026-09-18 — a test send is a job, not an API action

BUILD-PLAN Phase 3 item 8 lists "test-send" among the API endpoints. The API
cannot perform one.

docs/06 gives the API task role permission to *write* secrets and not to read
them; only the worker role reads, and that is the whole point — "a compromised
API container therefore cannot exfiltrate customer sending credentials"
(docs/07). So the API has no way to obtain the credential a test send would
need.

`POST /senders/:id/test` therefore validates everything it can — the sender
exists and is active, its connection is usable, its identity is still verified
— and enqueues. The consumer lands with the send path in Phase 6. Until the
queue is wired the endpoint answers 503 with a plain message rather than
pretending.

The alternative, asking the customer to re-enter credentials to test, defeats
the reason the split exists.

### 2026-09-18 — the ingest URL is returned exactly once

An endpoint token is a bearer credential for writing events into a workspace
(F4). `POST /providers` returns the full ingest URL; no other route returns it,
and `ProviderConnectionRow` does not carry it, so a list response cannot leak
one by a future field being added and not stripped.

Losing it means rotating the connection. That is the correct trade: a token
that can be re-read is a token that leaks through every logging, screenshot
and support path that ever touches a connection page.

### 2026-09-18 — rendering lives in @relayd/campaigns, and uses sanitize-html

CLAUDE.md §3 lists the packages, and there is no templates package. Rendering
is in `packages/campaigns/src/templates/`, which is the package that renders at
dispatch. Adding a package to the locked layout for three files would be a
larger deviation than placing them in the package that consumes them.

The sanitiser is `sanitize-html` rather than something hand-written. A
hand-written HTML sanitiser is a standing invitation to mutation XSS: the
attacks that work are the ones where the browser's parser disagrees with yours
about where a tag ends, and only a real tokeniser gets that right. The
allowlists, the style filtering and the `on*` guard are ours; the tokenising
is not.

### 2026-09-18 — published template versions are immutable in the database

BUILD-PLAN Phase 4 requires it and docs/02 has no notion of publishing at all,
so `template_versions` gains `published_at` and `published_by`. A row with
`published_at` NULL is a draft and may be edited freely; setting it is one-way.

Enforced by a BEFORE UPDATE trigger rather than by the service, in the same
shape as the write-once guard on `campaign_recipients.metered` (R14). A
campaign records the `template_version_id` it rendered, so editing a published
version would rewrite what a customer has already sent — the report would
describe content that never went out. That is not a rule to leave to a code
path remembering to check.

### 2026-09-18 — compiling and rendering are separate, and stay separate

Compiling sanitises and derives the text part, once, when a version is saved.
Rendering substitutes merge tags, once per recipient, against the compiled
output.

Merging them would sanitise 500,000 times per campaign, and worse: a template
sent today and the same template sent tomorrow could differ, because the
allowlist changed in between. What was compiled is what was reviewed and what
is sent.

### 2026-09-18 — the preview iframe is sandboxed rather than served from another host

docs/06 says previews "render in a sandboxed iframe on a separate origin,
never on the app origin, or a malicious template steals sessions."

The implementation uses `srcDoc` with `sandbox=""` — an empty sandbox
attribute, which omits both `allow-same-origin` and `allow-scripts`. That
gives the frame a unique opaque origin: it can reach neither our cookies nor
our DOM, which is the property the separate origin existed to provide, without
a second host to deploy and keep in step.

Omitting `allow-scripts` as well is not redundant. The sanitiser strips every
script it finds, and a template has no legitimate need for one; granting
`allow-scripts` together with `allow-same-origin` would let the frame remove
its own sandbox attribute, which is the documented way that combination fails.

If the owner wants the separate host anyway — for defence in depth, or because
a future preview needs scripting — the change is the `srcDoc` line and a
subdomain.

### 2026-09-18 — job_dead_letters has RLS; scheduled_jobs does not

`scheduled_jobs` is operator configuration — one row per recurring job for the
whole deployment, read by a scheduler that connects directly before any
workspace is known (R35). It has no `workspace_id` and no RLS, and is named in
the coverage test's allowlist alongside `users`, `sessions` and `user_tokens`.

`job_dead_letters` carries a nullable `workspace_id` and does have RLS, which
is the more useful default: a tenant-scoped query sees only that workspace's
failed jobs. A row whose `workspace_id` is null matches no tenant scope at all,
because `NULL = anything` is NULL — correct, since a job that failed before its
payload could be read belongs to nobody. The operator console reads the whole
table through the BYPASSRLS role, which is what makes it an operator console.

### 2026-09-18 — a failed schedule still advances its next run

The obvious implementation leaves `next_run_at` in the past when an enqueue
fails, so the schedule is retried on the next tick. That is wrong at the level
above: a permanently broken schedule would then be the only row every
subsequent tick sees, and it would starve every other schedule indefinitely.

`next_run_at` advances either way. The failure is recorded on the row —
`last_error` and `consecutive_failures` — so a schedule that keeps failing is
visible without reading logs, and a missed run is one missed run rather than a
stalled scheduler.

### 2026-09-18 — what an "operator" is, is undecided; the console denies by default

**This one needs the owner.** BUILD-PLAN Phase 5 item 4 requires an
"operator-scoped" replay endpoint and item 7 an internal operator console. No
document says what an operator is. There is no `is_operator` column, no staff
role in the docs/06 permission matrix, and no mention of one in docs/06 §15.

Rather than invent a role and put it in the permission matrix — which is
transcribed from docs/06 row by row and should stay that way — `isOperator` is
an injected port on the router, and its default denies everyone. Wired as it
stands, every operator route answers 404 to every caller.

404 rather than 403, deliberately: a 403 confirms the console exists to anyone
who probes for it, which is the same reasoning as answering 404 for another
workspace's resources (CLAUDE.md §11).

The three plausible answers, for the owner to pick: a column on `users`; an
allowlist of user ids in configuration; or a separate authentication path
entirely (a VPN-only route, or an admin app). The third is the strongest and
the most work. Until one is chosen, the console is inert rather than open.

### 2026-09-18 — campaign_recipients uses `state`, not `status`

BUILD-PLAN Phase 6 says `state` throughout, docs/17's amendment SQL says
`state`, and docs/02 says `status`. Two of three, and the one that outranks
docs/02 (CLAUDE.md §1). Likewise `provider_connection_id` rather than docs/02's
`provider_id`, which is also the clearer name — it references
`provider_connections`.

`campaigns.status` keeps its name but gains `held` and renames `running` to
`sending`, per BUILD-PLAN's extended state set. `held` is what a *scheduled*
campaign enters under dunning restrictions; a running campaign always
completes.

### 2026-09-18 — email_events and usage_records are partitioned from the start

docs/02 and docs/05 both partition them by range on `occurred_at`. Creating
the parents unpartitioned and converting later would mean rewriting a table
with hundreds of millions of rows, which is the one migration nobody wants to
run (F25).

Two partitions are created rather than one, so a deployment spanning a month
boundary does not meet a missing partition on its first night. The scheduler
creates subsequent ones seven days ahead with `lock_timeout` set.

RLS is declared on the partitioned *parents*. Postgres applies a parent's
policies to every partition, so a partition the scheduler creates later is
covered without anybody remembering to enable it — which is the only way that
stays true.

---

### 2026-09-18 - the send path stops on `campaign_not_sending` by deferring

docs/04 describes a paused campaign's in-flight recipients returning to the
queue, without saying which state they return to. The send worker commits
`deferred` rather than `failed`: the recipient goes back to `pending` with no
delay, so resuming the campaign re-dispatches it. Marking it failed would need
retry-failed to recover a campaign the customer merely paused, and retry-failed
is the operation that most tempts an implementation to reset `metered` (R14).

`pausing` is deliberately in the set of states that keep sending. It means
in-flight work finishes; stopping there would strand recipients mid-campaign
with no clean resume point. `paused` stops. The distinction is tested in
`packages/campaigns/test/send.test.ts`.

---

### 2026-09-18 - launch checks the plan limit against the snapshot, not an estimate

INVARIANTS R28 requires the entitlement row locked `FOR SHARE` inside the
launch transaction; it does not say when the limit is compared. Launch reads
the entitlement *before* the snapshot - taking the lock early is the whole
point - but compares against `snapshot.inserted` *after* it. An audience
estimated before the snapshot is not the audience that was taken: suppression
and deduplication both shrink it, and comparing the estimate would refuse
campaigns that fit.

Both orderings are negative-controlled: moving the entitlement read after the
snapshot fails, and so does comparing before it.

---

### 2026-09-18 - the dispatcher's in-flight count comes from counters, not the queue

docs/04's dispatch loop reads `sendQueue.countFor(campaignId)`. BullMQ has no
per-campaign count; getting one means scanning the queue, and the queue is
transport rather than the system of record. The dispatcher reads
`queued + sending` from `campaign_counters` instead - the single-row read F13
introduced for exactly this shape of question.

It also answers correctly in the case that matters. After a crash between the
claim and the enqueue, rows are `queued` in Postgres and in no queue at all; a
Redis-derived count would read them as finished and the dispatcher would
overshoot its window by however many were lost.

One thing the loop gains that docs/04 does not describe: a stall guard. A
campaign whose in-flight count never falls has stuck rows, and spinning for
the dispatch job's six-hour timeout holds a worker slot for nothing. After
`maxStallPolls` consecutive full-window polls it records `dispatch.stalled`
and exits, leaving the sweeper to clean up and the reconciler to re-dispatch.

---

### 2026-09-18 - the halt flag can only ever stop a campaign

docs/04 says a worker that cannot reach Redis falls back to the database
check. `dispatchCampaign` enforces that itself rather than trusting each port
to: `isHalted` throwing is caught and read as "not halted". The asymmetry is
deliberate and is the whole point - letting a Redis outage pause a customer's
campaign would make Redis the system of record for whether their campaign
runs, which is the thing the queue design exists to prevent.

---

### 2026-09-18 - `scheduled_jobs` was empty, so no reconciler could ever run

Migration 0008 created `scheduled_jobs` and nothing has written to it since.
The scheduler reads due rows from that table every sixty seconds and there
were none, so `recipient-sweeper` and `campaign-reconcile` were written,
given queue settings, and unreachable. Nothing failed: an empty table is
exactly what a system with no due work looks like.

Migration 0010 seeds the three schedules that exist today, `ON CONFLICT DO
NOTHING` so `db:migrate` stays idempotent and so an operator who disables a
schedule does not have it re-enabled by the next deploy.

`partition-maintenance` is deliberately not seeded: it has no queue in
`packages/queue/src/queues.ts`, and a schedule naming a queue that does not
exist throws on every tick. 0009 created two partitions ahead, which covers
the gap until Phase 7 adds the queue and its schedule in one change.

`packages/queue/test/schedules.test.ts` now reads the seeds out of the
migrations and checks them against `QUEUE_NAMES`, because the two halves of a
schedule are declared in different languages in different files and nothing
else connects them. Its first version was itself wrong - it asserted a
migration was idempotent by matching a regex that the migration's own header
comment satisfied. It strips comments before matching now.

---

### 2026-09-18 - the sweeper does recipients before campaigns

R3, R5 and R12 do not say what order a reconciliation pass should run in.
Recipients first: a `pausing` campaign stuck on one dead `sending` row exits
`pausing` on its own once that row becomes terminal, so sweeping first means
the campaign deadline fires only for campaigns that are genuinely stuck rather
than merely slow. Forcing first would leave a campaign that looks correctly
paused sitting on a recipient nobody ever looks at again.

The two recipient cutoffs are deliberately different - five minutes for
`queued`, ten for `sending`. A `queued` row with no job is certainly lost. A
`sending` row may be a slow SMTP connection that is at the provider right now,
and returning it to the queue would send the message twice.

---

### 2026-09-18 - ambiguity is a field on ProviderError, not a kind

R31 needs the send path to distinguish "the provider refused this" from "the
provider never answered". Those were not distinguishable: a connection reset
was classified `provider_unavailable`, which is retryable, and retrying it is
precisely the duplicate send F31 describes.

`ProviderError` gains an optional `ambiguous` flag, set only at the scrubbing
boundary where the original throw is still visible. It is a separate field
rather than a new `ErrorKind` because it answers a separate question. `kind`
is what went wrong and drives ERROR_POLICY; `ambiguous` is whether we know,
and it overrides retryability in the send path. A 429 and a connection reset
are both retryable kinds and only one of them may actually be retried.

The rule the flag encodes is simply: did the provider answer? Any HTTP status
is an answer and therefore definitive. A refused connection or a failed DNS
lookup proves there was no request to answer. Everything else is uncertain,
including throws we do not recognise - the asymmetry is deliberate, because a
wrongly uncertain recipient is a line in a report the customer can act on and
a wrongly retried one is a duplicate nobody can take back.

The known cost: a bug in our own adapter code that throws before the HTTP call
is indistinguishable from a lost response, and would mark recipients
`delivery_uncertain` rather than retrying them. That is the correct direction
to be wrong in, and `delivery_uncertain` is a counted, surfaced state rather
than a silent one.

---

### 2026-09-18 - the batch cap is ours, not the adapter's

`sendWithLimits` batched at `adapter.capabilities.maxBatchSize`. R31 caps at
100 and the two are different numbers answering different questions: the
adapter is describing its own request limit, and R31 is describing how many
recipients a single unanswered request may leave uncertain. The cap now binds
over whatever the adapter declares.

Three things came out of negative-controlling this:

A removed guard in `batchSizeFor` returning 0 made `sendWithLimits` loop
forever rather than fail - `index += 0`. The proving test hung instead of
failing, which is a worse proving test. The loop's step is now guarded a
second time, in a different file from the first, because an infinite loop in
the send path pegs a worker, holds its queue lock until expiry, and stalls a
campaign with no error anywhere.

A second list of "ambiguous" socket codes turned out to be entirely dead: the
fail-safe default already caught every entry, so deleting `ECONNRESET` from it
changed no behaviour. A list whose removal changes nothing is not a guard, it
is a comment that looks like one. There is now a single list - the codes that
prove pre-acceptance - and every entry in it is load-bearing.

`ECONNABORTED` was dropped from that list in the process. On a client socket it
can mean the connection was aborted after the write, which is not proof of
anything.

---

### 2026-09-18 - campaigns is not given a dependency on email-providers

`retry-failed` has to know which error codes are retryable, and ERROR_POLICY
already says. The obvious move is to import it - and `packages/campaigns` has
no dependency on `packages/email-providers`, deliberately: the engine is
expressed against ports and the worker is what wires them together. Adding the
edge for one lookup would trade that for a convenience.

So `manuallyRetryable` takes the policy as a parameter, and the test uses a
local copy of the `retryable` column. A copy is a drift risk, so the real
table is pinned at its own source instead: `errors.test.ts` now asserts the
exact set of retryable kinds. Flipping `content_rejected` to retryable fails
there, loudly, rather than silently disagreeing with a fixture in another
package. Both halves are negative-controlled.

The test-only alternative - a devDependency from campaigns to email-providers
- was rejected for the same reason: a dependency that exists only for tests
still appears in the graph, and the next person to read it will believe the
runtime edge is allowed.

---

### 2026-09-18 - Retry-After is honoured but still capped

docs/04 gives the automatic retry an exponential backoff from 2s capped at
5 minutes. It does not say what to do when the provider sends its own
`Retry-After`. The provider's value wins - it knows when its rate window
resets and we are guessing - but it is capped at the same 5 minutes.

An uncapped `Retry-After` is not honourable here even when the provider means
it. A row deferred for six hours is reclaimed by `recipient-sweeper` long
before it elapses, so honouring the request literally would produce a delayed
job for a recipient that has already been re-dispatched. Capping keeps the
retry inside the window the rest of the machinery agrees on.

---

### 2026-09-18 - the halt flag is raised before the state moves, and lowered after

docs/04 describes the `campaign:{id}:halt` Redis flag as an optimisation so a
pause is felt within a batch rather than within a page, and says Postgres is
the truth. It does not say in which order to write the two.

Stopping raises the flag first and moves the state second. Starting clears the
flag first and restarts the dispatcher second. Both orders close the same
window from opposite sides: the reverse would leave workers believing they may
send after Postgres has said they may not, or restart a dispatcher whose first
loop reads a halt flag that is no longer true and exits immediately.

A refused transition puts the flag back. Leaving it set after a rejected pause
stalls a campaign that is running perfectly well, until the flag's TTL
expires - an hour of nothing happening, with every state in Postgres saying it
should be sending.

---

### 2026-09-18 - a drained pause settles immediately rather than waiting for a tick

R12 gives every transient state a reconciler and a ten-minute deadline. That
is the safety net, not the normal path: pausing a campaign whose provider
calls have all returned should not sit in `pausing` for up to a minute waiting
for `campaign-reconcile`, because a pause that takes a minute to show is a
pause customers click twice.

`applyLifecycleAction` therefore checks the in-flight count once, and settles
`pausing -> paused` or `cancelling -> cancelled` on the spot when it is zero.
The settle is a guarded transition from exactly the state it just left, so
losing the race to the reconciler is a no-op rather than a campaign dragged
back out of `cancelled`.

---

### 2026-09-18 - docs/07 said `paused` for no healthy sender; it is `held`

docs/07 §10 ends by saying a campaign whose pool has no healthy sender moves
to `paused` with `pause_reason = 'no_healthy_sender'` and is resumed
automatically by a probe. docs/04 introduced `held` for exactly this case -
"billing restriction or no healthy sender, distinct from user-initiated
`paused`, and auto-resumable" - and BUILD-PLAN's Phase 6 item says the same.

`held` is right and docs/07 is the older wording. Auto-resuming a `paused`
campaign would auto-resume one a human deliberately stopped, which is the
single reason the two states are separate. docs/07 is corrected in this commit
with a dated note.

---

### 2026-09-18 - failover is allowed for provider faults and refused for quota

docs/07 says rate-limit rejections "cool down, never reroute", and separately
that failover exists for unhealthy senders. It does not give the rule as a
single list, so `mayFailOver` states it:

  provider_unavailable, auth_failed, invalid_sender  -> may fail over
  everything else                                    -> may not

The line is whether the problem is about the account's *capacity* or about the
account. A provider being down is not the customer's fault and another account
is the right answer. A quota being exhausted is precisely about how much that
account has sent, and moving the message to a sibling is the quota evasion
that keying buckets by `provider_connection_id` exists to prevent -
reintroduced one layer up, where it would be far harder to notice.

Two cases worth naming because they look like they should fail over and must
not. An ambiguous `timeout` may already have been accepted, so re-sending it
anywhere is the duplicate R31 exists to prevent. A per-message failure -
`invalid_recipient`, `content_rejected` - will fail identically on every
sender, and trying all of them multiplies the reputation damage by the size of
the pool.

---

### 2026-09-18 - the token kind is inside the MAC, and so is the key id

docs/06 gives the token payload as `16B message_token || 4B linkIndex || 1B
kind` with a 10-byte MAC and a key-id prefix. It does not say whether the key
id is covered by the MAC. It is, here, and both of those bytes being signed
matters for a specific reason.

If the kind were unsigned, every recipient would be holding a working
unsubscribe link for themselves inside their own tracking pixel URL - and a
prefetching mail client would fire it. If the key id were only a prefix,
flipping it would point the verifier at a different key without invalidating
anything it covers.

The kind check after verification is therefore unreachable by forgery, but it
is not dead: during a rolling deploy, new code can mint a kind an old instance
does not know, with a perfectly valid MAC. It must refuse cleanly rather than
read the byte as whatever sorts first. That is what the test covers.

---

### 2026-09-18 - the edge classifies bots from the request only

docs/06 lists seven bot and prefetch signals. Three of them need state the
edge does not have on the request path: how long after `sent_at` the open
arrived, whether the source IP is in a scanner range, and whether three links
were clicked within a second.

Those are applied by the event-ingest consumer, which has the recipient row in
front of it. The edge applies only what a single request can see - user agent,
method, Range header - because the request path must not touch Postgres. That
is what lets one small service absorb a scanner walking every link in a
mailshot, and it is the same reason the MAC is verified before anything else.

`isPrefetchByTiming` lives in the same module as the request-path rules
despite running later, so the two halves of one decision stay together.

---

### 2026-09-18 - the IP salt is hashed to a fixed length before the address

`hashIp` originally separated the salt from the address with a NUL byte. The
editor wrote that escape as a real NUL into the source file, which makes the
file binary to git - the third time that has happened in this build.

The separator is gone. The salt is reduced to a fixed 32 bytes first, which
settles the ambiguity it was there for: without it, ("ab", "cde") and
("abc", "de") hash identically. A fixed-length prefix does that without any
separator byte at all, which matters because IPv6 addresses contain most of
the punctuation one would reach for.

---

### 2026-09-18 - suppression follows the event, not the lattice

R16 makes delivery state monotonic so a reordered `delivered` cannot overwrite
a bounce. It does not say what happens to suppression when the lattice refuses
a transition, and the two are not the same question.

A hard bounce that arrives after a complaint loses the lattice race - rank 4
against rank 5 - but the address is still dead. Gating suppression on the
transition having succeeded would mean the contact stays mailable because two
pieces of bad news arrived in the wrong order.

So the lattice governs what the recipient row displays, and the event itself
governs whether we may mail that address again. Both are tested, and the
mutation that gates one on the other is caught.

---

### 2026-09-18 - the dedupe key is length-prefixed, not delimiter-joined

R32 gives the synthetic key as `sha256(connection_id || event_type ||
message_id || occurred_at)`, leaving the concatenation unspecified. Joining
with a separator needs a byte that appears in none of the fields, and a
message id or a clicked URL can contain anything. Joining without one lets two
different events produce the same key when one field's end runs into the
next's beginning - and for a delivery event that means a bounce silently
dropped as a duplicate.

Each field is therefore prefixed with its own length, which makes the encoding
unambiguous without reserving a byte. With today's field order and UUID
connection ids a collision is hard to construct, so this is insurance against
a field order or an id format that changes - and the test shows the exact pair
that would collide without it.

The first attempt used an ASCII unit separator written as an escape. The
editor turned it into a real control byte in the source file, the same failure
that has now happened three times in this build, so the encoding avoids
needing any separator at all.

---

### 2026-09-18 - the Idempotency-Key uses the column that already exists

F29 asks the launch endpoint to accept an `Idempotency-Key`. The obvious
implementation is a key table, and `campaigns.idempotency_key` with its unique
index `uq_campaign_idem` already exists for precisely this. A second table
would need its own expiry, its own cleanup job, and its own answer to what
happens when the two disagree about whether a campaign launched.

One guarded UPDATE decides which request is the launcher. The loser reads the
row and gets the winner's result. A *different* key on the same campaign is
not a replay - it is a second launch of an already-launched campaign - and it
falls through to the engine's ordinary refusal rather than being handed
somebody else's answer.

The engine's guarded transition (R29) remains the durable guard. The key only
decides what the loser is told, which is the difference between a retried HTTP
request seeing a success and seeing a 409 it cannot distinguish from a real
conflict.

---

### 2026-09-18 - pool health answers with the router's own predicates

A campaign that will not launch reports `no_healthy_sender` and the customer
has no way to see why. `GET /pools/:id/health` is that view, and it calls
`eligibleMembers` and `sharedConnections` from the routing engine rather than
reimplementing the filters - a health view that disagrees with the router is
worse than none.

One wrinkle: eligibility for a *particular* campaign also depends on that
campaign's From domain, which this view has no opinion about. It neutralises
that one filter by giving every member a sentinel domain and asking for it.
The first version instead passed an empty domain against an empty list, and
since `[].includes('')` is false it reported every member of a perfectly
healthy pool as ineligible.

The shared-account warning is also returned when a member is *added*, not only
on the health view. That is the moment a customer believes they have increased
their capacity, and it is the only moment they will read a warning saying they
have not.

---

### 2026-09-18 - the R13 grep needed a word boundary

The test forbidding aggregates over `campaign_recipients` in a request path
matched `previewAudienceCount(...)` - a count over *contacts*, which R13 says
nothing about and which the audience step genuinely needs.

Fixed with a word boundary. Worth recording because the failure mode of a
guard that cries wolf is not a false alarm: it is that whoever hits it next
weakens it, and the guard stops catching the thing it was written for.

---

### 2026-09-18 - the wizard's pre-flight is a convenience, not an authority

The review step runs the same checks `launchCampaign` runs. It is deliberately
not the guard: the audience can change between the review step rendering and
the author clicking send, so the server re-checks every one of them inside the
launch transaction. What the client copy buys is telling the author on the
step that can fix it, which the server's single error message cannot do.

Two consequences worth stating. Its `senderVerified` is allowed to be
`null` - unknown, rather than bad - because claiming a sender is unverified on
no evidence sends the author to fix something that is not broken. And its
warnings never block: some suppression in an audience is normal and healthy,
and refusing to send because any exists would make the product unusable within
a month of launch.

Every step stays reachable at all times. A wizard that locks step five until
steps one to four are perfect is a wizard people fight - authors jump to the
content step first and fill in the name later, which is a reasonable way to
work. The nav marks which steps still have a blocking problem instead.

---

### 2026-09-18 - the Idempotency-Key is minted once per review step

F29's browser half. The key is created when the review step mounts, not when
the send button is clicked - a key minted inside the click handler is a new
key on every attempt, which is exactly the same as having none. A double click
or a retry after a flaky connection then sends the same key and receives the
first request's result rather than a 409 it cannot tell from a real conflict.

`crypto.randomUUID` rather than a counter: a guessable key lets one
workspace's retry collide with another workspace's first attempt.

---

### 2026-09-18 - the report does not crash on a field it did not get

`Stat` renders an em dash for a missing number rather than calling
`toLocaleString` on `undefined`. This screen is what a customer watches while
a campaign sends, and one absent field in one polled response should cost them
one number rather than the page.

Found because a test stub matched `/campaigns/c1` before
`/campaigns/c1/progress` and served the wrong object - a stub bug that looked
exactly like a component bug, and which turned out to be worth fixing on both
sides.

---

### 2026-09-18 - the hourly window is 26 hours, not 24

R24 says the hourly rollup recomputes over a bounded window. It does not say
how wide, and the obvious answer - one day - is wrong by exactly the amount
that matters.

A window equal to the interval between runs has no overlap, so an event that
arrives while a pass is running falls between two windows and is never
counted. Two hours of overlap also absorbs a run that started late, clock skew
between the application and the database, and a provider that batches its
callbacks. All three happen, and none of them should silently lose a bounce.

Overlap costs nothing because the pass overwrites rather than accumulates,
which is the same property that lets it repair the incremental pass's drift.

---

### 2026-09-18 - the incremental pass is also a recompute

The 30-second pass recomputes each dirty campaign from scratch rather than
applying a delta. A delta would need a watermark of its own, and a watermark
is precisely the thing R24 keeps out of this pipeline - the hourly pass exists
because a watermark plus a lost Redis set is a permanent gap.

The difference between the two passes is therefore not incremental-versus-full
but *which campaigns* and *which tables*: the 30-second pass does only the
dirty campaigns and only `campaign_stats`, because nothing in the UI needs the
daily, device or link tables to move during a send, and recomputing them every
30 seconds would be most of the cost for none of the benefit.

---

### 2026-09-18 - a rate with no denominator is null, not zero

A campaign that has delivered nothing has no click rate. Reporting 0% says it
performed badly; reporting null says it has not been measured, which is the
truth and which every chart renders differently.

Found a related defect while testing it: `Math.max(0, Math.trunc(NaN))` is
`NaN`, so a non-finite count divided into a `NaN` rate, which renders as
"NaN%" and serialises into JSON as `null` - reaching the customer looking like
a missing value rather than like the bad input it was. Counts are now coerced
through a helper that returns 0 for anything non-finite.

---

### 2026-09-18 - partition maintenance creates and never drops

R25 asks for partitions created seven days ahead. docs/08 separately describes
archival: dump a partition to S3, detach, drop.

Those are one job in the document and two here. Dropping a partition is
destructive and irreversible, and a job that both creates and drops is one bug
away from dropping what it meant to create - on the highest-volume table in
the system, where the mistake is unrecoverable. The maintenance job has no
drop path at all, and a test asserts the module exports nothing matching
drop, detach, delete or prune. Archival stays operator-initiated.

The job also reports rather than throws. A scheduled job that crashes is
retried blindly, and this one has nothing to gain from an immediate retry: a
lock timeout means something long-running is holding the parent, and the
seven-day lead exists precisely so tomorrow is soon enough.

`partitionsAreHealthy` is separate from the job that fixes things, because a
maintenance job that has silently failed for six days looks exactly like one
with nothing to do.

---

### 2026-09-18 - a merged migration's comment is still immutable

While adding 0012 I edited a stale comment in 0010 - it said partition
maintenance would land "in Phase 7", which it now had. Reverted.

`runMigrations` checksums each file and fails loudly when a merged one
changes (CLAUDE.md section 8). The checksum covers the whole file, comments
included, so editing a comment in an applied migration breaks `db:migrate` on
every database that has already run it. No database has run 0010 yet, so
nothing would have broken today - which is exactly the reasoning that makes a
rule like this erode. The correction lives in 0012's header instead.

---

### 2026-09-19 - the CSV export neutralises formulas

Nothing in the documents mentions it, and it is the one place in this product
where a contact's own text reaches a spreadsheet as potentially executable
content. A field beginning `=`, `+`, `-` or `@` is a formula to Excel, Numbers
and Sheets alike, so a contact who names themselves `=cmd|' /c calc'!A1` has
handed script execution to whoever opens the export.

Prefixed with an apostrophe, which every spreadsheet reads as "this is text"
and which survives a round trip through all three. The export also sets
`X-Content-Type-Options: nosniff`, because without it a browser may decide a
CSV whose first cell looks like markup is HTML and render it from our origin.

The ordinary CSV rules are here too - quote a field containing a comma, a
quote or a newline; double the quotes inside it; CRLF line endings - because
those are what every hand-rolled CSV gets wrong and a library would be a
dependency for forty lines.

---

### 2026-09-19 - analytics ranges are capped at 400 days

docs/08 does not bound the range an analytics query may ask for. Unbounded is
fine against `campaign_daily_stats` today and is a table scan in three years,
and the endpoint that becomes slow is the dashboard everyone leaves open.

Four hundred days rather than 365: a customer comparing this year with last
needs a range slightly longer than a year, and refusing that by fifteen days
would be the kind of limit that generates support tickets rather than
protecting anything.

---

### 2026-09-19 - `botFiltered` is derived, not stored

Every rate carries how many events the bot filter removed. That number is the
difference between two columns already on `campaign_stats`, and storing it as
a third would give it a way to disagree with them - the two counts are written
by the same rollup pass, and a stored difference would be written by the same
pass and then drift on the next partial write.

It is floored at zero per term rather than on the sum. The two columns are
written by two passes and a brief moment where the non-bot count is higher is
not impossible; flooring the sum would let a large genuine open filter mask a
negative click one and still look plausible.

---

### 2026-09-19 - the open-rate caveat is text, not a tooltip

docs/06 requires the UI to surface that open rate is directional. A tooltip
satisfies that on paper and not in practice: a customer scanning a dashboard
does not hover, and a disclosure nobody opens is not a disclosure.

So the word "approximate" sits beside the label at all times, and the footnote
under the number is rendered text. The bot-filtered count takes that slot
whenever there is one, because it is the specific number that answers the
question this product will be asked most - "why is my open rate lower than on
my old tool".

The click rate carries `data-headline` rather than being identified by its CSS
class. A redesign should have to remove that deliberately rather than by
restyling, and a test asserts exactly one tile has it.

---

### 2026-09-19 - the privacy-proxy share is shown above 20%

The device table reports the unknown slice as its own row always, and adds a
sentence above the table when it exceeds a fifth of opens. Apple's Mail
Privacy Protection reports a generic client through a proxy, so a large
unknown share is normal - and a customer seeing 40% "unknown" with no
explanation reasonably concludes the tracking is broken.

Twenty per cent because below that it is noise and the sentence would appear
on almost every campaign, which is how a warning becomes wallpaper.

---

### 2026-09-19 - `past_due` still grants entitlements

docs/05's dunning ladder restricts a workspace at day 15, not at the first
failed charge. So `past_due` is in the set of statuses the entitlements
projection treats as live, and `unpaid` is not.

That is a product decision as much as a technical one. A customer whose card
expired this morning has not stopped being a customer, and cutting them off
the moment a charge fails is how a payment blip becomes a churn event. By the
time Stripe reports `unpaid` the retries are exhausted, and restriction is
the intent rather than an accident.

---

### 2026-09-19 - upgrade and downgrade are decided by rank, never by price

Plans carry an explicit `rank`. Comparing prices would be wrong the first
time a promotion runs - and an "upgrade" that is really a downgrade skips the
over-limit pre-check, which is what strands a workspace above limits it was
never warned about.

`enterprise` is `isPublic: false` for a related reason: a plan-change
endpoint that offered every plan in the catalogue would let anyone assign
themselves unlimited sending.

---

### 2026-09-19 - absent, unlimited and zero are three different things

`limitFor` returns `undefined` for a feature the plan never mentions, `null`
for unlimited, and a number otherwise. The projection writes no row at all for
`undefined`.

All three collapse into "no" at the gate, which is why the distinction is easy
to lose and worth keeping: a missing row is a plan that forgot to mention a
feature, and writing a zero row instead gives the same answer to the customer
while hiding the authoring mistake from us. Every plan in the catalogue
currently defines every feature, so the difference never arises in production
data - the tests use a deliberately sparse plan to reach it, because a
projection that collapsed them would otherwise pass everything.

---

### 2026-09-19 - a failed Stripe call marks the mapping row, never deletes it

R18 puts the local `billing_customers` row before the Stripe call. It does not
say what to do when the call then fails.

The row is marked `failed` and kept. Deleting it would throw away the one
piece of evidence that matters: we may already have created a Stripe customer
whose id we never received, and the deleted row is the only trace that we
tried. A retry reuses the row - `pending` and `failed` are finished the same
way - so the second attempt completes the mapping rather than creating a
second Stripe customer for the same workspace.

A failure of the *session* leaves the customer alone, because the customer is
reusable and tearing it down would make every retry create another one.

---

### 2026-09-19 - the webhook handler does exactly two writes

R17 says `billing-webhook` never re-fetches inline. Taken seriously that
means the handler branches on nothing: it inserts the inbox row, marks the
object dirty, and returns. No Stripe call, no entitlement rebuild, no
switch on the event type.

Everything downstream is the refetch consumer's, and the reason is a number:
500 events for 10 objects is 10 API calls if the handler coalesces and 500 if
it does not - made from inside 500 HTTP handlers that each owe a 200 within
200ms.

A duplicate delivery still answers 200. Anything else makes Stripe retry, and
retrying a duplicate forever is how a webhook endpoint ends up disabled by the
provider.

---

### 2026-09-19 - an equal state version is discarded, not re-applied

The mirror write is guarded on `provider_state_version` being *strictly*
greater. Re-applying identical state would rewrite `updated_at` on every
duplicate delivery, which turns that column from evidence into noise - and
`updated_at` is what an operator reads first when asking when a subscription
last really changed.

---

### 2026-09-19 - the usage aggregation reads a minute behind the clock

`docs/05-billing.md` describes the metering transaction and INVARIANTS R15
describes the watermark, and neither says how far forward the aggregation pass
may read. Read to the present and the watermark is unsound.

UUIDv7 is time-ordered, which is what makes `id > watermark` a cursor at all,
but the order it encodes is the order ids were *generated*, not the order rows
became *visible*. A transaction that generated its id at t=100 and commits at
t=105 is invisible to a reader at t=104 that has already consumed a row
generated at t=102. Advance the watermark past t=102 and the straggler is never
read again: a row sitting in `usage_records`, already billed, permanently
absent from `usage_aggregates.used`.

So `aggregateUsage` refuses to read rows whose `occurred_at` is newer than
`AGGREGATION_LAG_MS` (60 seconds). A transaction still open after a minute has
larger problems than its usage row, and `reconcileVerdict` - docs/05's first
reconciliation check, `used` against `COUNT(*)` - is the backstop for what the
lag does not cover.

The lag is only load-bearing for the catch-up path. The normal path increments
the counter inside the send transaction, where the ledger row and the
increment commit together and no window exists.

---

### 2026-09-19 - two writers into one counter, and how they avoid each other

`usage_aggregates.used` is advanced two ways, and the design has to keep them
from counting the same ledger row twice.

Inline, in the send transaction: the ledger insert is `ON CONFLICT DO NOTHING
RETURNING id`, the counter moves only when that returns a row, and the
watermark advances by `GREATEST(stored, new)` - forward only.

Catch-up, in `aggregateUsage`: reads at `id > watermark`, folds, and writes the
total and the new watermark in one `UPDATE` guarded by
`last_usage_record_id IS NOT DISTINCT FROM $expected`. The guard is what makes
a concurrent inline increment lose this batch rather than have it added on top
of a row already counted; `IS NOT DISTINCT FROM` rather than `=`, because the
expected value is null for a period nothing has been aggregated into yet and
`= NULL` is null rather than true.

Because the inline path only moves the watermark forward, a row it counted sits
below the watermark and the catch-up cannot see it. Because the catch-up
advances the watermark in the transaction that adds the total, a second run
reads an empty range. Which is R15: three runs, one set of totals.

---

### 2026-09-19 - a scheduled downgrade is named for what it is

`docs/05-billing.md` calls the scheduled-downgrade columns `pending_plan_id`
and `pending_effective_at`. Migration 0013 calls them `scheduled_plan_code`
and `scheduled_change_at`, and the code follows the migration.

Two reasons, and the first is not cosmetic: the column holds a plan *code*,
because `plans` is keyed by code and there is no plan id to point at, so
`pending_plan_id` would name a column after a key that does not exist.
The second is that `scheduled_` matches `scheduled_jobs` and reads as the
thing the scheduler acts on, which is exactly what it is.

The behaviour docs/05 describes is unchanged: a downgrade is stored rather
than applied, and the scheduler reconciles daily if the effective date has
passed and the provider has not applied it.

---

### 2026-09-19 - annual to monthly is a downgrade in commitment

docs/05's plan-change matrix covers monthly to annual on the same plan ("an
upgrade in commitment": immediate, prorated) and says nothing about the
reverse.

We make it wait for period end and issue no credit, which is the same rule as
any other downgrade and for the same reason: the customer has already paid for
the year, and applying the change now means quietly stopping honouring it.

---

### 2026-09-19 - there is no free plan to fall back to

`docs/05-billing.md` says a cancellation or a suspension "rebuilds
entitlements from the free plan", and the capability table describes what a
free-tier workspace may still do. Under D7 there is no free tier, so there is
nothing to fall back to.

Entitlements rebuild to *no rows*. The workspace keeps its data, keeps reading
it, keeps its provider connections and its analytics history, and cannot send.
`projectEntitlements` already draws that distinction deliberately: no rows is
"not entitled", which is recoverable by subscribing, and a row saying zero
would look like a plan.

If the owner later adds a free tier (D7 lists the terms), the projection gains
a default plan and nothing else in the ladder changes.

---

### 2026-09-19 - the billing matrix is twenty-four cases, not twelve

`BUILD-PLAN.md` asks `pnpm test:billing` to cover "the twelve critical cases
in `docs/12-testing.md`". docs/12's table is B1 to B24.

We follow docs/12. `packages/billing/test/matrix.billing.test.ts` covers the
cases that can be proved against the deterministic fake gateway docs/12 also
asks for, numbered so a failure names the row it broke, and it runs on every
`pnpm test` rather than only when a Stripe key is present.

Six cases are deferred to the Stripe-test-mode half, because a fake cannot
prove them and a fake that claimed to would be worse than nothing:

  B6 (invalid signature) belongs to the edge route and is proved there
  against a real verifier.
  B11 (expired card) is Stripe's decline code, not our branch.
  B18, B19 (refunds) and B20 (dispute) need Stripe objects we do not create.
  B24 (overage reported to the provider) needs a metered subscription item.

---

### 2026-09-19 - the dunning job selects on the stage, not only on the clock

Writing B10 found a real gap. A successful payment clears
`first_failed_at`, and `workspacesInDunning` originally selected rows with a
live clock — so the workspace dropped out of the job on exactly the tick that
was supposed to release its held campaigns, and they stayed held until
somebody noticed.

The query now returns a workspace with a live clock **or** a stage other than
`current`, and `firstFailedAt` on the port row is nullable to match. That is
what makes recovery observable rather than merely true.

---

### 2026-09-19 - API keys are sha256, not argon2id

`docs/06-security-and-tracking.md` said "Prefixed random 32 bytes, argon2id
hashed, prefix indexed for lookup, shown once". Corrected, with the owner's
agreement, to sha256 with the hash itself indexed for lookup.

`packages/utils/src/crypto/tokens.ts` already makes the argument for refresh,
invitation and reset tokens: 32 bytes of CSPRNG output is 256 bits of full
entropy, so there is nothing to brute-force and a KDF adds latency and
nothing else. An API key is the same kind of value, and unlike a password it
is verified on *every* request.

The cost mattered more here than elsewhere. argon2id at the documented
m=64MB, t=3, p=4 is roughly 100ms and 64MB per verification. docs/06 also
sets 1000 requests per minute per key, so a single busy key implies more than
one concurrent 64MB allocation continuously — and an unauthenticated caller
spraying invalid keys makes us pay the same cost, which is a denial of
service with no credential required.

Two consequences in the schema, both improvements:

  `uq_apikey_hash` becomes load-bearing. A salted hash can never collide, so
  under argon2id that unique index could never fire; unsalted, it is the
  lookup path and it catches a hash computed over a constant on the second
  key rather than after the fact.

  `ix_apikey_prefix` becomes a UI index rather than the authentication path,
  and the revocation check moves to the row — a revoked key is now *found*
  and refused as revoked, rather than not found at all, which is a better
  error for the integrator holding it.

Passwords remain argon2id. Nothing about that changes.

---

### 2026-09-19 - outbound_webhook_deliveries, and one row per event

`BUILD-PLAN.md` names `outbound_webhook_deliveries` in Phase 9; `docs/02`
defines `outbound_webhook_endpoints` and stops there. The table is designed
here.

One row per `(endpoint_id, event_id)`, enforced by a unique index, with
`attempt` counting the tries and the response columns holding the most recent
one. A delivery that succeeded on the fourth go reads as attempt 4 with a
200; one still failing reads as its last error.

Per-attempt rows were the alternative and would say more, at several times
the volume for a table nobody reads except when debugging. The unique index
is the stronger guarantee of the two: it is what makes a producer that emits
the same event twice send it once.

Partitioned monthly by `created_at`, like `email_events` and for the same
reason.

---

### 2026-09-19 - Idempotency-Key is honoured, not demanded

`docs/03-api.md` says the header is "required on all `POST` that create or
charge". `docs/17` amendment G, which supersedes it, says
`POST /campaigns/:id/launch` *accepts* one. We follow docs/17 and accept
rather than require, on create, launch, checkout and plan change.

The dashboard shares these routes. Requiring the header would make the web app
generate and send one on every create for no benefit it does not already have:
what prevents a duplicate launch is the guarded state transition in Postgres
(R29), not the key. The key makes a *retry* safe, which is what an integrator
on an unreliable connection needs and what a browser form post does not.

A route that must have one can still ask: the middleware takes `required`, and
it defaults to true. Only the shared routes pass false.

---

### 2026-09-19 - the request hash is taken over the validated body

The idempotency middleware is mounted *after* `validateBody`, which replaces
`req.body` with the parsed result. So the hash covers the fields the endpoint
actually reads.

Two requests that differ only in a field we ignore are the same request.
Hashing the raw body would answer `409 idempotency_key_reuse` to a client that
added a field for its own bookkeeping, which is a confusing refusal of a
correct retry.

The cost is that a body differing only outside the schema replays rather than
re-running. That is the intended reading: the endpoint did the same thing both
times.

---

### 2026-09-19 - where the outbound webhook code lives

`CLAUDE.md` section 3 fixes the package layout and describes
`packages/notifications/` as "Product email (verification, invites,
dunning)". Outbound webhooks are notifications to a different audience over a
different transport, and BUILD-PLAN Phase 9 names no package for them.

Split rather than given a new package, because the two halves belong in
different places:

  The signing primitive is in `packages/utils/src/crypto/webhook-signature.ts`,
  next to the other crypto. Both the delivery worker and any future inbound
  verifier need it, and `utils` is described as "crypto, dates, Result types".

  The delivery policy — backoff, health transitions, secret overlap, what to
  retry — is in `packages/notifications/src/webhooks/delivery.ts`. It is
  notification logic, and adding a package for four hundred lines would cost
  more than it explains.

The section 3 description of `notifications/` is now narrower than what it
holds. Read it as "product notifications", email and webhook.

---

### 2026-09-19 - the outbound signature scheme is Stripe's shape

`Relayd-Signature: t=<unix seconds>,v1=<hex hmac>`, signing
`<timestamp>.<body>`, five-minute tolerance.

Deliberately familiar rather than novel. An integrator who has written a
Stripe or a SendGrid verifier can write ours in five minutes, and the
properties that matter are the ones that scheme already gets right: the
timestamp is inside the MAC so it cannot be edited, the tolerance bounds
replay, and the parser tolerates unknown fields so a `v2=` can be added later
without breaking every existing consumer.

Rotation keeps the previous secret live for 24 hours. A rotation with no
overlap breaks every consumer at the instant it lands, which makes rotation
something nobody ever does.

### 2026-09-19 - `api` cannot read a workspace provider secret

F21 says to scope `GetSecretValue` by path. It does not say which of the four
task roles get the grant, so the Terraform picks: `worker` and `edge` read
`relayd/{env}/ws/*`, `api` does not, and `scheduler` reads nothing under `ws/`
at all. All four read `relayd/{env}/app/*`.

`api` is the only one of the four that takes arbitrary authenticated input on
a path that can reach a URL fetch, which makes it the SSRF surface F21 is
about. It needs to *write* a connection secret, and it does — the write grant
and the read grant are separate statements — but nothing in the dashboard API
needs to read one back. A provider call happens in `worker`; a webhook
signature check happens in `edge` against that connection's own secret.

So an RCE in `api` yields the ability to overwrite a customer's credential,
which is loud and recoverable, rather than to exfiltrate every customer's SES
keys, which is neither.

The lists are module variables (`workspace_secret_readers`,
`workspace_secret_writers`) rather than hardcoded, so adding `api` back is a
one-line change with a visible diff, and
`packages/testing/test/terraform-policy.isolation.test.ts` asserts `api` is
absent from the reader list — a negative control confirms that adding it fails
the suite.

### 2026-09-19 - Terraform is asserted as text, not as a plan

`packages/testing/test/terraform-policy.isolation.test.ts` reads the committed
`.tf` files and parses block structure by brace depth. It does not run
`terraform plan`, which R34's wording asks for.

A plan needs credentials and a state backend, which the unit suite has
neither of, and running one in CI would mean giving the test runner an AWS
role — a larger hole than the one the test closes. What the text form proves
is the thing F21 and F34 are actually about: a wildcard nobody meant to
commit. What it cannot see is a policy attached out of band or a console
change, and that belongs with a drift check against a real account, which is
on the Phase 10 gate.

Terraform is not installed on the development machine this was written on, so
`terraform validate` and `terraform fmt` have not been run against these
files. CI runs both from Phase 10 onward.

### 2026-09-19 - the alarms watch EMF, not the Prometheus endpoint

CLAUDE.md section 2 asks for a "Prometheus endpoint". docs/10 says
"Prometheus + Grafana only once someone owns it. Do not run a Prometheus
stack you have no one to maintain." Both are satisfied, and the resolution is
worth writing down because it is not obvious from either document.

The twelve alarms in docs/10 "Alerts that page" are CloudWatch alarms, and a
CloudWatch alarm can only watch a CloudWatch metric. Nothing scrapes
`/metrics`, by the second rule. So an alarm pointed at a Prometheus series
would sit in INSUFFICIENT_DATA forever — a grey square that reads as "quiet"
rather than "broken", on exactly the twelve things that are unrecoverable if
missed.

So there are two mechanisms, deliberately:

`packages/logger/src/emf.ts` emits CloudWatch Embedded Metric Format — a log
line of a particular shape, extracted into a metric by the log group the task
already writes to. No agent, no SDK, no push. This is what the alarms watch.

`packages/logger/src/metrics.ts` holds Prometheus series and renders them at
`/metrics` on `api` and `edge`. Nothing scrapes it. It is there for a `curl`
during an incident and for whoever eventually owns that stack.

The names in `CLOUDWATCH_METRICS` and the `metric_name` arguments in
`infra/terraform/modules/observability` must agree exactly, and no compiler
spans that boundary. `packages/testing/test/observability.test.ts` compares
them in both directions: an alarm on a metric nothing emits, and a metric no
alarm watches.

### 2026-09-19 - `/metrics` is kept off the internet by routing alone

The ALB forwards `/api/*` to api and `/o/* /c/* /u/* /ingest/*` to edge.
`/metrics` matches neither, so it 404s at the load balancer and is reachable
only inside the VPC.

That is the entire access control. It deserves stating because on `edge`
every route is unauthenticated by design, so there is no middleware that
would have caught the endpoint being reachable — the routing *is* the
boundary. `packages/testing/test/terraform-policy.isolation.test.ts` asserts
no listener rule's path pattern can reach it.

What it would give away: route names, queue names, error rates, and enough
timing to tell when a campaign is sending. Not credentials, but a decent map.

### 2026-09-19 - the queue boundary now carries `_trace`

docs/10 specifies "Propagated via `AsyncLocalStorage` in-process and via the
job payload's `_trace` field across the queue boundary." The second half did
not exist; `packages/queue` had no trace handling at all.

`packages/queue/src/trace.ts` adds it. This is the hop that matters: the send
itself happens in the worker, on the far side of the queue, which is
precisely the part a support ticket is asking about. Without it the chain
broke at the only interesting place while looking complete on either side.

`withoutTrace` exists because every consumer validates its payload with Zod,
and an unrecognised key under `.strict()` would reject the job — a job
failing validation because of the field added to make it traceable is a bad
trade.

This makes `packages/queue` depend on `packages/logger`, which is new. The
alternative was duplicating the `TraceContext` type, which would drift.

### 2026-09-19 - metrics and Sentry init live in `packages/logger`

CLAUDE.md section 3 describes `packages/logger` as "Pino, redaction,
AsyncLocalStorage trace context" and lists no observability package.

`metrics.ts`, `emf.ts` and `sentry-init.ts` went there rather than into a new
package. The name is now slightly narrow for what the package holds — it is
the observability primitives, not only the logger — but renaming it would
touch every import in the repository for no behavioural gain, and metrics and
Sentry tags both label from the trace context that already lives there.

`prom-client` and `@sentry/node` are its new dependencies. Neither is in the
locked-technology table, so neither is a substitution; both are named in
CLAUDE.md section 2 as the observability stack.

Express middleware is *not* in the package — it is duplicated in
`apps/api/src/middleware/metrics.ts` and `apps/edge/src/middleware/metrics.ts`,
matching what `request-id.ts` already does. The alternative would make the
worker and the scheduler, which serve no HTTP, depend on Express.

### 2026-09-19 - consent attestation is a table, not a field in `options`

docs/02 specifies `import_jobs.options.consentDeclaration` and says why it
matters: "This is what lets you defend a workspace when a provider or a
regulator asks, and it is what lets you suspend a workspace that lied."

docs/06 asks for more than that string can carry: "Every import records a
declared consent source; every launch re-confirms it. Stored, timestamped,
attributed to a user."

A string inside a jsonb blob has no timestamp of its own, no attribution, and
nothing stopping it being edited afterwards to say something else — which is
exactly what it would need to survive to be worth anything in the dispute it
exists for. So migration 0016 adds `consent_attestations`, append-only,
enforced by a trigger rather than by the repository having no update method.

`options.consentDeclaration` stays, because docs/02 also says it is copied
onto every contact the import creates. The two are not redundant: the
declaration is the sender's own words, which a regulator reads; the
attestation's `source` is a fixed vocabulary, which makes "how many
workspaces claim to be importing from a previous provider" a `GROUP BY`
rather than a reading exercise.

The launch side did not exist at all. The `consentAttested: z.literal(true)`
in `launchCampaignSchema` recorded nothing — it could not be shown to
anybody, which is the only reason the control exists.

### 2026-09-19 - the attestation is bound to an audience, and has no expiry

Two decisions inside the above that the documents do not settle.

**Bound to an audience.** The attestation stores a fingerprint of the
campaign's audience definition, and a launch is refused if it no longer
matches. Without it the claim is about a campaign, and a campaign is a row
whose audience can be edited: attest about a small hand-built list, swap in a
purchased one, launch.

**No expiry.** The obvious design gives an attestation a short TTL so that
"re-confirms at launch" means "ticked recently". It breaks scheduled
campaigns, which the scheduler launches with nobody present — any TTL short
enough to mean something fails every one of them, and one long enough not to
means nothing. The re-confirmation is structural instead: the launch request
carries the declaration, so a launch without a deliberate assertion cannot be
expressed.

Stated rather than hidden: the fingerprint pins the audience *definition*,
not its membership. A campaign scheduled against a list and launched a week
later mails whoever is in that list then. Catching that needs a membership
count pinned at attestation time and compared at snapshot, and it is not
built — the import-side attestation is what covers contacts that arrived in
between.

### 2026-09-19 - an API key cannot launch a campaign. **Owner decision needed.**

docs/06 says the attestation is "attributed to a user".
`apps/api/src/context.ts` already takes the position that an action taken
with a key is recorded as the key, "rather than as whoever happened to mint
it two months ago". Those two together mean a key has nobody to attribute a
consent declaration to, and an assertion attributed to somebody who was not
there is worth nothing in the dispute the record exists for.

So `POST /campaigns/:id/launch` now carries `refuseApiKey()`, alongside the
billing routes, and `campaign:launch` on a key reaches pause and resume but
not launch.

**This costs API-driven launches**, which is a normal thing for a customer's
system to want, and no document settles it. The alternatives, if the owner
wants them:

1. Attribute to the key's creating user, and store the key id alongside so
   the record is not misleading. Needs a column and a lookup.
2. Allow it and attribute to the key alone, relaxing docs/06's wording.
3. Leave it as built: API keys manage campaigns, a person sends them.

Built to (3) as the safe default, because it is the only one of the three
that cannot produce a record which says something untrue.

### 2026-09-19 - automation pauses, but never suspends

docs/06's ladder is "Warn, then require review before launch, then pause
sending, then suspend, then terminate with data export." It does not say
which rungs a job may climb on its own.

The nightly sweep may reach `paused` and no further. Suspension and
termination end a paying customer's business with us, they are the two the
customer cannot undo by fixing their list, and no metric is a good enough
reason to do either without a person looking - docs/06 puts the ops console
for reviewing flagged workspaces in the same paragraph, which is what those
two stages are for.

Pausing *is* automatic, because by the time a human looks the damage is
already spreading through a shared pool.

Three further decisions the document leaves open:

**Escalation skips rungs; release does not.** A workspace that jumps from
clean to 2% complaints goes straight to `paused` - the ladder describes the
sequence a workspace experiences, not a rate limit on how fast we may react.
Coming back is one rung at a time, so the first thing a workspace does after
a pause is a launch somebody looked at.

**A sample floor of 500 sends.** 0.3% of 100 sends is 0.3 complaints, so
without a floor a single complaint on a small campaign auto-pauses the
workspace. 500 is the point at which one complaint (0.2%) is still under the
pause threshold: no individual recipient's click can stop a workspace
sending.

**A ceiling of 50 escalations per run.** If the rate query broke and made
every workspace look like a spammer, an unbounded sweep would pause the
entire customer base in one night. Releases still apply past the ceiling,
because a run that stopped entirely would also strand every workspace that
had already cleaned up.

### 2026-09-19 - `packages/queue/global-jobs.ts` now exists

CLAUDE.md section 8 and finding F20 both name this file: the allowlist of job
types that may connect as `relayd_global` and bypass RLS. Two tests referred
to it. It had never been created, so in practice there was no allowlist -
which is the state F20 describes as reducing the four-layer isolation story
to one layer.

It is a list rather than a flag on each job definition on purpose: a boolean
is set by whoever is writing that job at the moment they are frustrated their
query returns nothing, where a list in its own file is a diff that says "this
job can now read every customer's data".

Three entries: `partition-maintenance`, `billing-reconcile` and the new
`enforcement-sweep`. The bar is that the job's *purpose* is cross-tenant, not
its convenience - a job that processes many workspaces one at a time should
open a scoped transaction per workspace instead.

### 2026-09-19 - the phishing lint scores, and only three signals block alone

docs/06 lists the signals to lint for but not what to do with them. The
answer here is a weighted score with a threshold, and the shape is
deliberately lopsided.

The thing that ruins a lint like this is false positives. Every legitimate
SaaS sends "verify your account" emails with a button reading "Reset your
password". If those are blocked, the first thing every customer learns is
which words to avoid, and the lint then catches nobody except the honest.

So one signal never blocks. Credential language on its own is a normal
transactional email; a lookalike domain on its own might be a typo. Blocking
needs signals that combine, or one that has no innocent reading at all -
there are three of those: an executable attachment, a link to a raw IP, and a
protected brand name in the From line of a campaign sending from an
unrelated domain.

Severity is derived from the weight rather than written alongside it. Set
independently the two drift, and a finding labelled `blocking` whose weight
is under the threshold reads as blocking everywhere it is displayed while
blocking nothing.

Campaigns that score below the threshold still show their findings and record
them against the campaign. That is where most of the value is: an honest
sender fixes a mismatched link, and a dishonest one learns we are looking.

### 2026-09-19 - link reputation fails open, unlike the rate limiter

CLAUDE.md section 9 says the rate limiter fails closed: Redis unreachable
means do not send. The reputation feed does the opposite, and the difference
is the direction of the harm.

An unchecked link is a risk we accept for one campaign. Every customer unable
to launch because a third party is having an incident is an outage we caused,
and it lasts as long as their incident does. The unchecked launch is recorded
on the campaign (`launch.reputation_unavailable`), so "was this campaign
checked" has an answer afterwards.

The lookup is also bounded at three seconds, because a launch transaction
holds a `FOR SHARE` on the entitlement row and a feed that hangs would hold
it for as long as it liked.

Only `malicious` blocks. `suspicious` is reported and allowed: feeds disagree
about what suspicious means, and a category that blocks on a maybe is one
that gets switched off within a month of launch - taking the useful category
with it.

### 2026-09-19 - the global block list stores hashes, not addresses

docs/06: "Addresses that complained in any workspace go on a global block
list applied everywhere." It does not say how to store them.

In plaintext this is a list of everyone who has ever complained, assembled
across every customer we have. It would be the most sensitive table in the
database and a standing temptation: it would let anybody with read access
test whether a given person is on it, which is a cross-tenant information
leak dressed as a safety feature.

Stored as a peppered SHA-256 of the normalised address, it answers the only
question we need - "is this one blocked" - and nothing else. The pepper is
what makes it worth anything: the space of real email addresses is small
enough to enumerate, so an unpeppered hash of a stolen table is brute-forced
in an afternoon.

The trade-off, stated plainly: an operator cannot read the table to see who
is on it, and a person exercising a deletion right has to be found by hashing
their address rather than by searching. Both are acceptable. Holding every
complainer's address in plaintext forever is not.

This is also the one table in the schema with no `workspace_id` and no RLS
policy, because a workspace column would defeat the entire feature. The
migration says so in a comment, and
`packages/testing/test/rls-coverage.isolation.test.ts` requires the exemption
to be written down rather than inferred from the absence of a policy.

### 2026-09-20 - the shell and shared components live in `packages/ui`, not `apps/web`

docs/09 "Directory structure" puts the shell in `apps/web/src/components/layout/`
(`AppShell, Sidebar, WorkspaceSwitcher, BillingBanner`) and the primitives in
`apps/web/src/components/ui/`. CLAUDE.md section 15, added with the design
handoff, says: "Build the shell and the components on the design-system sheet
once, as `packages/ui`, and reuse them on every page." CLAUDE.md outranks
docs/09, so `packages/ui` it is.

The package is presentational and router-agnostic - the shell takes a `Link`
component and `currentPath` rather than importing React Router - which is
what docs/09 meant by "presentational only" and is also what makes it
renderable in a test without a router.

Tokens are `packages/ui/src/tokens.css`, imported by `apps/web/src/index.css`.
The handoff said "the Tailwind config"; this repository is Tailwind v4, where
the config is CSS, so the import is the config. The sheet resets Tailwind's
default palette, type scale and radii to `initial` before declaring the
design's own, so a utility for a colour or size the design does not have
does not exist. That is "do not invent colours, type sizes, spacing or radii"
enforced by tooling rather than by review.

### 2026-09-20 - the design export commit type

The handoff asked for the message `design: complete UI reference for all
sections A-K (Claude Design export)`. commitlint (docs/13, enforced since
Phase 1) rejects `design` as a type, so it landed as `docs(design): ...` with
the wording kept. `design/**` is excluded from ESLint in the same commit:
`support.js` is a generated browser runtime and the frames are reference,
never code that ships.

### 2026-09-20 - the design export is rendered before it is read

The `.dc.html` files in `design/` are programs, not documents: `support.js`
generates most frames at load time from the data arrays at the foot of each
file, and every page frame imports the shell through `<dc-import>`, which
resolves only over HTTP. Reading the raw files shows a fraction of the design
and grepping them finds templates rather than values - the first pass at this
work measured a frame by reading its source and got the wrong numbers.

`scripts/design/render-frames.py` renders every file in a headless Chromium,
cuts the DOM into one self-contained HTML file per frame plus a screenshot,
and writes an index: 138 frames, plus the component sheet cut into its
fourteen sections. `scripts/design/shoot-app.py` screenshots the running app
with the same browser so a page and its frame can be compared directly.
Output goes to the git-ignored `.design-rendered/`. Both are standard-library
Python and run in Bash on Windows, WSL and Linux CI, per the owner's rule
about never assuming PowerShell. CLAUDE.md section 15 documents both.

### 2026-09-20 - apps/web is split by section, not by the docs/09 tree

docs/09 "Directory structure" has one `App.tsx` declaring every route. The UI
was built by twelve teams working at once, so `App.tsx` now composes one
exported JSX fragment per section (`authRoutes`, `campaignsRoutes`, ...),
each living beside the pages it routes to, and the preview backend is split
the same way (`demo/routes/<section>.ts`, `demo/data/<section>.ts`). Nothing
about the routes themselves changed. The reason is mechanical rather than
architectural: one file per section means no two teams ever edit the same
file, and a section can be reverted on its own.

Two contracts were created as stubs before the sections started, so that
everything compiled against a fixed shape: `auth/workspace-state.tsx`
(`useReadOnly()`, the K2 suspended-workspace rule) and
`components/onboarding-checklist.tsx` (the B6b checklist the dashboard also
renders).

### 2026-09-20 - routes in the design that the written docs do not list

The design covers pages docs/09's route map and docs/03's endpoint table do
not mention. They are built, against the preview backend, and each one's
missing endpoint is marked `// BACKEND PENDING: <method path>` at the call
site rather than invented:

| Route | Frame | Endpoint status |
|---|---|---|
| `/pricing` | A2 | no public plans endpoint; static marketing content |
| `/verify` | B3a-c | `POST /auth/verify-email` exists; **no resend endpoint** |
| `/invite/:token` | B5a, B5b | `POST /invitations/accept` exists; **no token preview** |
| `/workspaces/new` | B6a | **no `POST /workspaces`** (registration creates the first one) |
| `/get-started` | B6b | derived from existing endpoints; no endpoint of its own |
| `/audience/segments`, `/new` | D5a, D5b | endpoints exist, no UI existed |
| `/pools`, `/pools/:id` | H1a, H1b | endpoints exist, no UI existed |
| `/billing/payment-method` | I8 | portal redirect; no endpoint of its own |
| `/settings/team/permissions` | J2c | rendered from `packages/types` permissions |
| `/settings/profile` | J5 | **no sessions list or revoke endpoint** |
| `/settings/audit` | J6 | docs/03 lists `/audit-logs`; **not implemented** |
| `/settings/webhooks` and children | J4a-c | endpoints exist, UI was inside `/settings/api` |

The five in bold need backend work before those pages leave the preview.
That list is for the owner to schedule; no backend code was written for them.

---

*End of Technical Design Document v0.1. Sections 0 through 26 complete.*
