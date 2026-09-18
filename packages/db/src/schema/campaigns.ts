import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  date,
  foreignKey,
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
import type {
  CampaignId,
  ContactId,
  ProviderConnectionId,
  RecipientId,
  SenderAccountId,
  SendingPoolId,
  TemplateVersionId,
  TrackedLinkId,
  UserId,
  WorkspaceId,
} from '@relayd/types';
import { bytea, citext } from './column-types.js';
import { contacts } from './audience.js';
import { users, workspaces } from './identity.js';
import { providerConnections, senderAccounts } from './providers.js';
import { templateVersions } from './templates.js';

/**
 * Campaign tables, mirroring migration 0009_campaigns.sql.
 *
 * `campaignRecipients` is the durable state machine everything about not
 * sending twice rests on. Its physical shape is deliberate and documented in
 * the migration: fillfactor 80, one partial index on the active states only,
 * and a trigger making `metered` write-once (R14, R27).
 */

const createdAt = timestamp('created_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .default(sql`now()`);

const updatedAt = timestamp('updated_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .default(sql`now()`);

export type CampaignStatus =
  | 'draft'
  | 'scheduled'
  | 'validating'
  | 'queueing'
  | 'sending'
  | 'pausing'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'completed_with_errors'
  | 'held'
  | 'failed';

export type RecipientState =
  | 'pending'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'suppressed'
  | 'cancelled'
  | 'delivery_uncertain';

export type DeliveryState =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'soft_bounced'
  | 'hard_bounced'
  | 'complained';

/**
 * The F16 ordering lattice.
 *
 * A delivery transition applies only if it strictly increases the rank, so a
 * `delivered` arriving after a `bounced` — routine, because SNS gives no
 * ordering guarantee — cannot overwrite the bounce and leave the contact
 * unsuppressed.
 */
export const DELIVERY_RANK: Readonly<Record<DeliveryState, number>> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  soft_bounced: 3,
  hard_bounced: 4,
  complained: 5,
};

export const sendingPools = pgTable(
  'sending_pools',
  {
    id: uuid('id').primaryKey().$type<SendingPoolId>(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    name: text('name').notNull(),
    strategy: text('strategy')
      .notNull()
      .default('weighted')
      .$type<'round_robin' | 'weighted' | 'failover' | 'least_loaded'>(),
    isDefault: boolean('is_default').notNull().default(false),
    settings: jsonb('settings').notNull().default({}),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('uq_pool_name').on(table.workspaceId, table.name),
    uniqueIndex('uq_pool_ws').on(table.id, table.workspaceId),
    // PARTIAL. Migration 0009 has `WHERE is_default`, and without the
    // predicate here this is a different index entirely: one that permits a
    // workspace exactly one sending pool. Drizzle only generates SQL from
    // this, so the migration is what the database has — but anything reading
    // the schema to understand the shape would be reading a lie.
    uniqueIndex('uq_pool_default').on(table.workspaceId).where(sql`${table.isDefault}`),
  ],
);

export const sendingPoolMembers = pgTable(
  'sending_pool_members',
  {
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    poolId: uuid('pool_id').notNull().$type<SendingPoolId>(),
    senderAccountId: uuid('sender_account_id').notNull().$type<SenderAccountId>(),
    weight: smallint('weight').notNull().default(1),
    /** Lower first, for failover. */
    priority: smallint('priority').notNull().default(100),
    enabled: boolean('enabled').notNull().default(true),
  },
  (table) => [
    primaryKey({ columns: [table.poolId, table.senderAccountId] }),
    foreignKey({
      columns: [table.poolId, table.workspaceId],
      foreignColumns: [sendingPools.id, sendingPools.workspaceId],
      name: 'fk_spm_pool',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.senderAccountId, table.workspaceId],
      foreignColumns: [senderAccounts.id, senderAccounts.workspaceId],
      name: 'fk_spm_sender',
    }).onDelete('cascade'),
  ],
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().$type<CampaignId>(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    name: text('name').notNull(),
    type: text('type').notNull().default('regular').$type<'regular' | 'ab_test' | 'transactional'>(),
    status: text('status').notNull().default('draft').$type<CampaignStatus>(),

    /** Pinned at launch; RESTRICT so a sent campaign keeps naming it. */
    templateVersionId: uuid('template_version_id')
      .references(() => templateVersions.id, { onDelete: 'restrict' })
      .$type<TemplateVersionId>(),
    subjectOverride: text('subject_override'),

    sendingPoolId: uuid('sending_pool_id').$type<SendingPoolId>(),
    senderAccountId: uuid('sender_account_id').$type<SenderAccountId>(),

    audience: jsonb('audience').notNull().default({}),
    tracking: jsonb('tracking').notNull().default({ opens: true, clicks: true }),
    throttlePerHour: integer('throttle_per_hour'),

    scheduledAt: timestamp('scheduled_at', { withTimezone: true, mode: 'date' }),
    timezone: text('timezone'),

    recipientCount: integer('recipient_count').notNull().default(0),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true, mode: 'date' }),
    launchedAt: timestamp('launched_at', { withTimezone: true, mode: 'date' }),
    launchedBy: uuid('launched_by')
      .references(() => users.id)
      .$type<UserId>(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    pausedAt: timestamp('paused_at', { withTimezone: true, mode: 'date' }),

    /** F29: a double-clicked launch must not create two snapshots. */
    idempotencyKey: text('idempotency_key'),

    clonedFrom: uuid('cloned_from').$type<CampaignId>(),
    createdBy: uuid('created_by')
      .references(() => users.id)
      .$type<UserId>(),
    createdAt,
    updatedAt,
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('uq_campaign_ws').on(table.id, table.workspaceId),
    // Partial: a campaign with no key must not collide with every other
    // campaign that also has none.
    uniqueIndex('uq_campaign_idem')
      .on(table.workspaceId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index('ix_campaigns_ws_status').on(table.workspaceId, table.status, table.createdAt.desc()),
    index('ix_campaigns_due').on(table.scheduledAt).where(sql`${table.status} = 'scheduled'`),
    foreignKey({
      columns: [table.sendingPoolId, table.workspaceId],
      foreignColumns: [sendingPools.id, sendingPools.workspaceId],
      name: 'fk_campaign_pool',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.senderAccountId, table.workspaceId],
      foreignColumns: [senderAccounts.id, senderAccounts.workspaceId],
      name: 'fk_campaign_sender',
    }).onDelete('restrict'),
  ],
);

