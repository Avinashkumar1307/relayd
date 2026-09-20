import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  char,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  SessionId,
  UserId,
  WorkspaceId,
  WorkspaceInvitationId,
  WorkspaceMemberId,
} from '@relayd/types';
import { bytea, citext, inet } from './column-types.js';

/**
 * Identity and workspace tables, mirroring migration 0002_identity.sql.
 *
 * The migration is the authoritative DDL. This file exists so repositories get
 * typed queries against it, which is why every id column is branded: a query
 * returning a raw string id would defeat the whole point of the brands
 * (docs/13, CLAUDE.md section 6.2).
 */

const createdAt = timestamp('created_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .defaultNow();

const updatedAt = timestamp('updated_at', { withTimezone: true, mode: 'date' })
  .notNull()
  .defaultNow();

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().$type<UserId>(),
    email: citext('email').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'date' }),
    /** Null when the account is SSO-only. */
    passwordHash: text('password_hash'),
    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    /** KMS envelope, never a usable secret on its own (docs/06 s15). */
    mfaSecretEnc: bytea('mfa_secret_enc'),
    mfaEnabledAt: timestamp('mfa_enabled_at', { withTimezone: true, mode: 'date' }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    status: text('status').notNull().default('active').$type<'active' | 'suspended' | 'deleted'>(),
    createdAt,
    updatedAt,
  },
  (table) => [
    // Partial, so a deleted account's address can be reused.
    uniqueIndex('uq_users_email')
      .on(table.email)
      .where(sql`${table.status} <> 'deleted'`),
  ],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().$type<WorkspaceId>(),
    name: text('name').notNull(),
    slug: citext('slug').notNull(),
    /** ON DELETE RESTRICT: a workspace can never be orphaned. */
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' })
      .$type<UserId>(),
    status: text('status')
      .notNull()
      .default('active')
      .$type<'active' | 'past_due' | 'suspended' | 'cancelled' | 'deleted'>(),
    suspendedAt: timestamp('suspended_at', { withTimezone: true, mode: 'date' }),
    timezone: text('timezone').notNull().default('UTC'),
    defaultCurrency: char('default_currency', { length: 3 }).notNull().default('USD'),
    settings: jsonb('settings').notNull().default({}),
    createdAt,
    updatedAt,
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('uq_workspaces_slug')
      .on(table.slug)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: uuid('id').primaryKey().$type<WorkspaceMemberId>(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' })
      .$type<UserId>(),
    /** The four preset roles from docs/06 s15. */
    role: text('role').notNull().$type<'owner' | 'admin' | 'editor' | 'viewer'>(),
    /** Rare per-seat grants and denies, layered over the role matrix. */
    permissionsOverride: jsonb('permissions_override'),
    invitedBy: uuid('invited_by')
      .references(() => users.id)
      .$type<UserId>(),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('uq_ws_member').on(table.workspaceId, table.userId),
    // "which workspaces does this user belong to" - the workspace switcher.
    index('ix_ws_members_user').on(table.userId),
  ],
);

export const workspaceInvitations = pgTable(
  'workspace_invitations',
  {
    id: uuid('id').primaryKey().$type<WorkspaceInvitationId>(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .$type<WorkspaceId>(),
    email: citext('email').notNull(),
    /** Owner cannot be granted by invitation; ownership transfers explicitly. */
    role: text('role').notNull().$type<'admin' | 'editor' | 'viewer'>(),
    /** sha256 of the emailed token. The token itself is never stored. */
    tokenHash: bytea('token_hash').notNull(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id)
      .$type<UserId>(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt,
  },
  (table) => [
    // One live invitation per address per workspace; superseded ones do not block.
    uniqueIndex('uq_ws_invite_pending')
      .on(table.workspaceId, table.email)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    uniqueIndex('uq_ws_invite_token').on(table.tokenHash),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().$type<SessionId>(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' })
      .$type<UserId>(),
    refreshTokenHash: bytea('refresh_token_hash').notNull(),
    /**
     * Rotation family. Reuse of a consumed token revokes the whole family,
     * which is the standard refresh-token-theft detection (docs/06 s15).
     */
    familyId: uuid('family_id').notNull(),
    userAgent: text('user_agent'),
    ip: inet('ip'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    replacedBy: uuid('replaced_by')
      .references((): AnyPgColumn => sessions.id)
      .$type<SessionId>(),
    createdAt,
  },
  (table) => [
    uniqueIndex('uq_sessions_refresh').on(table.refreshTokenHash),
    index('ix_sessions_user_active')
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

/**
 * Append-only audit trail, range-partitioned on occurred_at.
 *
 * Drizzle does not model partitioning; the parent table is declared here so
 * queries are typed, and the partitions are managed in SQL. There is no
 * primary key because a partitioned table's PK must include the partition key.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').notNull(),
    /** Null for platform-level events with no workspace. */
    workspaceId: uuid('workspace_id').$type<WorkspaceId>(),
    actorType: text('actor_type').notNull().$type<'user' | 'api_key' | 'system' | 'provider'>(),
    actorId: uuid('actor_id'),
    /** Dotted action name: campaign.launched, billing.plan_changed. */
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    /** Ties an audit row back to the request that caused it (docs/10). */
    requestId: text('request_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('ix_audit_ws_time').on(table.workspaceId, table.occurredAt.desc())],
);

/**
 * Single-use tokens for email verification, password reset and email change.
 *
 * Cross-tenant like users and sessions: a token belongs to a person, and
 * password reset runs before any workspace is in context. See migration
 * 0004 for why this table exists at all — docs/02 specified the flows but
 * no storage for them.
 */
export const userTokens = pgTable(
  'user_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' })
      .$type<UserId>(),
    purpose: text('purpose')
      .notNull()
      .$type<'email_verification' | 'password_reset' | 'email_change'>(),
    /** sha256 of the emailed token; the token itself is never stored. */
    tokenHash: bytea('token_hash').notNull(),
    /**
     * The proposed address, for `email_change` only (migration 0019).
     *
     * A CHECK ties it to that purpose in both directions, so this is never
     * null on an email_change row and never set on any other.
     */
    newEmail: citext('new_email'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Single use: set on redemption. */
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt,
  },
  (table) => [
    uniqueIndex('uq_user_tokens_hash').on(table.tokenHash),
    index('ix_user_tokens_live')
      .on(table.userId, table.purpose)
      .where(sql`${table.consumedAt} IS NULL`),
  ],
);
