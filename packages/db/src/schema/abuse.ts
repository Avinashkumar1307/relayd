import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea } from './column-types.js';
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

/**
 * Consent attestations (migration 0016; docs/06 "Anti-abuse").
 *
 * Append-only, enforced by a trigger rather than by convention. Evidence you
 * can rewrite after the fact is worth nothing in the dispute it exists for,
 * and "the repository has no update method" is not a guarantee — a psql
 * session or a future repository can both still do it.
 */
export const consentAttestations = pgTable(
  'consent_attestations',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    subjectKind: text('subject_kind').notNull(),
    subjectId: uuid('subject_id').notNull(),

    source: text('source').notNull(),
    detail: text('detail'),

    /**
     * What the campaign's audience looked like when this was asserted.
     *
     * Closes the swap: attest about a small hand-built list, change the
     * audience to a purchased one, launch. Null for imports, where the
     * subject is the file.
     */
    audienceFingerprint: text('audience_fingerprint'),

    /** docs/06: "attributed to a user". Never an API key — a key is not a somebody. */
    attestedBy: uuid('attested_by').notNull(),
    attestedAt: timestamp('attested_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    attestedIp: text('attested_ip'),
  },
  (table) => ({
    bySubject: index('ix_ca_subject').on(
      table.workspaceId,
      table.subjectKind,
      table.subjectId,
      table.attestedAt,
    ),
    byWorkspace: index('ix_ca_workspace').on(table.workspaceId, table.attestedAt),
  }),
);

export type ConsentSubjectKind = 'import' | 'campaign';

/**
 * Enforcement state (migration 0017; docs/06 "Anti-abuse").
 *
 * One row per workspace, created when the first enforcement action lands.
 * Absent means `none` — a workspace nobody has had cause to act on is not
 * under enforcement.
 *
 * Kept apart from `workspaceTrust` on purpose. They look similar and are
 * not: trust is about age and is written once or twice in a workspace's
 * lifetime; this is written by a nightly job and read on every launch.
 */
export const workspaceEnforcement = pgTable(
  'workspace_enforcement',
  {
    workspaceId: uuid('workspace_id')
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    stage: text('stage').notNull().default('none'),
    reason: text('reason'),

    /** The measured rate at the moment of the decision. */
    observedRate: numeric('observed_rate'),
    observedSends: integer('observed_sends'),

    /** Reset on every change, so the recovery clock runs from this stage. */
    enteredAt: timestamp('entered_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),

    /** While true the automatic job does nothing, in either direction. */
    heldByOperator: boolean('held_by_operator').notNull().default(false),
    note: text('note'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Partial, matching migration 0017. Almost every workspace is `none`,
    // and an index that carried them all would be mostly a copy of the
    // primary key that the sweep never reads.
    byStage: index('ix_we_stage')
      .on(table.stage, table.enteredAt)
      .where(sql`${table.stage} <> 'none'`),
  }),
);

/**
 * The cross-workspace block list (migration 0018; docs/06 "Shared signals").
 *
 * The one table with no `workspace_id`, and that is the feature: an address
 * that complained in workspace A must not be mailed by workspace B.
 *
 * Addresses are stored only as peppered SHA-256 hashes. In plaintext this
 * would be a list of everyone who has ever complained, across every
 * customer — the most sensitive table in the database and a standing
 * temptation. Hashed, it answers "is this one blocked" and nothing else.
 */
export const globalBlockedAddresses = pgTable(
  'global_blocked_addresses',
  {
    addressHash: bytea('address_hash').primaryKey(),
    reason: text('reason').notNull(),
    /** Distinct workspaces that have seen this address complain. */
    workspaceCount: integer('workspace_count').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    byLastSeen: index('ix_gba_last_seen').on(table.lastSeenAt),
  }),
);

/**
 * Domains a reputation feed called malicious (migration 0018).
 *
 * Cached here so a launch does not depend on a third party being up — the
 * checker fails open, and this is what it falls back to. Also where an
 * operator adds a domain by hand, which is the faster path when a campaign
 * is going out now and the feed has not caught up.
 */
export const blockedLinkDomains = pgTable(
  'blocked_link_domains',
  {
    domain: text('domain').primaryKey(),
    verdict: text('verdict').notNull(),
    /** The feed that said so, or 'operator'. An appeal starts with "who says". */
    source: text('source').notNull(),
    note: text('note'),
    /**
     * When to re-check. Domains get cleaned up, resold and reused, and a
     * permanent block list slowly fills with entries nobody can justify.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    byExpiry: index('ix_bld_expires')
      .on(table.expiresAt)
      .where(sql`${table.expiresAt} is not null`),
  }),
);