export const campaignRecipients = pgTable(
  'campaign_recipients',
  {
    id: uuid('id').primaryKey().$type<RecipientId>(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    campaignId: uuid('campaign_id').notNull().$type<CampaignId>(),
    contactId: uuid('contact_id').notNull().$type<ContactId>(),

    /** Snapshots, not joins: a contact edited mid-send must not change this. */
    email: citext('email').notNull(),
    mergeData: jsonb('merge_data').notNull().default({}),

    state: text('state').notNull().default('pending').$type<RecipientState>(),

    attemptCount: smallint('attempt_count').notNull().default(0),
    /** Identifies one attempt, so a late response matches the attempt that made it. */
    attemptToken: uuid('attempt_token'),
    queuedAt: timestamp('queued_at', { withTimezone: true, mode: 'date' }),
    providerAttemptStartedAt: timestamp('provider_attempt_started_at', {
      withTimezone: true,
      mode: 'date',
    }),

    senderAccountId: uuid('sender_account_id').$type<SenderAccountId>(),
    providerConnectionId: uuid('provider_connection_id').$type<ProviderConnectionId>(),
    providerMessageId: text('provider_message_id'),

    /** 16 random bytes; the basis of every tracking token for this recipient. */
    messageToken: bytea('message_token').notNull(),

    /** Write-once. The trigger in 0009 refuses to clear it (R14). */
    metered: boolean('metered').notNull().default(false),

    deliveryState: text('delivery_state').notNull().default('queued').$type<DeliveryState>(),
    deliveryRank: smallint('delivery_rank').notNull().default(0),

    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    terminalAt: timestamp('terminal_at', { withTimezone: true, mode: 'date' }),

    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('uq_cr_ws').on(table.id, table.workspaceId),
    uniqueIndex('uq_cr_campaign_contact').on(table.campaignId, table.contactId),
    uniqueIndex('uq_cr_token').on(table.messageToken),
    // The only state index, and partial: terminal rows leave it so their
    // updates become HOT (F27).
    // Every one of these is partial, and R27 is why: an unqualified index on
    // `state` would stop any update to a recipient being HOT, which is the
    // whole reason this table has fillfactor 80.
    index('ix_cr_active')
      .on(table.campaignId, table.state)
      .where(sql`${table.state} IN ('pending','queued','sending')`),
    index('ix_cr_stale_attempt')
      .on(table.providerAttemptStartedAt)
      .where(sql`${table.state} = 'sending'`),
    index('ix_cr_provider_msg')
      .on(table.providerMessageId)
      .where(sql`${table.providerMessageId} IS NOT NULL`),
    index('ix_cr_retry')
      .on(table.nextAttemptAt)
      .where(sql`${table.state} = 'failed' AND ${table.nextAttemptAt} IS NOT NULL`),
    foreignKey({
      columns: [table.campaignId, table.workspaceId],
      foreignColumns: [campaigns.id, campaigns.workspaceId],
      name: 'fk_cr_campaign',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.contactId, table.workspaceId],
      foreignColumns: [contacts.id, contacts.workspaceId],
      name: 'fk_cr_contact',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.senderAccountId, table.workspaceId],
      foreignColumns: [senderAccounts.id, senderAccounts.workspaceId],
      name: 'fk_cr_sender',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.providerConnectionId, table.workspaceId],
      foreignColumns: [providerConnections.id, providerConnections.workspaceId],
      name: 'fk_cr_connection',
    }).onDelete('set null'),
  ],
);

