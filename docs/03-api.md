<!-- API architecture and specification -->
> **Source of truth note.** This file is extracted from the Technical Design Document v0.1. Where it conflicts with `docs/17-review-findings.md` or `INVARIANTS.md`, those two files win — they contain the corrections from the independent adversarial review. Implement the corrected design, not the original where they differ.

# 16. API architecture and specification

One versioned REST API serves both the dashboard and external customers. Same routes, same contracts, different credentials — which forces the API to be good, because you use it yourself every day.

## Conventions

| Concern | Rule |
| --- | --- |
| Base | `https://api.relayd.io/api/v1` |
| Workspace | `X-Workspace-Id` header on every tenant route. API keys are workspace-bound, so the header is optional and must match if sent |
| Auth | `Authorization: Bearer <jwt>` for the dashboard, `Authorization: Bearer rk_live_...` for API keys |
| Casing | `camelCase` in JSON, `snake_case` in the database. Mapping lives in the repository layer only |
| Time | RFC 3339 UTC with `Z`, always |
| Money | Integer minor units plus a currency field. Never a float, never a formatted string |
| Pagination | Cursor only. `?limit=50&cursor=...`. No `offset` anywhere — it degrades and it double-serves rows under concurrent writes |
| Sorting | `?sort=-createdAt` with a whitelist per resource |
| Filtering | Explicit query params per resource. No generic query language in v1 |
| Idempotency | `Idempotency-Key` required on all `POST` that create or charge; honoured 24h |
| Partial update | `PATCH` with `.strict()` schemas; unknown fields are `400` |
| Long operations | `202 Accepted` with a resource whose status you poll. Never a blocking request over 5 seconds |

## Envelopes

```json
{ "data": { "id": "018f...", "name": "Weekly digest" },
  "meta": { "requestId": "req_01J8..." } }
```

```json
{ "data": [ { "id": "018f..." } ],
  "meta": { "requestId": "req_01J8...", "hasMore": true, "nextCursor": "eyJpZCI6..." } }
```

```json
{ "error": {
    "code": "validation_failed",
    "message": "Request validation failed",
    "details": [ { "path": "audience.listIds", "message": "At least one list is required" } ],
    "requestId": "req_01J8...",
    "docsUrl": "https://docs.relayd.io/errors/validation_failed"
  } }
```

## Error codes

| HTTP | Code | When |
| --- | --- | --- |
| 400 | `validation_failed`, `malformed_request` | Zod failure, bad JSON |
| 401 | `unauthenticated`, `token_expired`, `invalid_api_key` |  |
| 403 | `insufficient_permission` | Authenticated, member, wrong role |
| 404 | `not_found` | Also returned for cross-tenant access attempts |
| 409 | `conflict`, `invalid_state_transition`, `idempotency_key_reuse` |  |
| 402 | `entitlement_denied`, `limit_reached`, `payment_required` | Body names the feature, limit and current usage |
| 422 | `unprocessable`, `plan_downgrade_blocked` | Semantically invalid but well-formed |
| 429 | `rate_limited` | With `Retry-After` |
| 500 | `internal_error` | Never leaks detail; `requestId` is the handle for support |
| 502/503 | `provider_unavailable`, `service_unavailable` |  |

## Route map

