import { sql } from 'drizzle-orm';
import {
  bigserial,
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
  ContactId,
  ContactListId,
  ImportJobId,
  SegmentId,
  SuppressionId,
  TagId,
  UserId,
  WorkspaceId,
} from '@relayd/types';
import { bytea, citext, inet } from './column-types.js';
import { users, workspaces } from './identity.js';

/**
 * Audience tables, mirroring migration 0005_audience.sql.
 *
 * The join tables use composite foreign keys on (id, workspace_id) rather
 * than plain ones, so a list from workspace A cannot be given a contact from
 * workspace B. See the migration for why that is not merely tidiness.
 */

const createdAt = timestamp('created_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .defaultNow();

const updatedAt = timestamp('updated_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .defaultNow();

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().$type<ContactId>(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    email: citext('email').notNull(),
    /** Generated in the database; never written by the application. */
    emailDomain: text('email_domain'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    status: text('status')
      .notNull()
      .default('subscribed')
      .$type<'subscribed' | 'unsubscribed' | 'bounced' | 'complained' | 'cleaned'>(),
    source: text('source')
      .notNull()
      .default('manual')
      .$type<'manual' | 'import' | 'api' | 'form' | 'automation'>(),
    consentStatus: text('consent_status')
      .notNull()
      .default('unknown')
      .$type<'unknown' | 'single_optin' | 'double_optin' | 'imported_declared'>(),
    consentAt: timestamp('consent_at', { withTimezone: true, mode: 'date' }),
    consentIp: inet('consent_ip'),
    consentSource: text('consent_source'),
    attributes: jsonb('attributes').notNull().default({}),
    lastEngagedAt: timestamp('last_engaged_at', { withTimezone: true, mode: 'date' }),
    engagementScore: smallint('engagement_score').notNull().default(0),
    createdAt,
    updatedAt,
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('uq_contacts_ws_email')
      .on(table.workspaceId, table.email)
      .where(sql`${table.deletedAt} IS NULL`),
    index('ix_contacts_ws_status')
      .on(table.workspaceId, table.status)
      .where(sql`${table.deletedAt} IS NULL`),
    index('ix_contacts_ws_created').on(table.workspaceId, table.createdAt.desc()),
    index('ix_contacts_domain').on(table.workspaceId, table.emailDomain),
  ],
);

export const contactLists = pgTable(
  'contact_lists',
  {
    id: uuid('id').primaryKey().$type<ContactListId>(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    name: text('name').notNull(),
    description: text('description'),
    /** Denormalised, reconciled nightly. Never the source of truth for a send. */
    memberCount: integer('member_count').notNull().default(0),
    createdBy: uuid('created_by')
      .references(() => users.id)
      .$type<UserId>(),
    createdAt,
    updatedAt,
    /**
     * Set when the list is archived (0020). A timestamp rather than a flag:
     * D3's card footnote is "Archived 1 Sep 2026", which a boolean cannot
     * say.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [uniqueIndex('uq_list_name').on(table.workspaceId, table.name)],
);

/**
 * A named filter, drawn as a tab on D1 (0020).
 *
 * Workspace state rather than per-user: the frame shows one strip of tabs to
 * everybody in the workspace.
 */
export const contactSavedViews = pgTable(
  'contact_saved_views',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    /** The slug the tab strip sends back as `?view=`. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    /** `{ status?, q? }` — the subset the contacts list can serve. */
    filters: jsonb('filters').notNull().default({}),
    createdBy: uuid('created_by')
      .references(() => users.id)
      .$type<UserId>(),
    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex('uq_saved_view_key').on(table.workspaceId, table.key)],
);

export const contactListMembers = pgTable(
  'contact_list_members',
  {
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    listId: uuid('list_id').notNull().$type<ContactListId>(),
    contactId: uuid('contact_id').notNull().$type<ContactId>(),
    addedAt: timestamp('added_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    addedBy: text('added_by').notNull().default('manual'),
  },
  (table) => [
    // Composite: a plain FK on each column would happily accept a list from
    // one workspace and a contact from another.
    foreignKey({
      columns: [table.listId, table.workspaceId],
      foreignColumns: [contactLists.id, contactLists.workspaceId],
      name: 'fk_clm_list',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.contactId, table.workspaceId],
      foreignColumns: [contacts.id, contacts.workspaceId],
      name: 'fk_clm_contact',
    }).onDelete('cascade'),
    index('ix_clm_contact').on(table.contactId),
    index('ix_clm_ws_list').on(table.workspaceId, table.listId),
  ],
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().$type<TagId>(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    name: citext('name').notNull(),
    color: text('color'),
    createdAt,
  },
  (table) => [uniqueIndex('uq_tag_name').on(table.workspaceId, table.name)],
);

export const contactTags = pgTable(
  'contact_tags',
  {
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    contactId: uuid('contact_id').notNull().$type<ContactId>(),
    tagId: uuid('tag_id').notNull().$type<TagId>(),
    taggedAt: timestamp('tagged_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.contactId, table.workspaceId],
      foreignColumns: [contacts.id, contacts.workspaceId],
      name: 'fk_ct_contact',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.tagId, table.workspaceId],
      foreignColumns: [tags.id, tags.workspaceId],
      name: 'fk_ct_tag',
    }).onDelete('cascade'),
    index('ix_contact_tags_tag').on(table.tagId),
  ],
);

export const segments = pgTable(
  'segments',
  {
    id: uuid('id').primaryKey().$type<SegmentId>(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    name: text('name').notNull(),
    /** A validated AST. User SQL is never stored and never executed. */
    definition: jsonb('definition').notNull(),
    kind: text('kind').notNull().default('dynamic').$type<'dynamic' | 'static'>(),
    cachedCount: integer('cached_count'),
    cachedAt: timestamp('cached_at', { withTimezone: true, mode: 'date' }),
    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex('uq_segment_name').on(table.workspaceId, table.name)],
);

export const suppressions = pgTable(
  'suppressions',
  {
    id: uuid('id').primaryKey().$type<SuppressionId>(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    email: citext('email').notNull(),
    /** sha256, for set membership at send time. */
    emailHash: bytea('email_hash').notNull(),
    reason: text('reason')
      .notNull()
      .$type<'unsubscribe' | 'hard_bounce' | 'complaint' | 'manual' | 'global_block' | 'invalid'>(),
    scope: text('scope').notNull().default('workspace').$type<'workspace' | 'campaign' | 'list'>(),
    scopeRefId: uuid('scope_ref_id'),
    sourceEventId: uuid('source_event_id'),
    /**
     * The campaign that caused it, for D7's Source column and filter (0020).
     *
     * Null for a manual, imported or globally blocked address. The migration
     * carries a composite foreign key to `campaigns (id, workspace_id)` with
     * `ON DELETE SET NULL (source_campaign_id)`; Drizzle cannot express the
     * column list on SET NULL, so the reference is declared there and not
     * here. The migration is the authority (CLAUDE.md section 8).
     */
    sourceCampaignId: uuid('source_campaign_id'),
    notes: text('notes'),
    createdAt,
  },
  (table) => [index('ix_suppressions_hash').on(table.workspaceId, table.emailHash)],
);

/**
 * A requested export (0020).
 *
 * The row is the intent; a worker turns it into a file. Redis is transport
 * and never the only copy of something somebody asked for (CLAUDE.md
 * section 9).
 */
export const exportJobs = pgTable(
  'export_jobs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    resource: text('resource')
      .notNull()
      .$type<'contacts' | 'suppressions' | 'lists' | 'tags' | 'segments'>(),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'running' | 'completed' | 'failed' | 'cancelled'>(),
    /** What the page that asked for it was showing, including any selection. */
    filters: jsonb('filters').notNull().default({}),
    rowCount: integer('row_count'),
    s3Key: text('s3_key'),
    error: text('error'),
    requestedBy: uuid('requested_by')
      .references(() => users.id)
      .$type<UserId>(),
    createdAt,
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [index('ix_export_jobs_ws_created').on(table.workspaceId, table.createdAt.desc())],
);

export const importJobs = pgTable(
  'import_jobs',
  {
    id: uuid('id').primaryKey().$type<ImportJobId>(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    s3Key: text('s3_key').notNull(),
    originalFilename: text('original_filename').notNull(),
    byteSize: text('byte_size').notNull(),
    fileType: text('file_type').notNull().$type<'csv' | 'tsv' | 'xlsx'>(),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<
        'pending' | 'mapping' | 'validating' | 'processing' | 'completed' | 'failed' | 'cancelled'
      >(),
    columnMapping: jsonb('column_mapping'),
    options: jsonb('options').notNull().default({}),
    totalRows: integer('total_rows'),
    processedRows: integer('processed_rows').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    updatedCount: integer('updated_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    errorReportS3Key: text('error_report_s3_key'),
    errorSummary: jsonb('error_summary'),
    createdBy: uuid('created_by')
      .references(() => users.id)
      .$type<UserId>(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt,
  },
  (table) => [
    index('ix_imports_ws_status').on(table.workspaceId, table.status, table.createdAt.desc()),
  ],
);

export const importRowErrors = pgTable(
  'import_row_errors',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    importId: uuid('import_id').notNull().$type<ImportJobId>(),
    /** 1-based, as the user sees it in their spreadsheet. */
    rowNumber: integer('row_number').notNull(),
    columnName: text('column_name'),
    errorCode: text('error_code').notNull(),
    message: text('message').notNull(),
    rawValue: text('raw_value'),
    createdAt,
  },
  (table) => [
    foreignKey({
      columns: [table.importId, table.workspaceId],
      foreignColumns: [importJobs.id, importJobs.workspaceId],
      name: 'fk_ire_import',
    }).onDelete('cascade'),
    index('ix_import_row_errors_import').on(table.importId, table.rowNumber),
  ],
);
