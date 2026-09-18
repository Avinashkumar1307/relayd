import { sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { CampaignId, ContactId, ProviderConnectionId, TrackedLinkId, WorkspaceId } from '@relayd/types';
import { contacts } from './audience.js';
import { campaigns, trackedLinks } from './campaigns.js';
import { workspaces } from './identity.js';
import { providerConnections } from './providers.js';

/**
 * Analytics rollups, mirroring migration 0011_analytics.sql.
 *
 * Every table here is derived and every one is an upsert target keyed on what
 * it aggregates. A rollup that has run twice must leave the same rows as one
 * that ran once, which is what makes the hourly recompute (R24) able to
 * simply overwrite whatever the incremental pass left behind.
 */

const computedAt = timestamp('computed_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .default(sql`now()`);

export const campaignStats = pgTable(
  'campaign_stats',
  {
    campaignId: uuid('campaign_id')
      .primaryKey()
      .references(() => campaigns.id, { onDelete: 'cascade' })
      .$type<CampaignId>(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),

    /** Dispatch facts, from campaign_recipients rather than from events. */
    recipients: integer('recipients').notNull().default(0),
    sent: integer('sent').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    suppressed: integer('suppressed').notNull().default(0),
    deliveryUncertain: integer('delivery_uncertain').notNull().default(0),

    /** Feedback facts, from email_events. */
    delivered: integer('delivered').notNull().default(0),
    bouncedHard: integer('bounced_hard').notNull().default(0),
    bouncedSoft: integer('bounced_soft').notNull().default(0),
    complained: integer('complained').notNull().default(0),
    unsubscribed: integer('unsubscribed').notNull().default(0),

    opensTotal: integer('opens_total').notNull().default(0),
    opensUnique: integer('opens_unique').notNull().default(0),
    opensUniqueNonbot: integer('opens_unique_nonbot').notNull().default(0),

    clicksTotal: integer('clicks_total').notNull().default(0),
    clicksUnique: integer('clicks_unique').notNull().default(0),
    clicksUniqueNonbot: integer('clicks_unique_nonbot').notNull().default(0),

    computedAt,
    /** Which pass wrote this: the 30-second one, or the authoritative hourly one. */
    computedBy: text('computed_by').notNull().default('incremental').$type<'incremental' | 'hourly'>(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [index('ix_campaign_stats_ws').on(table.workspaceId, table.computedAt.desc())],
);

export const campaignDailyStats = pgTable(
  'campaign_daily_stats',
  {
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' })
      .$type<CampaignId>(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    /** UTC. Presentation converts; storage does not. */
    day: date('day').notNull(),

    sent: integer('sent').notNull().default(0),
    delivered: integer('delivered').notNull().default(0),
    bounced: integer('bounced').notNull().default(0),
    complained: integer('complained').notNull().default(0),
    opensUniqueNonbot: integer('opens_unique_nonbot').notNull().default(0),
    clicksUnique: integer('clicks_unique').notNull().default(0),
    unsubscribed: integer('unsubscribed').notNull().default(0),

    computedAt,
  },
  (table) => [
    primaryKey({ columns: [table.campaignId, table.day] }),
    index('ix_cds_ws_day').on(table.workspaceId, table.day.desc()),
  ],
);

export const providerStats = pgTable(
  'provider_stats',
  {
    providerConnectionId: uuid('provider_connection_id')
      .notNull()
      .references(() => providerConnections.id, { onDelete: 'cascade' })
      .$type<ProviderConnectionId>(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    day: date('day').notNull(),

    sent: integer('sent').notNull().default(0),
    delivered: integer('delivered').notNull().default(0),
    bouncedHard: integer('bounced_hard').notNull().default(0),
    bouncedSoft: integer('bounced_soft').notNull().default(0),
    complained: integer('complained').notNull().default(0),
    deferred: integer('deferred').notNull().default(0),
    rejected: integer('rejected').notNull().default(0),

    computedAt,
  },
  (table) => [
    primaryKey({ columns: [table.providerConnectionId, table.day] }),
    index('ix_provider_stats_ws_day').on(table.workspaceId, table.day.desc()),
  ],
);

export const deviceStats = pgTable(
  'device_stats',
  {
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' })
      .$type<CampaignId>(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    deviceType: text('device_type').notNull(),
    clientFamily: text('client_family').notNull(),

    opens: integer('opens').notNull().default(0),
    clicks: integer('clicks').notNull().default(0),

    computedAt,
  },
  (table) => [primaryKey({ columns: [table.campaignId, table.deviceType, table.clientFamily] })],
);

export const linkStats = pgTable(
  'link_stats',
  {
    linkId: uuid('link_id')
      .primaryKey()
      .references(() => trackedLinks.id, { onDelete: 'cascade' })
      .$type<TrackedLinkId>(),
    campaignId: uuid('campaign_id').notNull().$type<CampaignId>(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),

    clicksTotal: integer('clicks_total').notNull().default(0),
    clicksUnique: integer('clicks_unique').notNull().default(0),
    clicksUniqueNonbot: integer('clicks_unique_nonbot').notNull().default(0),

    computedAt,
  },
  (table) => [index('ix_link_stats_campaign').on(table.campaignId, table.clicksUnique.desc())],
);

/**
 * R26: written only by the hourly rollup.
 *
 * Updating this per event would put the heaviest write contention on exactly
 * the contacts that are mailed most. A grep test enforces that nothing
 * outside `packages/analytics/rollup` writes to it.
 */
export const contactEngagement = pgTable(
  'contact_engagement',
  {
    contactId: uuid('contact_id')
      .primaryKey()
      .references(() => contacts.id, { onDelete: 'cascade' })
      .$type<ContactId>(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),

    campaignsReceived: integer('campaigns_received').notNull().default(0),
    opens: integer('opens').notNull().default(0),
    clicks: integer('clicks').notNull().default(0),

    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true, mode: 'date' }),
    lastClickedAt: timestamp('last_clicked_at', { withTimezone: true, mode: 'date' }),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true, mode: 'date' }),

    /** 0-100, recomputed wholesale rather than incremented. */
    engagementScore: smallint('engagement_score').notNull().default(0),

    computedAt,
  },
  (table) => [index('ix_contact_engagement_ws').on(table.workspaceId, table.engagementScore.desc())],
);
