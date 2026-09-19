import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { WorkspaceId } from '@relayd/types';
import { bytea } from './column-types.js';
import { users, workspaces } from './identity.js';

/**
 * The public API surface, mirroring migration 0014_platform.sql.
 *
 * API keys, idempotency keys and outbound webhooks: the three things an
 * external integrator needs and the dashboard does not.
 *
 * Two columns carry the security properties. `api_keys.key_hash` is an
 * unsalted sha256 over the full key: never read back, and the lookup key.
 * 32 random bytes is 256 bits of entropy, so a KDF buys nothing and would
 * cost about 100ms on every request (docs/16, 2026-09-19). And
 * `outbound_webhook_endpoints.secret_ref` is a Secrets Manager ARN rather
 * than a secret, the same rule provider credentials follow.
 */

const createdAt = timestamp('created_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .default(sql`now()`);

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    name: text('name').notNull(),

    /** Display only, and deliberately not unique. */
    keyPrefix: text('key_prefix').notNull(),
    /** sha256 of the whole key. The lookup key. */
    keyHash: bytea('key_hash').notNull(),

    /** Intersected with the minting role. `billing:write` is never grantable. */
    scopes: text('scopes').array().notNull().default(sql`'{}'`),

    lastUsedAt: ts('last_used_at'),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
  },
  (table) => [
    // The lookup, and the guard: a hash computed over a constant collides on
    // the second key rather than quietly authenticating everybody.
    uniqueIndex('uq_apikey_hash').on(table.keyHash),
    // For the UI's key list. The revocation check is the row, not the index —
    // a revoked key must still be found, so the caller can be told it was
    // revoked rather than told it never existed.
    index('ix_apikey_prefix').on(table.keyPrefix).where(sql`revoked_at IS NULL`),
    index('ix_apikey_ws').on(table.workspaceId, table.createdAt.desc()),
  ],
);

export type IdempotencyStatus = 'in_progress' | 'completed';

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    key: text('key').notNull(),
    /**
     * Part of the key. The same idempotency key against two endpoints is two
     * requests, and collapsing them would replay a launch as an import.
     */
    endpoint: text('endpoint').notNull(),

    /** Reusing a key with a different body is an error, not a replay. */
    requestHash: bytea('request_hash').notNull(),

    status: text('status').notNull().$type<IdempotencyStatus>(),
    responseCode: smallint('response_code'),
    responseBody: jsonb('response_body'),

    lockedAt: ts('locked_at'),
    createdAt,
    expiresAt: ts('expires_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.key, table.endpoint] }),
    index('ix_idem_expiry').on(table.expiresAt),
    index('ix_idem_stuck').on(table.lockedAt).where(sql`status = 'in_progress'`),
  ],
);

export type WebhookEndpointStatus = 'active' | 'paused' | 'failing' | 'disabled';

export const outboundWebhookEndpoints = pgTable(
  'outbound_webhook_endpoints',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    url: text('url').notNull(),

    /** A Secrets Manager ARN, never the secret. */
    secretRef: text('secret_ref').notNull(),
    /** Live until the overlap window closes, so a rotation breaks nobody. */
    previousSecretRef: text('previous_secret_ref'),
    secretRotatedAt: ts('secret_rotated_at'),

    events: text('events').array().notNull(),

    status: text('status').notNull().default('active').$type<WebhookEndpointStatus>(),

    consecutiveFailures: smallint('consecutive_failures').notNull().default(0),
    lastSuccessAt: ts('last_success_at'),
    lastFailureAt: ts('last_failure_at'),
    disabledAt: ts('disabled_at'),
    disabledReason: text('disabled_reason'),

    description: text('description'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index('ix_owe_ws').on(table.workspaceId, table.createdAt.desc()),
    index('ix_owe_active')
      .on(table.workspaceId)
      .where(sql`status IN ('active', 'failing')`),
  ],
);

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'abandoned';

/**
 * One row per (endpoint, event).
 *
 * `attempt` counts the tries and the response columns hold the most recent
 * one, so a delivery that succeeded on the fourth go reads as attempt 4 with
 * a 200 and one still failing reads as its last error. The unique index on
 * `(endpoint_id, event_id)` is what makes a producer emitting the same event
 * twice send it once.
 */
export const outboundWebhookDeliveries = pgTable(
  'outbound_webhook_deliveries',
  {
    id: bigserial('id', { mode: 'number' }),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => outboundWebhookEndpoints.id, { onDelete: 'cascade' }),

    eventType: text('event_type').notNull(),
    /** Ours, sent in the payload, and stable across retries so they can dedupe. */
    eventId: uuid('event_id').notNull(),
    payload: jsonb('payload').notNull(),

    attempt: smallint('attempt').notNull().default(1),
    status: text('status').notNull().default('pending').$type<WebhookDeliveryStatus>(),

    responseCode: smallint('response_code'),
    /** Truncated by the caller: a 2MB HTML error page must not fill this table. */
    responseBody: text('response_body'),
    error: text('error'),
    durationMs: integer('duration_ms'),

    scheduledFor: ts('scheduled_for').notNull().default(sql`now()`),
    deliveredAt: ts('delivered_at'),
    createdAt,
  },
  (table) => [primaryKey({ columns: [table.id, table.createdAt] })],
);