| Group | Routes |
| --- | --- |
| `/auth` | `POST /register`, `/login`, `/refresh`, `/logout`, `/verify-email`, `/forgot-password`, `/reset-password`, `/mfa/enroll`, `/mfa/verify` |
| `/users` | `GET /me`, `PATCH /me`, `POST /me/password`, `GET /me/workspaces` |
| `/workspaces` | `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `GET /:id/members`, `PATCH /:id/members/:userId`, `DELETE /:id/members/:userId`, `POST /:id/invitations`, `GET /:id/invitations`, `DELETE /:id/invitations/:inviteId`, `POST /invitations/accept` |
| `/contacts` | `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `POST /bulk`, `POST /search`, `GET /:id/activity` |
| `/lists` | `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `POST /:id/contacts`, `DELETE /:id/contacts` |
| `/tags`, `/segments` | CRUD, plus `POST /segments/:id/preview` |
| `/suppressions` | `GET /`, `POST /`, `DELETE /:id`, `POST /bulk` |
| `/imports` | `POST /` (returns presigned URL), `POST /:id/mapping`, `POST /:id/start`, `GET /:id`, `GET /:id/errors`, `POST /:id/cancel` |
| `/providers` | `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `POST /:id/verify`, `GET /:id/quota`, `GET /:id/identities`, `POST /:id/identities` |
| `/sender-accounts` | CRUD, `POST /:id/test` |
| `/pools` | CRUD, `POST /:id/members`, `DELETE /:id/members/:senderId`, `GET /:id/health` |
| `/templates` | CRUD, `GET /:id/versions`, `POST /:id/versions`, `POST /:id/preview`, `POST /:id/test-send` |
| `/campaigns` | `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `POST /:id/launch`, `/pause`, `/resume`, `/cancel`, `/clone`, `/retry-failed`, `/test-send`, `GET /:id/recipients`, `GET /:id/progress` |
| `/analytics` | `GET /overview`, `/campaigns/:id`, `/campaigns/:id/timeseries`, `/campaigns/:id/links`, `/campaigns/:id/devices`, `/providers`, `GET /events` |
| `/billing` | `GET /subscription`, `GET /plans`, `POST /checkout`, `POST /portal`, `POST /subscription/change`, `POST /subscription/cancel`, `POST /subscription/resume`, `GET /invoices`, `GET /invoices/:id`, `GET /usage`, `GET /payment-methods` |
| `/api-keys` | `GET /`, `POST /`, `DELETE /:id` |
| `/webhook-endpoints` | CRUD, `POST /:id/test`, `GET /:id/deliveries` |
| `/audit-logs` | `GET /` |
| Public, unauthenticated | `POST /webhooks/email/:providerId`, `POST /webhooks/stripe`, `GET /o/:token.gif`, `GET /c/:token`, \`GET |

## Key endpoints in detail

**Create contact** — upsert semantics, because every integration wants them.

```json
POST /api/v1/contacts
X-Workspace-Id: 018f2c11-...
Idempotency-Key: 9d1c-...

{
  "email": "aisha@example.com",
  "firstName": "Aisha",
  "attributes": { "country": "AE", "plan": "gold" },
  "listIds": ["018f3a..."],
  "tagIds": ["018f4b..."],
  "consent": { "status": "double_optin", "source": "signup_form", "at": "2026-09-01T10:00:00Z" },
  "updateIfExists": true
}
```

```json
201 Created
{ "data": {
    "id": "018f5c...", "email": "aisha@example.com", "status": "subscribed",
    "attributes": { "country": "AE", "plan": "gold" },
    "lists": [{ "id": "018f3a...", "name": "Newsletter" }],
    "createdAt": "2026-09-17T09:14:02Z", "wasCreated": true
  }, "meta": { "requestId": "req_01J8..." } }
```

Validation: RFC-5322 email plus a DNS MX check (cached 24h, non-blocking — a missing MX is a warning, not a rejection). Attributes capped at 50 keys and 8 KB. Writing a suppressed address returns `201` with `status: "unsubscribed"` rather than an error, because resurrecting a suppression silently would be worse.

**Launch campaign** — the highest-stakes endpoint in the product.

```json
POST /api/v1/campaigns/018f7d.../launch
Idempotency-Key: launch-018f7d-1

{ "confirmRecipientCount": 48210 }
```

```json
202 Accepted
{ "data": {
    "id": "018f7d...", "status": "validating",
    "estimatedRecipients": 48210,
    "quota": { "feature": "campaigns.monthly_emails", "used": 12040, "limit": 100000,
               "afterThisCampaign": 60250 },
    "progressUrl": "/api/v1/campaigns/018f7d.../progress"
  } }
```

`confirmRecipientCount` must match the server's current estimate within 1%, or `409 recipient_count_changed`. That is a deliberate optimistic-concurrency check: it stops a user from launching to 400,000 people when the UI showed 40,000 because a segment changed in another tab.

Failure cases: `402` with the shortfall, `409 invalid_state_transition`, `422` for unverified sender, `422 no_healthy_sender`, `403` without `campaign:launch`.

**Progress** — polled by the UI every 3 seconds while running.

```json
GET /api/v1/campaigns/018f7d.../progress

