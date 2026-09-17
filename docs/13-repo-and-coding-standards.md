<!-- Repository structure and coding standards -->
> **Source of truth note.** This file is extracted from the Technical Design Document v0.1. Where it conflicts with `docs/17-review-findings.md` or `INVARIANTS.md`, those two files win — they contain the corrections from the independent adversarial review. Implement the corrected design, not the original where they differ.

# 21. Repository structure and coding standards

Your proposed structure is close to right. Two changes: collapse the five worker apps into one app with five entrypoints, and add `track` and `ingest` as real apps.

## Structure

```
relayd/
  apps/
    web/                      React SPA
    api/                      Express, the dashboard and public API
    track/                    open/click/unsubscribe endpoints only
    ingest/                   provider and payment webhook receivers only
    worker/                   ONE app, entrypoints below
      src/entrypoints/{send,campaign,events,billing,io}.ts
    scheduler/                cron and leader-elected sweeps
  packages/
    config/                   env parsing (Zod), constants
    logger/                   Pino, redaction, trace context
    types/                    shared DTOs, branded ids
    validation/               Zod schemas shared by API and web
    utils/                    crypto, dates, result types
    db/                       Drizzle schema, migrations, repositories
    queue/                    BullMQ setup, typed job defs, idempotency
    email-providers/          the port and six adapters
    billing/                  domain, gateway port, Stripe adapter, entitlements
    campaigns/                launch, dispatch, state machine
    audience/                 contacts, segments, import parsing
    analytics/                rollups, metric definitions
    notifications/            templates and delivery for product email
    testing/                  factories, containers, fake gateways
  infra/
    terraform/{modules,environments/{staging,production}}
    docker/
  docs/
    adr/  runbooks/  api/
```

**Why one worker app.** Five separate apps means five `package.json`, five Dockerfiles, five dependency trees that drift, and a shared domain layer imported five ways. One app with five entrypoints gives identical deployment isolation — five ECS services running `node dist/entrypoints/send.js` — with one build. If a worker genuinely needs different dependencies later, split it then.

**Why `track` and `ingest` are separate apps.** Both are public, unauthenticated, high-RPS and latency-critical, with almost no dependencies. Keeping them in `api` means they inherit its cold start, its middleware stack, and its blast radius.

## TypeScript configuration

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true
  }
}
```

`noUncheckedIndexedAccess` is the one people disable because it is annoying. Keep it. It catches exactly the class of bug that shows up when a provider returns a shorter array than you expected.

Branded ids stop the most common silent bug in a system with fifteen uuid-shaped things:

```ts
type Brand<T, B extends string> = T & { readonly __brand: B };
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type CampaignId  = Brand<string, 'CampaignId'>;
export type RecipientId = Brand<string, 'RecipientId'>;
// findById(campaignId, workspaceId) with the arguments swapped no longer compiles.
```

## Lint rules that carry real weight

Beyond the standard set, five custom rules encode the architecture:

| Rule | Enforces |
| --- | --- |
| No `db.select`/`db.insert` outside `packages/db/repositories` | Section 15 L3 |
| No plan code string literals outside `packages/billing/plans` | Section 8, no hardcoded plan logic |
| No provider SDK imports outside `packages/email-providers/adapters/*` and `packages/billing/adapters/*` | Sections 9 and 5 |
| No `process.env` outside `packages/config` | Typed, validated config only |
| No `console.*` anywhere | Structured logging only |

A rule that is not machine-checked is a convention people forget under deadline. These five are the ones worth the tooling.

## Error handling

One base class, a code enum, and typed results at domain boundaries:

```ts
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: unknown,
    readonly cause?: unknown,
  ) { super(message); }
}
export class NotFoundError extends AppError { /* 404 */ }
export class EntitlementError extends AppError { /* 402, carries feature + limit */ }
export class ConflictError extends AppError { /* 409 */ }
```

Rules: services throw `AppError` subclasses; one Express error middleware maps them to the envelope from section 16; unexpected errors become a 500 with a `requestId` and full Sentry context but no leaked detail; **never** swallow an error to return a default value; in workers, distinguish retryable from permanent explicitly rather than letting BullMQ guess.

## Logging

```ts
logger.info({ campaignId, recipientCount, senderAccountId }, 'campaign dispatch started');
```

Structured fields, never interpolated strings. Levels: `error` needs human action, `warn` is degraded but handled, `info` is a state change worth an audit trail, `debug` is off in production. Every log line inherits the trace context from `AsyncLocalStorage`. Redaction is configured in the logger package, not remembered at each call site.

## Database conventions

Covered in section 3. Additionally: migrations are numbered `0001_description.sql`, immutable once merged, with a `-- ROLLBACK:` comment block describing the reversal; every migration is reviewed by someone other than the author; index creation is always `CONCURRENTLY` and always in its own migration.

## Git

| Convention | Value |
| --- | --- |
| Branching | Trunk-based. Short-lived `feat/*`, `fix/*`, `chore/*` off `main`. No long release branches |
| Commits | Conventional Commits, enforced by commitlint. `feat(billing): add proration preview endpoint` |
| PRs | Under 400 lines changed where possible, one reviewer minimum, two for anything under `packages/billing` or `packages/db` |
| Merge | Squash, with the PR title as the commit message |
| Releases | Tagged from `main`, changelog generated from commits |
| Protected | `main` requires green CI including the tenant-isolation and billing suites |

The two-reviewer rule on billing and schema is worth the friction. Those are the two places where a mistake is either expensive or irreversible.
