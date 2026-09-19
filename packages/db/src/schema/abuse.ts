import { sql } from 'drizzle-orm';
import { date, index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './identity.js';

/**
 * Anti-abuse tables (migration 0015; docs/06 "Anti-abuse").
 *
 * Mirrors the SQL exactly. `packages/db/test/schema-matches-migrations.test.ts`
 * compares the two in both directions, so a column added here and not there —
 * or there and not here — fails rather than producing a query against a
 * column that does not exist.
 */

/**
 * The daily send counter the new-workspace cap is checked against.
 *
 * `day` is a UTC date, not the workspace's local one. A cap that reset at
 * local midnight would reset at a different instant for every workspace,
 * which makes "how many have they sent today" a question with no single
 * answer at the moment somebody is asking it during an incident.
 */
export const workspaceSendQuota = pgTable(
  'workspace_send_quota',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    sent: integer('sent').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.day] }),
    byDay: index('ix_wsq_day').on(table.day),
  }),
);

/**
 * One row per workspace, created lazily.
 *
 * A workspace with **no row** is in-ramp and unlifted. That default is the
 * whole safety property: a missing row capping a legitimate workspace at 500
 * a day produces a complaint somebody answers, while the other way round
 * produces a blocklisted sending IP and no complaint at all until it is too
 * late to fix.
 */
export const workspaceTrust = pgTable('workspace_trust', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),

  rampLiftedAt: timestamp('ramp_lifted_at', { withTimezone: true }),
  /**
   * `automatic` or `operator`. The distinction matters when a workspace
   * later turns out to be a spammer: one is a policy that was too loose,
   * the other is a person who was misled.
   */
  rampLiftedBy: text('ramp_lifted_by'),
  rampLiftedNote: text('ramp_lifted_note'),

  /** An operator's deliberate extension. Overrides the age check. */
  rampUntil: timestamp('ramp_until', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});