{ "data": {
    "status": "running",
    "recipients": 48210,
    "counts": { "pending": 31004, "queued": 4800, "sending": 96,
                "sent": 12200, "failed": 18, "suppressed": 92 },
    "rate": { "perMinute": 1840, "etaSeconds": 1172 },
    "pauseReason": null,
    "updatedAt": "2026-09-17T09:31:44Z"
  } }
```

Served from Redis counters maintained by the send workers, refreshed from Postgres every 10 seconds. A polling endpoint hit by 200 concurrent dashboards must not run a `GROUP BY` over 48,000 rows each time.

**Usage.**

```json
GET /api/v1/billing/usage

{ "data": {
    "period": { "start": "2026-09-01T00:00:00Z", "end": "2026-10-01T00:00:00Z" },
    "features": [
      { "key": "campaigns.monthly_emails", "used": 60250, "limit": 100000,
        "overage": 0, "overageAllowed": true, "pct": 60.25 },
      { "key": "audience.contacts", "used": 48210, "limit": 50000, "pct": 96.42 },
      { "key": "team.seats", "used": 4, "limit": 10, "pct": 40 }
    ]
  } }
```

**Change plan.**

```json
POST /api/v1/billing/subscription/change
{ "priceId": "018f9e...", "quantity": 6 }
```

```json
200 OK
{ "data": {
    "effect": "immediate",
    "proration": { "amount": 4200, "currency": "USD", "description": "Prorated upgrade to Scale" },
    "subscription": { "status": "active", "planCode": "scale",
                      "currentPeriodEnd": "2026-10-01T00:00:00Z" }
  } }
```

For a downgrade, `effect` is `scheduled` with `effectiveAt`, and a blocked downgrade returns the `422 plan_downgrade_blocked` body shown in section 7.

## Idempotency implementation

```ts
async function withIdempotency<T>(
  ctx: Ctx, key: string, endpoint: string, body: unknown, fn: () => Promise<T>
): Promise<T> {
  const hash = sha256(canonicalJson(body));
  const claimed = await db.insert(idempotencyKeys).values({
    workspaceId: ctx.workspaceId, key, endpoint, requestHash: hash,
    status: 'in_progress', lockedAt: new Date(),
    expiresAt: addHours(new Date(), 24),
  }).onConflictDoNothing().returning();

  if (claimed.length === 0) {
    const existing = await repo.getIdempotencyKey(ctx.workspaceId, key, endpoint);
    if (!existing.requestHash.equals(hash)) throw new ConflictError('idempotency_key_reuse');
    if (existing.status === 'in_progress') throw new ConflictError('request_in_progress');
    return existing.responseBody as T;                 // replay the stored response
  }
  const result = await fn();
  await repo.completeIdempotencyKey(ctx.workspaceId, key, endpoint, 200, result);
  return result;
}
```

The stored `requestHash` is what makes this safe: reusing a key with a *different* body is an error, not a silent replay of the wrong response.

## Transaction boundaries

| Operation | Transaction contents |
| --- | --- |
| Register user | user + workspace + membership + free subscription + entitlements, one transaction |
| Accept invitation | membership insert + invitation update, one transaction |
| Create campaign | campaign row only |
| Launch | status transition alone; snapshot happens in the worker in batched transactions of 10k rows |
| Import commit | per-batch of 1,000 contacts, so a failure at row 400,000 does not roll back 399,999 |
| Send | recipient update + usage record + aggregate, one transaction, no external calls inside |
| Billing webhook | mirror + entitlements + billing event, one transaction |

**Never hold a transaction open across an HTTP call.** The send worker calls the provider first, then opens a short transaction to record the result. A transaction held across a 30-second provider timeout is how you exhaust the connection pool.

## OpenAPI generation

Zod schemas are annotated with `zod-to-openapi` and the spec is generated at build time, published at `/api/v1/openapi.json`, and diffed in CI. A breaking change to a public schema fails the build unless the version is bumped. The docs site and the TypeScript client SDK are both generated from that spec, so they cannot drift.


---

# Review amendments — apply on top of everything above

These supersede the baseline where they differ.

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
