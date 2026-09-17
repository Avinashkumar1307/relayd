<!-- Independent adversarial review — supersedes the baseline design where they differ -->
# Adversarial Review — red-team pass on TDD v0.1

**Reviewer stance.** I did not write the document under review and I am not defending it. I traced execution flows against the design as specified and looked for the point at which each one produces a wrong outcome. Thirty-four findings follow. Four are Critical — meaning I would block a production launch on them. The design is sound in its bones; the failures are concentrated in the gap between *state machine* and *queue*, which is exactly where this class of system usually breaks.

The single structural criticism: **the design repeatedly treats a Redis-resident job as if it were durable state.** Idempotency, scheduling, rate limiting and analytics buffering all lean on Redis, and Redis in ElastiCache is not a durable store. Most of the Critical and High findings are instances of that one mistake.

---

## A, B, C — problems found, severity, and why they exist

| ID | Problem | Severity | Why it exists |
| --- | --- | --- | --- |
| F1 | `jobId` is not a durable idempotency key | Critical | BullMQ dedupes only while the job record lives in Redis; the design also mandates bounded `removeOnComplete`, so the key is deliberately evicted |
| F2 | Stalled-job recovery duplicates slow sends | Critical | Default lock duration is shorter than realistic SMTP timeouts; BullMQ re-queues a job whose worker is still running |
| F3 | Crash between claim commit and `queue.add` strands recipients | Critical | The claim and the enqueue are in two different systems with no transaction and no reconciler |
| F4 | Provider webhook events are not bound to the connection that produced them | Critical | One shared ingest URL per provider; event-to-recipient lookup keyed on provider message id alone |
| F5 | Crash after provider accept leaves the row in `sending` forever | High | `metered` and `sent` commit together *after* the provider call; nothing records that a call was attempted |
| F6 | One-click unsubscribe over GET is fired by security scanners | High | RFC 8058 POST semantics not enforced; scanners follow every URL in a message |
| F7 | Redis loss silently drops everything in `queued` | High | Queue is the only record of intent to send |
| F8 | Daily provider quota tracked in Redis | High | Token bucket conflates per-second rate with per-day quota; the latter must survive failover |
| F9 | Rate limiter fails open when Redis is unreachable | High | Not specified, and the default instinct in code review is to let traffic through |
| F10 | Tokens consumed at dispatch rather than at send | High | Dispatcher owns the window, worker owns the call; the limit applies to the call |
| F11 | Retry jobs bypass the token bucket | High | Retry path was written as a separate consumer |
| F12 | `pausing` and `cancelling` have no timeout | High | Exit condition is in-flight count reaching zero, which F5 can make unreachable |
| F13 | Campaign progress and completion computed by counting rows | High | No counter table; a 500k-row aggregate per poll per viewer |
| F14 | `retry-failed` may reset `metered` | High | Reuse-versus-recreate of recipient rows is unspecified |
| F15 | Usage rollup is not watermarked | High | `usage_aggregates` recomputed from `usage_records` with no high-water mark |
| F16 | Convergent re-fetch does not apply to email events | High | Delivery events have no fetchable object; the doc generalises a billing pattern to a domain where it cannot hold |
| F17 | Stripe re-fetch storm at period boundary | High | One API read per webhook, uncoalesced, against a 100 reads per second budget |
| F18 | `billing_customers` mapping created after the Stripe customer | High | Ordering leaves a window where a paid checkout maps to nothing |
| F19 | No reconciliation against Stripe | High | Webhook delivery is assumed eventually successful; Stripe gives up after roughly three days |
| F20 | Workers run BYPASSRLS across all tenants | High | Background jobs legitimately cross workspaces, so the backstop is disabled exactly where review is thinnest |
| F21 | Secrets Manager IAM likely scoped to a wildcard | High | One task role for all workers; no per-workspace resource scoping |
| F22 | Provider errors echoed to UI and Sentry | Medium | SMTP and SDK errors routinely embed the connection string or auth header |
| F23 | Scheduler uses BullMQ repeatable jobs | Medium | Repeatable definitions live in Redis; a flush stops all recurring work silently |
| F24 | Analytics dirty set in Redis with an incremental hourly job | Medium | If the hourly recompute is watermark-based rather than full, a Redis loss is a permanent gap |
| F25 | Monthly partitions too coarse at high volume | Medium | 10M events per day makes a 300M-row partition, which defeats the purpose |
| F26 | `contact_engagement` updated per event | Medium | Hot-row contention on frequently mailed contacts |
| F27 | HOT updates defeated on `campaign_recipients` | Medium | Index on `state`, which is the column that changes 3–4 times per row |
| F28 | Entitlement check outside the launch transaction | Medium | Check-then-act across two transactions |
| F29 | Concurrent launch of the same campaign | Medium | No guarded state transition on launch |
| F30 | Suppression checked only at snapshot time | Medium | Unsubscribes during a long campaign are not honoured |
| F31 | Batch send with ambiguous failure | Medium | Partial acceptance is indistinguishable from total failure on timeout |
| F32 | Providers without a stable event id | Medium | Dedupe key assumes every provider supplies one |
| F33 | `track` and `ingest` as separate services | Medium | Split by conceptual role rather than by operational characteristic |
| F34 | Several cost decisions taken before measurement | Low | Separate Redis instances, 32 partitions, Multi-AZ staging, NAT egress for all provider traffic |

