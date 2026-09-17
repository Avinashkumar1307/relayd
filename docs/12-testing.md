<!-- Testing strategy -->
> **Source of truth note.** This file is extracted from the Technical Design Document v0.1. Where it conflicts with `docs/17-review-findings.md` or `INVARIANTS.md`, those two files win — they contain the corrections from the independent adversarial review. Implement the corrected design, not the original where they differ.

# 20. Testing strategy

Integration tests against real Postgres and Redis in Testcontainers are the backbone. Mocking the database in a system whose correctness lives in unique constraints and guarded updates tests nothing that matters.

## The shape of the pyramid

| Layer | Count | Runtime | What it covers |
| --- | --- | --- | --- |
| Unit | \~1,200 | under 60s | Pure logic: entitlement evaluation, segment compiler, error classification, proration maths, token minting, routing ordering |
| Integration | \~400 | under 8 min | Real Postgres + Redis: repositories, transactions, constraints, queue semantics, state machines |
| Contract | \~40 per adapter | under 2 min | The shared adapter suite from section 9, run against every provider |
| API | \~200 | under 5 min | Supertest against a booted app: auth, validation, status codes, idempotency, tenant isolation |
| E2E | \~25 | under 15 min | Playwright: signup to first campaign, checkout, upgrade, cancel |
| Load | on demand | — | k6 against staging |

Coverage targets by area, because uniform coverage targets are a false comfort: billing and entitlements 95%, campaign and send path 90%, providers 85%, everything else 70%.

## Billing test matrix

Every one of these is mandatory before billing ships. They run against Stripe test mode with the CLI replaying fixture events, plus a deterministic fake gateway for speed.

| # | Case | Assertion |
| --- | --- | --- |
| B1 | Successful checkout | Subscription `active`, entitlements match plan, billing event written, invoice mirrored |
| B2 | Webhook arrives before the user returns | Success page finds `active` on first poll |
| B3 | Webhook delayed 5 minutes | Page shows processing, reconciler repairs, subscription eventually `active` |
| B4 | Duplicate `checkout.session.completed` | Exactly one subscription, one billing event, entitlements unchanged on the replay |
| B5 | Out-of-order: `subscription.updated` (old) after (new) | Final state equals provider truth, stale event marked skipped |
| B6 | Webhook with an invalid signature | 401, nothing written, alert emitted |
| B7 | Unknown event type | Stored as `ignored`, 200 returned |
| B8 | Payment fails on renewal | Status `past_due`, grace end set, notification queued, sending still allowed |
| B9 | Grace expires unpaid | Status `unpaid`, launch blocked, running campaign completes, scheduled campaigns held |
| B10 | Payment recovers during grace | Back to `active`, held campaigns resume automatically |
| B11 | Expired card at renewal | Dunning path identical to B8; payment method flagged `expired` in UI |
| B12 | Upgrade mid-period | Immediate entitlements, proration charged, usage counter **not** reset |
| B13 | Downgrade requested | Scheduled, entitlements unchanged, applied at period end |
| B14 | Downgrade blocked by usage | 422 with per-feature detail, nothing changed at the provider |
| B15 | Cancel at period end | Access intact to the boundary, then free entitlements |
| B16 | Cancel immediately | Entitlements drop at once, no refund issued |
| B17 | Resume after cancel-at-period-end | Flag cleared, subscription unchanged |
| B18 | Full refund with revoke | Refund mirrored, subscription cancelled, audit and billing events written |
| B19 | Partial refund | Amounts mirrored, entitlements untouched, invoice stays `paid` |
| B20 | Dispute opened | Sending suspended, ops alerted, dispute row created |
| B21 | Two concurrent checkouts | Exactly one active subscription survives; the loser reconciles |
| B22 | Renewal and upgrade in the same second | One coherent final state, no lost period boundary |
| B23 | Usage exactly at the limit | Send N allowed, send N+1 denied with 402 |
| B24 | Overage enabled | Sends continue, overage accrues, reported to the provider |
| B25 | Overage hard cap | Sending pauses at the cap, owner notified |
| B26 | Period rollover mid-campaign | Usage counted into the correct period on each side of the boundary |
| B27 | Provider 500 during checkout creation | 502, no orphan customer, retry succeeds |
| B28 | Reconciler finds drift | Provider state wins, entitlements rebuilt, discrepancy alerted |