/**
 * Campaign progress, as a single row.
 *
 * Completion is `pending + queued + sending = 0` — one index-free read
 * instead of a COUNT(*) over millions of recipients in a request path
 * (F13, CLAUDE.md §12).
 */
export const campaignCounters = pgTable(
  'campaign_counters',
  {
    campaignId: uuid('campaign_id').primaryKey().$type<CampaignId>(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    total: integer('total').notNull().default(0),
    pending: integer('pending').notNull().default(0),
    queued: integer('queued').notNull().default(0),
    sending: integer('sending').notNull().default(0),
    sent: integer('sent').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    suppressed: integer('suppressed').notNull().default(0),
    uncertain: integer('uncertain').notNull().default(0),
    updatedAt,
  },
  (table) => [
    foreignKey({
      columns: [table.campaignId, table.workspaceId],
      foreignColumns: [campaigns.id, campaigns.workspaceId],
      name: 'fk_counters_campaign',
    }).onDelete('cascade'),
  ],
);

/** The durable daily quota, incremented in the `sent` transaction (F8). */
export const senderDailyUsage = pgTable(
  'sender_daily_usage',
  {
    senderAccountId: uuid('sender_account_id').notNull().$type<SenderAccountId>(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    usageDate: date('usage_date').notNull(),
    sentCount: bigint('sent_count', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.senderAccountId, table.usageDate] }),
    foreignKey({
      columns: [table.senderAccountId, table.workspaceId],
      foreignColumns: [senderAccounts.id, senderAccounts.workspaceId],
      name: 'fk_sdu_sender',
    }).onDelete('cascade'),
  ],
);