---

## D — concrete fixes, with the traces that justify them

### F1. `jobId` is not a durable idempotency key — Critical

**Trace.** Dispatcher claims recipient R, marks it `queued`, calls `queue.add` with `jobId = send:R`. Worker sends, marks `sent`, job completes. `removeOnComplete: {count: 10000, age: 3600}` evicts the job record. Two hours later an operator runs retry-failed, or the sweeper from F3 fires, or a resume re-scans. `queue.add` with `jobId = send:R` now creates a brand-new job because nothing in Redis remembers the old one. Second email sent.

**Why it matters.** The document names `jobId` as the idempotency mechanism. It is a deduplication *optimisation* with a retention-bounded lifetime. The durable guarantee has to live in Postgres.

**Fix.** Idempotency is the guarded state transition, and it is re-applied inside the worker, not only in the dispatcher:

```sql
-- In the send worker, first statement, own transaction:
UPDATE campaign_recipients
   SET state = 'sending',
       attempt_count = attempt_count + 1,
       provider_attempt_started_at = now(),
       attempt_token = gen_random_uuid()
 WHERE id = $1
   AND state IN ('queued', 'retry_scheduled')
RETURNING attempt_token;
```

Zero rows returned means another worker has it, or it is already terminal. The job exits successfully without sending. `jobId` stays, purely to reduce wasted work.

### F2. Stalled-job recovery duplicates slow sends — Critical

**Trace.** SMTP connection to a customer's own server. BullMQ `lockDuration` defaults to 30 seconds. The SMTP dial plus TLS plus DATA takes 45 seconds, which is entirely normal for a loaded or distant relay. The worker's lock expires; BullMQ marks the job stalled and re-queues it; a second worker picks it up and dials the same relay. Both sends succeed. The recipient gets two emails, and F1's guard does not save you because the first worker has not yet committed `sent`.

**Fix.** Three parts, all required.

1. `lockDuration` set to 120 seconds on `email-send`, comfortably above every provider timeout.
2. A hard per-provider call timeout **below** `lockDuration` — 30 seconds for API providers, 60 for SMTP — so the call always returns before the lock can expire.
3. `maxStalledCount: 0` on `email-send`. A stalled send job is moved straight to failed and reconciled by the sweeper rather than blindly retried, because a stalled send is exactly the ambiguous case from F5.

### F3. Crash between claim and enqueue — Critical

