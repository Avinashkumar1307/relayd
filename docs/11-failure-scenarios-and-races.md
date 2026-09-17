<!-- Failure scenarios and race conditions -->
> **Source of truth note.** This file is extracted from the Technical Design Document v0.1. Where it conflicts with `docs/17-review-findings.md` or `INVARIANTS.md`, those two files win — they contain the corrections from the independent adversarial review. Implement the corrected design, not the original where they differ.

# 19. Failure scenarios and race conditions

Every row below was designed for, not discovered. The recurring pattern: durable state in Postgres, deterministic job ids, guarded state transitions, and convergent handlers that re-read truth instead of trusting a message.

## Failure scenarios

| Scenario | What happens | State at rest | Recovery |
| --- | --- | --- | --- |
| **API task crashes** | ALB drains it; in-flight requests 502 | Nothing half-written: every mutation is one transaction | ECS replaces the task in about 60s. Clients retry with the same idempotency key |
| **Worker crashes mid-job** | BullMQ lock expires after 30s, job is reclaimed | Recipient stuck in `sending` | Retry finds `sending`, resolves against the provider, then proceeds. Stale-sending sweep after 10 min |
| **Worker crashes after provider accepted** | Job retried; the send already happened | Recipient `sending`, `metered=false` | The ambiguity case from section 8: provider lookup by our custom header, else the configured bias. The only non-deterministic path in the system |
| **Redis unavailable** | Workers cannot fetch jobs; API caches fail open on reads, closed on writes | Postgres untouched | On reconnect the dispatcher re-derives pending work from `campaign_recipients`. Nothing lost, throughput pauses |
| **Redis data loss** | Queued jobs vanish | All truth is in Postgres | Recovery job: for every running campaign re-enqueue `pending` and `queued` recipients; replay unprocessed webhook inbox rows; resume imports from `processed_rows` |
| **Postgres unavailable** | API returns 503 via `/ready`; workers back off and stop consuming | Nothing written | Multi-AZ failover in 60 to 120s. Workers resume; jobs stay queued in Redis |
| **Postgres failover mid-transaction** | Transaction lost, connection error | Atomic: fully committed or not at all | Retry the job. Idempotency guards make a repeat harmless |
| **Provider unavailable** | Adapter returns `provider_unavailable` | Recipient back to `pending` | Backoff retry; sender health drops; after 3 consecutive the connection goes `degraded` and routing prefers others |
| **Provider timeout** | Adapter returns `timeout`, ambiguous | Recipient stays `sending` | Reconciler after 10 min queries the provider, resolves, else applies the configured bias |
| **Provider rate limit** | `rate_limited` with a retry-after | Recipient `pending`, token bucket drained | Requeue with the provider's own delay. Never fail over to a sibling sender for a rate limit |
| **Duplicate provider webhook** | Second delivery of the same event | `uq_ee_dedup` rejects the insert | Handler catches the conflict, acks, no side effects re-run |
| **Webhook out of order** | Both stored with true `occurred_at` | Events are facts; recipient status is derived | Status derivation uses event precedence, not arrival order: complaint beats hard bounce beats delivered |
| **Duplicate email job** | Same recipient enqueued twice | Deterministic `jobId` dedups in Redis; if it slips through, the `metered=false` guarded update makes the second a no-op | Zero duplicate charge, at most one duplicate send in the crash window |
| **Payment succeeds, webhook delayed** | UI polls, sees a non-active subscription | Checkout intent recorded; subscription not yet created | Success page reports payment processing. A reconciler polls the provider for sessions completed in the last hour and repairs |
| **Duplicate payment webhook** | Second POST of the same event id | `uq_pwe` rejects the insert; ingest returns 200 without enqueueing | Nothing runs twice |
| **Payment provider unavailable** | Checkout creation fails | Nothing written beyond the idempotent customer row | 502 with a retry prompt. Webhooks queue on the provider side and arrive later |
| **Subscription state mismatch** | Our mirror disagrees with the provider | Detected by the nightly reconciler diffing active subscriptions | Provider wins; entitlements rebuilt; discrepancy logged as a billing event and alerted |
| **Campaign paused while jobs queued** | Status `pausing`; queued jobs still in Redis | Recipients stay `queued` | Workers check status and the halt flag, ack without sending, reset the recipient to `pending`. Resume re-enqueues |
| **Campaign cancelled mid-processing** | In-flight sends complete | Remaining rows bulk-updated to `cancelled` | Already-sent recipients are counted and billed. Never a partial rollback |
| **Plan changed during a campaign** | Upgrade applies to the remainder; downgrade is scheduled | Entitlements versioned | A running campaign that exceeds a lowered limit is never cut off mid-send; the limit applies to the next launch |
| **Contact deleted during a campaign** | `ON DELETE RESTRICT` from `campaign_recipients` blocks hard deletion | Soft delete is allowed and the send proceeds from the snapshot | The email still sends, because it was committed to at launch. Correct behaviour, and the UI must explain it |
| **Import file corrupt mid-parse** | Worker fails at row N | `processed_rows = N`, prior batches committed | Resume from N, or cancel and download the error report |
| **Disk full on RDS** | Writes fail | Storage autoscaling enabled, alarm at 80% | Autoscales; the alert fires long before |
| **Certificate expiry** | TLS failures | ACM auto-renews | Alarm at 14 days as a backstop |

