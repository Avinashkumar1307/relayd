import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  ProviderConnectionId,
  SenderAccountId,
  SenderIdentityId,
  UserId,
  WorkspaceId,
} from '@relayd/types';
import { citext } from './column-types.js';
import { users, workspaces } from './identity.js';

/**
 * Provider tables, mirroring migration 0006_providers.sql.
 *
 * The migration is the authority; this file must agree with it. Nothing here
 * holds a credential — `credentialRef` and `webhookSecretArn` are Secrets
 * Manager ARNs, so a database dump is not a credential breach (INVARIANTS
 * R21).
 */

const createdAt = timestamp('created_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .default(sql`now()`);

const updatedAt = timestamp('updated_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .default(sql`now()`);

export type ProviderType = 'ses' | 'sendgrid' | 'mailgun' | 'brevo' | 'smtp' | 'google';

export type ConnectionStatus =
  | 'pending'
  | 'verifying'
  | 'active'
  | 'degraded'
  | 'disabled'
  | 'revoked'
  | 'error';

export const providerConnections = pgTable(
  'provider_connections',
  {
    id: uuid('id').primaryKey().$type<ProviderConnectionId>(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    providerType: text('provider_type').notNull().$type<ProviderType>(),
    name: text('name').notNull(),
    status: text('status').notNull().default('pending').$type<ConnectionStatus>(),

    /** Secrets Manager ARN. Never the secret itself. */
    credentialRef: text('credential_ref').notNull(),
    /** Bumping this forces every worker's 5-minute credential cache to refresh. */
    credentialVersion: integer('credential_version').notNull().default(1),

    config: jsonb('config').notNull().default({}),
    capabilities: jsonb('capabilities').notNull().default({}),

    /** The unguessable path segment in POST /ingest/v1/{provider}/{token}. */
    endpointToken: text('endpoint_token').notNull(),
    webhookSecretArn: text('webhook_secret_arn'),

    quotaSnapshot: jsonb('quota_snapshot'),
    quotaCheckedAt: timestamp('quota_checked_at', { withTimezone: true, mode: 'date' }),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true, mode: 'date' }),
    lastError: jsonb('last_error'),

    createdBy: uuid('created_by')
      .references(() => users.id)
      .$type<UserId>(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('uq_provider_name').on(table.workspaceId, table.name),
    uniqueIndex('uq_provider_conn_ws').on(table.id, table.workspaceId),
    uniqueIndex('uq_conn_endpoint_token').on(table.endpointToken),
    index('ix_provider_ws_status').on(table.workspaceId, table.status),
  ],
);

export const senderIdentities = pgTable(
  'sender_identities',
  {
    id: uuid('id').primaryKey().$type<SenderIdentityId>(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    providerId: uuid('provider_id').notNull().$type<ProviderConnectionId>(),
    kind: text('kind').notNull().$type<'domain' | 'email'>(),
    value: citext('value').notNull(),
    verificationStatus: text('verification_status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'verified' | 'failed' | 'expired'>(),
    dkimStatus: text('dkim_status'),
    spfStatus: text('spf_status'),
    dmarcStatus: text('dmarc_status'),
    dnsRecords: jsonb('dns_records'),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true, mode: 'date' }),
    createdAt,
  },
  (table) => [
    uniqueIndex('uq_identity').on(table.providerId, table.kind, table.value),
    uniqueIndex('uq_identity_ws').on(table.id, table.workspaceId),
    // Composite, so an identity cannot belong to a connection in another
    // workspace. A plain FK on provider_id alone permits exactly that, and
    // RLS does not catch it — the row carries one workspace_id and reads as
    // legitimate from both sides.
    foreignKey({
      columns: [table.providerId, table.workspaceId],
      foreignColumns: [providerConnections.id, providerConnections.workspaceId],
      name: 'fk_identity_provider',
    }).onDelete('cascade'),
    index('ix_identity_ws_provider').on(table.workspaceId, table.providerId),
  ],
);

export type SenderStatus = 'active' | 'paused' | 'cooling_down' | 'disabled' | 'failed';

export const senderAccounts = pgTable(
  'sender_accounts',
  {
    id: uuid('id').primaryKey().$type<SenderAccountId>(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    providerId: uuid('provider_id').notNull().$type<ProviderConnectionId>(),
    identityId: uuid('identity_id').notNull().$type<SenderIdentityId>(),
    fromEmail: citext('from_email').notNull(),
    fromName: text('from_name').notNull(),
    replyTo: citext('reply_to'),
    status: text('status').notNull().default('active').$type<SenderStatus>(),

    dailyLimit: integer('daily_limit'),
    hourlyLimit: integer('hourly_limit'),
    concurrencyLimit: smallint('concurrency_limit').notNull().default(4),
    warmupStage: smallint('warmup_stage'),
    healthScore: smallint('health_score').notNull().default(100),
    consecutiveFailures: smallint('consecutive_failures').notNull().default(0),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true, mode: 'date' }),
    lastSendAt: timestamp('last_send_at', { withTimezone: true, mode: 'date' }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('uq_sender').on(table.workspaceId, table.providerId, table.fromEmail),
    uniqueIndex('uq_sender_ws').on(table.id, table.workspaceId),
    foreignKey({
      columns: [table.providerId, table.workspaceId],
      foreignColumns: [providerConnections.id, providerConnections.workspaceId],
      name: 'fk_sender_provider',
    }).onDelete('cascade'),
    // RESTRICT, not CASCADE: deleting a verified identity out from under a
    // sender that campaigns reference would leave them unable to explain why
    // they stopped.
    foreignKey({
      columns: [table.identityId, table.workspaceId],
      foreignColumns: [senderIdentities.id, senderIdentities.workspaceId],
      name: 'fk_sender_identity',
    }).onDelete('restrict'),
    index('ix_sender_selectable')
      .on(table.workspaceId, table.status, table.healthScore.desc())
      .where(sql`${table.status} = 'active'`),
  ],
);

/**
 * The inbound webhook inbox.
 *
 * Every event lands here verified but unapplied, and a worker interprets it
 * afterwards. `matched` defaults to false: an event that resolves to no
 * recipient of its connection is kept as evidence, never as an instruction
 * (INVARIANTS R4).
 */
export const providerWebhookEvents = pgTable(
  'provider_webhook_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    providerConnectionId: uuid('provider_connection_id').notNull().$type<ProviderConnectionId>(),
    providerType: text('provider_type').notNull().$type<ProviderType>(),

    /**
     * The provider's own event id where it gives one, otherwise a hash of the
     * payload. Never null: an event that cannot be deduplicated is an event
     * that will be applied twice.
     */
    dedupeKey: text('dedupe_key').notNull(),

    matched: boolean('matched').notNull().default(false),
    eventType: text('event_type'),
    providerMessageId: text('provider_message_id'),
    recipientEmail: citext('recipient_email'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }),

    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    processError: text('process_error'),
  },
  (table) => [
    // A provider redelivering the same event — which they all do — inserts
    // nothing the second time. ON CONFLICT DO NOTHING plus this index is the
    // whole idempotency story.
    uniqueIndex('uq_pwe_dedupe').on(table.providerConnectionId, table.dedupeKey),
    foreignKey({
      columns: [table.providerConnectionId, table.workspaceId],
      foreignColumns: [providerConnections.id, providerConnections.workspaceId],
      name: 'fk_pwe_connection',
    }).onDelete('cascade'),
    index('ix_pwe_unprocessed')
      .on(table.workspaceId, table.receivedAt)
      .where(sql`${table.processedAt} IS NULL`),
    index('ix_pwe_unmatched')
      .on(table.workspaceId, table.receivedAt)
      .where(sql`NOT ${table.matched}`),
  ],
);