**Trace.** Dispatcher runs `UPDATE ... SET state='queued'` for 500 recipients and commits. Before `queue.add` returns for the last 200, the ECS task receives SIGKILL — a deploy, an OOM, a spot reclaim. Those 200 rows are `queued` in Postgres and absent from Redis. Nothing scans for `queued`. They are never sent, the campaign never completes (F12), and no alarm fires.

**Fix.** A sweeper, running every 60 seconds, is the reconciler between Postgres intent and Redis reality:

```sql
UPDATE campaign_recipients
   SET state = 'pending', queued_at = NULL
 WHERE state = 'queued'
   AND queued_at < now() - interval '5 minutes'
   AND campaign_id IN (SELECT id FROM campaigns WHERE state IN ('sending','pausing'))
RETURNING id;
```

Returning them to `pending` lets the normal dispatcher re-claim them, and F1's guard makes a double-claim harmless. I considered a full transactional outbox and rejected it: the state machine already *is* the outbox, and a sweeper over an indexed partial predicate is a tenth of the machinery.

### F4. Provider webhooks are not bound to a connection — Critical

**Trace.** The design has one ingest endpoint per provider, for example `POST /ingest/sendgrid`. An event arrives with `sg_message_id = M`. The ingest worker looks up the recipient by provider message id and applies a bounce, which writes a suppression into whichever workspace owns M.

The attack: workspace A signs up, connects their own SendGrid account, and learns the message-id format. They post a crafted bounce or complaint event for a message id belonging to workspace B. If the endpoint verifies only that the payload is well-formed — or verifies a signature against a single global SendGrid webhook secret shared by all customers — workspace A can write suppressions into workspace B, and complaint events can trip B's 0.3 percent auto-pause and halt their campaigns.

This is a cross-tenant **write** through an unauthenticated public endpoint. It is the most serious finding in this review.

**Fix.** Two changes, both necessary.

1. **Per-connection endpoint URLs.** Each `provider_connection` gets an unguessable endpoint token: `POST /ingest/v1/sendgrid/{endpoint_token}`. The token resolves to exactly one connection and therefore one workspace. Signature verification uses that connection's own secret, not a global one.
2. **Scoped resolution.** The event-to-recipient lookup is scoped to the resolved connection:

```sql
SELECT cr.id FROM campaign_recipients cr
 WHERE cr.provider_message_id = $1
   AND cr.workspace_id = $2            -- from the endpoint token
   AND cr.provider_connection_id = $3; -- from the endpoint token
```

An event that resolves to nothing is stored in the inbox as unmatched and alarms if the unmatched rate rises. It never mutates anything.

### F5. Crash after provider accept — High

**Trace.** Worker calls SES, SES returns a message id, worker begins the commit transaction, task is killed. Row stays `sending`, `metered` false, no usage row, no `sent` timestamp. The email was delivered. Under the current design nothing ever touches this row again: the dispatcher only claims `pending`, and F3's sweeper only looks at `queued`. The campaign cannot complete (F12) and the customer is undercharged.

**Fix.** Record intent *before* the provider call — that is what `provider_attempt_started_at` in F1's guard is for — and reconcile stale attempts:

```sql
UPDATE campaign_recipients
   SET state = 'delivery_uncertain', terminal_at = now()
 WHERE state = 'sending'
   AND provider_attempt_started_at < now() - interval '10 minutes';
```

`delivery_uncertain` is terminal, is **not** metered, is reported to the customer as a distinct count, and is eligible for reconciliation if a later provider event arrives carrying the message id. This resolves decision D3 in the design document with a mechanism rather than a preference.

Additionally: set a deterministic `Message-ID` header of `{recipientId}.{attemptToken}@{sendingDomain}`. It costs nothing and makes duplicates detectable after the fact instead of invisible.

### F6. One-click unsubscribe fired by scanners — High