## Campaign and send tests

| # | Case | Assertion |
| --- | --- | --- |
| C1 | Launch with 100k recipients | Snapshot completes, exactly 100k rows, no duplicates |
| C2 | Same contact in three lists | One recipient row |
| C3 | Suppressed contacts | Inserted as `suppressed`, never sent, not metered |
| C4 | Pause mid-send | Dispatcher stops within one batch, no sends after the drain, counts consistent |
| C5 | Resume | Continues from the exact remaining set, no resends |
| C6 | Cancel mid-send | In-flight finishes, rest cancelled, sent count exactly matches metered count |
| C7 | Duplicate send job | Second is a no-op, usage incremented once |
| C8 | Worker killed after provider accept | Sweep resolves, at most one meter |
| C9 | Provider rate limits at 50% | Campaign completes with delay, no failures, no sibling failover |
| C10 | All senders unhealthy | Campaign moves to `paused` with the reason, auto-resumes on recovery |
| C11 | Retry failed recipients | Only retryable errors reset; permanent ones excluded; no re-metering |
| C12 | Clone | Copies definition, not state or counters |
| C13 | Completion race | Exactly one completion transition |

## Security tests

| # | Case | Assertion |
| --- | --- | --- |
| S1 | Cross-tenant access, every endpoint | 404, generated from the route table |
| S2 | Role matrix, every endpoint | 403 where the role lacks the permission |
| S3 | API key scope escalation | Denied |
| S4 | JWT tampering, expiry, algorithm confusion (`alg: none`) | Rejected |
| S5 | Refresh token reuse after rotation | Entire family revoked |
| S6 | SSRF payloads in webhook URL, SMTP host, template image | Blocked including DNS-rebinding and redirect-to-metadata |
| S7 | CSV formula injection round trip | Exported cells neutralised |
| S8 | Malicious template HTML | Script and event handlers stripped; preview is sandboxed and cross-origin |
| S9 | Open redirect via click token | Impossible; token carries an index, not a URL |
| S10 | Forged tracking token | HMAC rejects |
| S11 | Rate limits | Enforced per user, key and IP |
| S12 | SQL injection in segment AST, filters and sort params | Parameterised, whitelisted |
| S13 | Zip bomb and oversized XLSX | Rejected before memory blows |
| S14 | Enumeration on login and reset | Identical responses and timing |

## Load tests

Run against staging before each scale milestone, not continuously.

| Scenario | Target | Pass criteria |
| --- | --- | --- |
| Campaign burst | 1M recipients queued | Snapshot under 10 min, memory flat, no lock contention |
| Sustained send | 100k emails/hour | p99 job latency under 5s, no DLQ growth |
| Webhook storm | 5,000 events/sec for 5 min | Ingest p99 under 200 ms, zero drops, queue drains within 10 min |
| Dashboard concurrency | 500 concurrent users | API p99 under 500 ms |
| Import | 2M-row CSV | Completes, memory under 512 MB, resumable |
| Usage contention | 2,000 concurrent meters, one workspace | Counter exactly correct, no deadlocks |

The last one is the test people skip and then discover in production as a slow drift in revenue. Run it.

## Test data and CI

Factories over fixtures, seeded deterministically. A `seedWorkspace()` helper builds a complete tenant (users, contacts, provider, sender, pool, template, campaign, subscription) in one call, and every test gets its own workspace so tests can run in parallel without a shared-state truce.

CI runs unit and lint on every push; integration, API and security on every PR; E2E and the billing matrix on merge to main; load on demand. The tenant-isolation suite and the billing matrix are **required checks** that cannot be bypassed by an admin merge.