export const campaignEvents = pgTable(
  'campaign_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    campaignId: uuid('campaign_id').notNull().$type<CampaignId>(),
    eventType: text('event_type').notNull(),
    actorType: text('actor_type')
      .notNull()
      .default('system')
      .$type<'user' | 'api_key' | 'system' | 'provider'>(),
    actorId: uuid('actor_id'),
    detail: jsonb('detail').notNull().default({}),
    createdAt,
  },
  (table) => [
    index('ix_campaign_events_campaign').on(table.campaignId, table.createdAt.desc()),
    foreignKey({
      columns: [table.campaignId, table.workspaceId],
      foreignColumns: [campaigns.id, campaigns.workspaceId],
      name: 'fk_ce_campaign',
    }).onDelete('cascade'),
  ],
);

/**
 * Click destinations, resolved by index.
 *
 * A click URL is never taken from the request, which is what makes an open
 * redirect structurally impossible rather than merely guarded against
 * (docs/06).
 */
export const trackedLinks = pgTable(
  'tracked_links',
  {
    id: uuid('id').primaryKey().$type<TrackedLinkId>(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    campaignId: uuid('campaign_id').notNull().$type<CampaignId>(),
    url: text('url').notNull(),
    urlHash: bytea('url_hash').notNull(),
    label: text('label'),
    /** The index a tracking token carries. Stable for the campaign's life. */
    position: smallint('position').notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex('uq_link').on(table.campaignId, table.urlHash),
    uniqueIndex('uq_link_position').on(table.campaignId, table.position),
    foreignKey({
      columns: [table.campaignId, table.workspaceId],
      foreignColumns: [campaigns.id, campaigns.workspaceId],
      name: 'fk_link_campaign',
    }).onDelete('cascade'),
  ],
);

/**
 * Raw provider and tracking events, partitioned by range on occurred_at.
 *
 * Always written, whether or not the event advances the delivery lattice, so
 * analytics stays complete even when state does not move (F16).
 */
export const emailEvents = pgTable(
  'email_events',
  {
    id: uuid('id').notNull(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    campaignId: uuid('campaign_id').$type<CampaignId>(),
    campaignRecipientId: uuid('campaign_recipient_id').$type<RecipientId>(),
    contactId: uuid('contact_id').$type<ContactId>(),
    providerConnectionId: uuid('provider_connection_id').$type<ProviderConnectionId>(),

    eventType: text('event_type').notNull(),
    bounceClass: text('bounce_class').$type<'hard' | 'soft' | 'block' | 'suppressed'>(),

    providerMessageId: text('provider_message_id'),
    providerEventId: text('provider_event_id'),

    linkId: uuid('link_id').$type<TrackedLinkId>(),
    url: text('url'),
    userAgent: text('user_agent'),
    /** Hashed with a daily rotating salt, never a raw IP. */
    ipHash: bytea('ip_hash'),
    geoCountry: char('geo_country', { length: 2 }),
    deviceType: text('device_type'),
    clientFamily: text('client_family'),

    /** Stored and excluded, never dropped (R6). */
    isBot: boolean('is_bot').notNull().default(false),
    isPrefetch: boolean('is_prefetch').notNull().default(false),

    payload: jsonb('payload'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    // Declared per partition in the migration; named here so the schema and
    // the SQL describe the same shape.
    primaryKey({ columns: [table.id, table.occurredAt] }),
  ],
);

/**
 * The billing ledger.
 *
 * Written from day one even though plans arrive in Phase 8: a ledger started
 * late can never describe the sends that happened before it. The unique key
 * `send:{campaignRecipientId}` is the whole of R15.
 */
export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').notNull(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    featureKey: text('feature_key').notNull(),
    quantity: integer('quantity').notNull().default(1),
    idempotencyKey: text('idempotency_key').notNull(),
    campaignId: uuid('campaign_id').$type<CampaignId>(),
    resourceId: uuid('resource_id'),
    periodStart: timestamp('period_start', { withTimezone: true, mode: 'date' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [primaryKey({ columns: [table.id, table.occurredAt] })],
);