**Trace.** Message goes to a corporate recipient behind Microsoft Defender or Mimecast. The scanner detonates every URL in the message, including the `List-Unsubscribe` URL, within seconds of delivery. If that endpoint acts on GET, the contact is unsubscribed without ever seeing the email. At scale this silently destroys a customer's list and they will blame your platform, correctly.

The same scanner behaviour inflates click counts and can trip the complaint auto-pause.

**Fix.**

- `List-Unsubscribe-Post: List-Unsubscribe=One-Click` with the endpoint accepting **POST only**. A GET on the same URL renders a confirmation page and changes nothing. This is RFC 8058 and it exists precisely because of this failure.
- Bot-click heuristics on the tracking endpoints: a click arriving within 10 seconds of delivery, from a datacenter ASN, or with a known scanner user agent is recorded with `is_bot = true` and excluded from all rollups and from engagement scoring. Store it; do not count it.

### F7 through F11. Redis durability and provider limits — High

**F7** is fixed by F3's sweeper: Postgres holds intent, Redis holds work, and the sweeper reconciles. Worth stating explicitly that ElastiCache failover can lose recent writes even with AOF where AOF is available at all, so this is not a hypothetical.

**F8.** SES enforces both a per-second rate and a 24-hour quota. A Redis token bucket handles the first; the second must be durable, because after a Redis failover a fresh bucket will happily let you blow the daily quota and get the customer's account throttled. Move the daily counter to Postgres:

```sql
CREATE TABLE sender_daily_usage (
  sender_account_id UUID NOT NULL REFERENCES sender_accounts(id) ON DELETE CASCADE,
  workspace_id      UUID NOT NULL,
  usage_date        DATE NOT NULL,
  sent_count        BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (sender_account_id, usage_date)
);
```

Incremented in the same transaction as the `sent` transition. One extra row touch per send, on a tiny table, and it is correct across any infrastructure failure.

**F9.** The limiter fails **closed**. If Redis is unreachable the worker does not send; it throws a retryable error and the job backs off. Sending without a limiter is how you lose a customer's SES account, which is unrecoverable in a way that a delayed campaign is not.

**F10.** Tokens are consumed in the worker immediately before the provider call, never in the dispatcher. The dispatcher's 5,000-job window is a backlog bound, not a rate control. With consumption at dispatch, a queue backlog smears the intended rate across an arbitrary later period and bursts on drain.

**F11.** The retry consumer calls the same limiter helper. Enforced by putting the limiter inside the provider adapter call path rather than in the consumer, so there is exactly one place it can be forgotten.

### F12, F13. Stuck campaigns and progress counting — High

**F12 trace.** Campaign has one recipient stuck in `sending` from F5. User hits pause. Campaign moves to `pausing`, whose exit condition is in-flight count reaching zero. It never does. The campaign sits in `pausing` indefinitely; the UI offers no action because `pausing` is transient; the customer opens a ticket.

**Fix.** Every transient campaign state carries a deadline and a reconciler. `pausing` older than 10 minutes force-transitions to `paused`, leaving stale recipients for the F5 sweeper. Same for `cancelling`, `validating`, `queueing`. A transient state without a timeout is a bug in every system that has one.

**F13 trace.** `/campaigns/:id/progress` runs `SELECT state, count(*) FROM campaign_recipients WHERE campaign_id = $1 GROUP BY state`. Three team members watch a 500k-recipient campaign, polling every 5 seconds. That is a sequential scan over a partition every 1.7 seconds, competing with the dispatcher's own writes on the same table.

**Fix.** A counter row per campaign, updated in the same transaction as each state transition, with the aggregate query retained only as an admin reconciliation tool:

```sql
CREATE TABLE campaign_counters (
  campaign_id  UUID PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  total        INTEGER NOT NULL DEFAULT 0,
  pending      INTEGER NOT NULL DEFAULT 0,
  queued       INTEGER NOT NULL DEFAULT 0,
  sending      INTEGER NOT NULL DEFAULT 0,
  sent         INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  suppressed   INTEGER NOT NULL DEFAULT 0,
  uncertain    INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Campaign completion is then `pending + queued + sending = 0`, an index-free single-row read. The counter row is a hot row, but it is one row per campaign touched once per transition — far cheaper than the scan it replaces.

### F14, F15. Usage double-counting — High

**F14 trace.** A campaign has 10,000 failures from a provider outage. The customer clicks retry-failed. If the implementation resets those rows to `pending` and clears `metered` — which is the natural thing to write, because resetting state feels like it should reset everything — every successful retry writes a second usage row. The `usage_records` unique key `send:{recipientId}` catches it only if the key is exactly that and the insert is not an upsert that overwrites.

**Fix, stated as an invariant that belongs in a test:** `metered` is **write-once**. No code path ever sets it back to false. Retry-failed resets `state`, `attempt_count` and `last_error`, and never touches `metered`. Enforce with a trigger rather than discipline:

```sql
CREATE OR REPLACE FUNCTION guard_metered() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.metered = true AND NEW.metered = false THEN
    RAISE EXCEPTION 'metered is write-once (recipient %)', OLD.id;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
```

**F15 fix.** `usage_aggregates` carries a watermark so a re-run is idempotent:

```sql
ALTER TABLE usage_aggregates
  ADD COLUMN last_usage_record_id BIGINT NOT NULL DEFAULT 0;
-- aggregation reads WHERE id > last_usage_record_id, then advances it in the same tx
```

### F16, F17. Webhook ordering and re-fetch load — High

**F16 trace.** The design says out-of-order events are dissolved by re-fetching the object from the provider. That works for Stripe, where a subscription is a fetchable object with a current state. It does **not** work for email delivery events: there is no endpoint that returns the current delivery state of a message. So a `delivered` arriving after a `bounced` — routine, since SES publishes through SNS with no ordering guarantee — will overwrite a bounce with a delivery, and the contact is never suppressed. That is both a correctness failure and a compliance one.

**Fix.** A monotonic precedence lattice on the recipient's delivery state. Events carry a rank; a transition applies only if it strictly increases rank:

| Rank | State | Note |
| --- | --- | --- |
| 0 | queued |  |
| 1 | sent | provider accepted |
| 2 | delivered |  |
| 3 | soft\_bounced | may be superseded by a later delivery within the retry window |
| 4 | hard\_bounced | terminal, suppresses |
| 5 | complained | terminal, suppresses |

```sql
UPDATE campaign_recipients
   SET delivery_state = $2, delivery_rank = $3, updated_at = now()
 WHERE id = $1 AND delivery_rank < $3;