## Race conditions

Ordered by how much damage each does if unhandled.

| # | Race | Solution | Mechanism |
| --- | --- | --- | --- |
| 1 | **Two workers send the same recipient** | Guarded update on `metered = false`; the loser gets 0 rows | Postgres row atomicity, no lock |
| 2 | **Concurrent usage increments** | `ON CONFLICT DO UPDATE SET used = used + 1` | Atomic upsert, sharded past 500/s |
| 3 | **Duplicate payment webhook** | `uq_pwe` on provider plus event id | Unique constraint |
| 4 | **Two checkouts, two subscriptions** | `uq_sub_active_ws` partial unique index | Unique constraint; the second webhook reconciles |
| 5 | **Upgrade and renewal simultaneously** | Re-fetch from the provider before every mirror write; compare `provider_state_version` | Convergent handler |
| 6 | **Two workers pick the same sender** | Redis atomic multi-bucket consume; row lock only for concurrency-1 senders | Lua script plus selective `SKIP LOCKED` |
| 7 | **Two dispatchers claim the same recipients** | `FOR UPDATE SKIP LOCKED` in the claim CTE | Row lock held microseconds |
| 8 | **Pause and resume at once** | Guarded transition on allowed prior states | One wins, the other gets 409 |
| 9 | **Cancel during pause** | `cancelling` reachable from `pausing`, `paused` and `running` | State machine |
| 10 | **Two completion checks** | Guarded update with a `NOT EXISTS` predicate | Loser updates 0 rows |
| 11 | **Provider limit from a stale snapshot** | Token buckets are the authority; the snapshot only sets capacity | Redis |
| 12 | **Concurrent contact creation** | `uq_contacts_ws_email` plus upsert | Unique constraint |
| 13 | **Same contact in two lists in one campaign** | `uq_cr_campaign_contact` | Unique constraint |
| 14 | **Entitlement read during rebuild** | Rebuild is one transaction; readers see old or new, never a mixture | Transaction isolation |
| 15 | **Scheduler runs twice** | `pg_try_advisory_lock` held for the tick | Advisory lock |
| 16 | **Two workers process one launch** | Deterministic `jobId` plus the guarded draft-to-validating transition | Job id plus state guard |
| 17 | **Suppression added mid-campaign** | Send worker re-checks suppression immediately before dispatch, not only at snapshot | Read at the last moment |
| 18 | **Member removed mid-request** | `ver` claim checked against Redis every request | Token versioning |

Count the mechanisms: eleven of eighteen are a unique constraint or a guarded update. Three use row locks with `SKIP LOCKED`. One uses an advisory lock. **None use a Redis distributed lock.** That distribution is deliberate, and any future change reaching for Redlock should be argued against this table first.

## Why no Redlock

Redis distributed locks are correct only under assumptions — bounded clock drift, bounded GC pauses, no partition longer than the lease — that do not hold on autoscaling Fargate with a JIT runtime. Where the invariant is `this row changes at most once`, a Postgres constraint is an actual guarantee rather than a probabilistic one, at lower latency. The only legitimate uses are leader election, which an advisory lock covers, and coarse exclusion where a rare double execution is harmless, in which case you did not need the lock.

## The stale-sending sweep

One scheduled job closes the largest remaining hole:

```sql
SELECT id, campaign_id, provider_id, provider_message_id, attempt_count
  FROM campaign_recipients
 WHERE status = 'sending'
   AND updated_at < now() - interval '10 minutes'
 ORDER BY updated_at
 LIMIT 500
 FOR UPDATE SKIP LOCKED;
```

For each row, ask the provider whether a message carrying our recipient header exists. Found: mark `sent` and meter once. Definitively absent: back to `pending` for retry. Provider cannot answer: apply the workspace's configured bias and flag the recipient in the campaign report as `delivery_uncertain`. Being honest about the uncertain ones beats silently picking a side.
