import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { TemplateId, TemplateVersionId, UserId, WorkspaceId } from '@relayd/types';
import { users, workspaces } from './identity.js';

/**
 * Template tables, mirroring migration 0007_templates.sql.
 *
 * A version with `publishedAt` set is immutable, enforced by a trigger in the
 * migration rather than by convention here. A campaign records the version id
 * it rendered, so editing a published version would rewrite what a customer
 * has already sent.
 */

const createdAt = timestamp('created_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .default(sql`now()`);

export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().$type<TemplateId>(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    name: text('name').notNull(),
    category: text('category'),
    currentVersionId: uuid('current_version_id').$type<TemplateVersionId>(),
    createdBy: uuid('created_by')
      .references(() => users.id)
      .$type<UserId>(),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    /**
     * F1's Archived tab (migration 0021). Not a delete: the row stays
     * readable, its name stays reserved by `uq_template_name`, and
     * unarchiving clears it.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('uq_template_ws').on(table.id, table.workspaceId),
    // Partial on deleted_at, so a name freed by a soft delete can be reused.
    // Both partial on `deleted_at IS NULL`. Without the predicate the
    // unique one would keep a deleted template's name reserved forever.
    uniqueIndex('uq_template_name')
      .on(table.workspaceId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index('ix_templates_ws_updated')
      .on(table.workspaceId, table.updatedAt.desc())
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const templateVersions = pgTable(
  'template_versions',
  {
    id: uuid('id').primaryKey().$type<TemplateVersionId>(),
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    templateId: uuid('template_id').notNull().$type<TemplateId>(),
    version: integer('version').notNull(),

    subject: text('subject').notNull(),
    preheader: text('preheader'),
    /** What the author wrote. */
    htmlSource: text('html_source').notNull(),
    /** What will be sent: sanitised, and never re-derived from source. */
    htmlCompiled: text('html_compiled').notNull(),
    textBody: text('text_body').notNull(),
    designJson: jsonb('design_json'),

    /** Discovered merge tags and their defaults. */
    variables: jsonb('variables').notNull().default([]),

    /** NULL means draft. Set once; the trigger refuses to clear it. */
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    publishedBy: uuid('published_by')
      .references(() => users.id)
      .$type<UserId>(),

    createdBy: uuid('created_by')
      .references(() => users.id)
      .$type<UserId>(),
    createdAt,
  },
  (table) => [
    uniqueIndex('uq_tpl_version').on(table.templateId, table.version),
    uniqueIndex('uq_tpl_version_ws').on(table.id, table.workspaceId),
    foreignKey({
      columns: [table.templateId, table.workspaceId],
      foreignColumns: [templates.id, templates.workspaceId],
      name: 'fk_tpl_version_template',
    }).onDelete('cascade'),
    index('ix_tpl_versions_template').on(table.templateId, table.version.desc()),
  ],
);