```

Engagement events (open, click) are additive and never participate in the lattice. Raw events are always written to `email_events` regardless of whether they advance the lattice, so analytics stays complete even when state does not move.

**F17 trace.** At the monthly billing boundary Stripe emits invoice and subscription events for every customer within a few minutes. At 5,000 customers that is roughly 15,000 events, each triggering a re-fetch, against a live-mode read budget of about 100 per second. You hit 429s, the inbox worker backs off, and reconciliation lags by hours on the exact day it matters most.

**Fix.** Coalesce. The inbox worker does not re-fetch; it marks the *object* dirty. A separate consumer re-fetches each distinct object at most once per 30-second window:

```sql
CREATE TABLE billing_refetch_queue (
  provider        TEXT NOT NULL,
  object_type     TEXT NOT NULL,
  provider_obj_id TEXT NOT NULL,
  dirty_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at      TIMESTAMPTZ,
  PRIMARY KEY (provider, object_type, provider_obj_id)
);
```

Fifty subscription events for one customer become one API call.

### F18, F19. Billing state divergence — High

**F18 trace.** Checkout flow creates a Stripe customer, then writes `billing_customers`. The write fails — pool exhaustion, a deploy, anything. The user completes payment. `checkout.session.completed` arrives with a Stripe customer id that maps to no workspace. The design explicitly forbids the webhook from creating the mapping, so the event is stored and never applied. The customer has paid and has no subscription.

**Fix.** Invert the order and carry our identity in the session. Write `billing_customers` with a locally generated id **first**, in `pending` status, then create the Stripe customer, then pass `client_reference_id = {workspaceId}` and `metadata.billing_customer_id` on the checkout session. The webhook resolves through metadata, so it never needs to create a mapping and never needs one to pre-exist by luck of ordering.

**F19 trace.** Your ingest endpoint returns 500 for four hours during an incident. Stripe retries with backoff for about three days, so those recover. But a deploy that breaks signature verification — a rotated endpoint secret not propagated — returns 400, which Stripe does not retry usefully, and the events are gone permanently. Nothing in the design ever notices.

**Fix.** A nightly reconciliation job that lists Stripe subscriptions modified in the last 48 hours and compares each against the local row, emitting a metric for every divergence and auto-correcting the ones that are unambiguous. This job is also what catches F18 and the entitlement drift the design already admits to. It is roughly 150 lines and it is the difference between knowing and hoping.

### F20, F21, F22. Isolation and credential exposure — High and Medium

**F20.** Workers connect with BYPASSRLS, so the four-layer isolation story reduces to one layer — application code — in the least-reviewed part of the system. Narrow it:

- Workers that operate on a single workspace's data (send, import, analytics for one campaign) connect as a normal RLS role and `SET LOCAL app.workspace_id` from the job payload. Most jobs are single-workspace, and this is a small change with large value.
- Only genuinely cross-tenant jobs (partition maintenance, global reconciliation) use BYPASSRLS, on a separate role, from a named list of job types, with every such job logged.

**F21.** One task role with `secretsmanager:GetSecretValue` on a wildcard means any RCE or SSRF in any worker yields every customer's SES keys. Scope by path: secrets stored at `relayd/{env}/ws/{workspaceId}/conn/{connectionId}`, with the policy granting access by resource prefix and a condition on a task tag where possible. Cache decrypted material in memory for no more than five minutes, never write it to disk, and emit an audit row on every fetch.

**F22.** Nodemailer errors embed the full connection URL including the password; several SDKs include the Authorization header in error objects. Sentry's default `beforeSend` will happily ship both. Fix: a scrubbing layer at the adapter boundary that reconstructs errors into the typed `ProviderError` and discards the original, plus a Sentry `beforeSend` denylist, plus a test asserting that a known credential string never appears in a serialised error.

### F23 through F27. Durability and Postgres shape — Medium

**F23.** BullMQ repeatable jobs live in Redis. A flush or a failover loses the definitions and every recurring job — rollups, sweepers, dunning, partition maintenance — stops without an error, because nothing failed; things simply stopped happening. The scheduler must drive from a Postgres table of schedules, computing due work each tick.

**F24.** If the hourly authoritative rollup is watermark-based, a lost Redis dirty set is a permanent gap. The hourly job must be a genuine recompute over a bounded time window from `email_events`, not an incremental pass. The Redis set is a latency optimisation only.

**F25.** At 10M events per day a monthly partition is 300M rows. Partition daily above roughly 1M events per day, weekly below that, and automate creation 7 days ahead with `lock_timeout` set so a failed attach never blocks the write path.

**F26.** `contact_engagement` updated on every event creates hot-row contention on the most-mailed contacts, which are exactly the rows you update most. Derive it from the hourly rollup instead. It is a reporting artefact; it does not need to be current to the second.

**F27.** `campaign_recipients` rows are updated three or four times each, and an index on `state` means none of those updates can be HOT, so every update writes new index entries and the table bloats fast. Fixes: `fillfactor = 80`; make the state index partial so terminal rows carry no index entry and their updates become HOT; per-table autovacuum tuned aggressively.

### F28 through F32. Races and gaps — Medium

**F28.** Launch checks entitlements, then snapshots, then commits. A downgrade committing in between lets a campaign launch over the new plan's limit. Read the entitlement row `FOR SHARE` inside the launch transaction so the downgrade blocks until launch commits.

**F29.** Double-clicking launch creates two snapshots. Guard: `UPDATE campaigns SET state='validating' WHERE id=$1 AND state IN ('draft','scheduled')` and abort on zero rows. Also accept an `Idempotency-Key` header on the launch endpoint.

**F30.** A 6-hour campaign mails someone who unsubscribed in hour two, because suppression was evaluated at snapshot. Re-check at send time — one indexed lookup on `suppressions` — and transition to `suppressed` rather than sending. This is cheap and it is a legal exposure, not a nicety.

**F31.** `sendBatch` of 500 times out after the provider accepted 400. Retrying resends 400 emails. Fix: cap batches at 100; on any ambiguous failure mark the whole batch `delivery_uncertain` rather than retrying; only retry batches that failed with a definitively pre-acceptance error such as a connection refusal.

**F32.** Providers without a stable event id get a synthetic key of `sha256(connection_id || event_type || message_id || occurred_at)`. This collapses genuinely identical simultaneous events, which for opens and clicks is an acceptable loss and for state events is correct behaviour.

### F33, F34. Structure and cost — Medium and Low

**F33.** `track` and `ingest` are separated by what they mean, not by how they behave. Both are public, high-volume, write-only-to-queue, latency-sensitive, and must not be starved by API traffic. That is one operational profile, so it is one service. Merging them removes an ALB target group, a service definition, a scaling policy, a deployment and a dashboard, and costs nothing. **Five services become four: `api`, `edge`, `worker`, `scheduler`.**

I considered merging `scheduler` into `worker` as a flagged task and decided against it: leader election plus a direct non-pooled Postgres connection is genuinely different, and one tiny task is cheaper than the confusion.

**F34.** Four premature costs: separate Redis instances for queue and rate limiting before any measurement (one instance with keyspace separation until proven); 32 hash partitions on `campaign_recipients` from day one (planning overhead on every query for years before the benefit); Multi-AZ RDS in staging (doubles the line for an environment that can be rebuilt); and all provider API egress through a NAT Gateway, where data processing charges scale directly with send volume and nothing in the design accounts for it.

---

## E — revised architecture

**Services: four, not five.** `api` (authenticated application and public API), `edge` (tracking pixel, click redirect, unsubscribe, provider webhook ingest — public, merged from `track` and `ingest`), `worker` (all queue consumers), `scheduler` (leader-elected ticker, direct Postgres connection, no PgBouncer).

**The durability rule, stated once and applied everywhere:** Postgres is the system of record for *intent* and *state*. Redis holds *work in progress* and *caches*. Every place where Redis holds the only copy of something gets a Postgres-backed reconciler. That single rule produces the sweeper, the durable daily quota, the Postgres-driven scheduler, the coalescing refetch table and the full hourly rollup.

**The send path, revised end to end:**

1. Dispatcher claims `pending` rows with `FOR UPDATE SKIP LOCKED`, marks `queued` with `queued_at`, commits, enqueues. Window bounded at 5,000.
2. Sweeper returns `queued` rows older than 5 minutes to `pending`.
3. Worker re-applies the guarded transition to `sending`, recording `provider_attempt_started_at`. Zero rows means someone else has it; exit cleanly.
4. Worker re-checks suppression and campaign state.
5. Worker consumes a rate token (fails closed) and checks the durable daily quota.
6. Worker calls the provider with a timeout below `lockDuration`, sending a deterministic `Message-ID`.
7. On success: one transaction writes `sent`, `metered = true`, the `usage_records` row, the `sender_daily_usage` increment and the `campaign_counters` update.
8. Rows stuck in `sending` past 10 minutes become `delivery_uncertain`, terminal and unmetered.
9. Inbound events arrive on per-connection endpoints, resolve within that connection's workspace, and advance the delivery state only by rank.

**Billing, revised:** local mapping written before the Stripe object; identity carried in session metadata; webhooks marked dirty rather than re-fetched inline; a coalescing re-fetch consumer; and a nightly reconciliation against Stripe that reports divergence as a metric.

**Isolation, revised:** single-workspace jobs run under RLS with `SET LOCAL`, not BYPASSRLS; BYPASSRLS is a named allowlist of cross-tenant job types; secrets are IAM-scoped by workspace path.

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

## G — API changes

| Change | Detail |
| --- | --- |
| Per-connection ingest | `POST /ingest/v1/{provider}/{endpointToken}` replaces one shared URL per provider; signature verified against that connection's own secret |
| One-click unsubscribe | `POST /u/{token}` acts; `GET /u/{token}` renders a confirmation page and never mutates. `List-Unsubscribe-Post` header added |
| Launch idempotency | `POST /campaigns/:id/launch` accepts `Idempotency-Key` and applies a guarded state transition; returns 409 `campaign_not_launchable` on a losing race |
| Progress | `GET /campaigns/:id/progress` reads `campaign_counters`; response gains `deliveryUncertain` |
| Recipient state | `delivery_uncertain` added to the public enum with documented meaning — provider may have accepted, we cannot confirm, never billed |
| Checkout | Session carries `client_reference_id` and `metadata.billing_customer_id`; `/billing/success` falls back to a server-side session lookup after 10 seconds of polling |
| Ops | `POST /admin/reconcile/billing` and `POST /admin/reconcile/campaign/:id`, both operator-scoped |
| Analytics | Every rate response gains `botFiltered` counts so customers can see what was excluded |

## H — queue changes

| Queue | Change |
| --- | --- |
| `email-send` | `lockDuration: 120000`, `maxStalledCount: 0`, provider timeout capped below lock duration, batch size capped at 100 |
| `email-retry` | Merged into `email-send` as delayed jobs; a separate consumer is how the limiter got bypassed (F11) |
| `recipient-sweeper` | **New.** Every 60s: `queued` older than 5 min back to `pending`; `sending` older than 10 min to `delivery_uncertain` |
| `campaign-reconcile` | **New.** Every 60s: force-exit stale transient campaign states; recompute counters against source of truth hourly |
| `event-ingest` | Renamed from provider webhook processing; high concurrency, resolves per-connection, applies the rank lattice |
| `billing-webhook` | No longer re-fetches inline; marks objects dirty in `billing_refetch_queue` |
| `billing-refetch` | **New.** Coalesced, at most one fetch per object per 30s, rate-limited inside Stripe's read budget |
| `billing-reconcile` | **New.** Nightly Stripe comparison with a divergence metric |
| `analytics-rollup` | Hourly pass becomes a genuine recompute over a bounded window, not watermark-incremental |
| scheduler | Drives from `scheduled_jobs` in Postgres; BullMQ repeatables removed entirely |
| limiter | Lives inside the provider adapter call path, fails closed, applies to first attempts and retries alike |

---

## The architecture I would approve

With the four Critical findings fixed and the High ones scheduled inside their originating phases, I would approve this design for production. That is a real endorsement: the core structural choices — a durable per-recipient state machine, scope as a type, locks as a last resort, convergent billing webhooks — are the right ones, and every finding above is a correction within that frame rather than an argument against it.

The changes I consider non-negotiable before a single external email is sent: the Postgres-resident idempotency guard (F1), the lock-duration and stall settings (F2), the sweeper (F3), and per-connection webhook binding (F4). F4 in particular is a security fix, not a reliability one, and it should be built in phase 3 when connections are first created rather than retrofitted in phase 6.

The thing I would most want the team to internalise is not any individual fix. It is that Redis was quietly promoted to a system of record in four separate places by four reasonable-looking local decisions. That is how this class of system fails: not by one bad choice, but by a durable-store assumption leaking into components that were never designed to hold one.
