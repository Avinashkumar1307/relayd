import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import type { SuppressionId, WorkspaceId } from '@relayd/types';
import { suppressions } from '../schema/audience.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';
import { suppressionHash } from '../helpers.js';

export type SuppressionReason =
  | 'unsubscribe'
  | 'hard_bounce'
  | 'complaint'
  | 'manual'
  | 'global_block'
  | 'invalid';

export interface SuppressionRow {
  id: SuppressionId;
  workspaceId: WorkspaceId;
  email: string;
  reason: SuppressionReason;
  scope: 'workspace' | 'campaign' | 'list';
  notes: string | null;
  /**
   * The campaign that caused it (migration 0020), for D7's Source column.
   *
   * Null for a manual, imported or globally blocked address — and null for
   * everything else until the events worker starts writing it.
   */
  sourceCampaignId: string | null;
  createdAt: Date;
}

/** What D7's three chips narrow the list by. */
export interface ListSuppressionsOptions {
  limit?: number | undefined;
  reason?: SuppressionReason | undefined;
  /** A campaign id, matched against `source_campaign_id`. */
  sourceCampaignId?: string | undefined;
  /** D7's search box. Matches the address, case-insensitively. */
  search?: string | undefined;
}

/**
 * "A suppressed address is never sent to, ever" (docs/00, core aggregates).
 *
 * This repository is on the send path, which is why membership checks here
 * take a set of addresses rather than one: the alternative is one query per
 * recipient, fifty thousand times per campaign.
 */
export class SuppressionRepository {
  constructor(private readonly db: Executor) {}

  async add(
    scope: WorkspaceScope,
    input: {
      id: SuppressionId;
      email: string;
      reason: SuppressionReason;
      notes?: string;
      sourceEventId?: string;
    },
  ): Promise<SuppressionRow | null> {
    const [row] = await this.db
      .insert(suppressions)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        email: input.email,
        emailHash: suppressionHash(input.email),
        reason: input.reason,
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
      })
      // Already suppressed is the desired state, not an error. Suppressing
      // twice must never fail a bounce handler and leave the address sendable.
      .onConflictDoNothing()
      .returning();

    return row === undefined ? null : toRow(row);
  }

  async list(
    scope: WorkspaceScope,
    options: ListSuppressionsOptions = {},
  ): Promise<SuppressionRow[]> {
    const search = options.search === undefined || options.search === '' ? null : options.search;

    const rows = await this.db
      .select()
      .from(suppressions)
      .where(
        and(
          eq(suppressions.workspaceId, scope.workspaceId),
          ...(options.reason === undefined ? [] : [eq(suppressions.reason, options.reason)]),
          ...(options.sourceCampaignId === undefined
            ? []
            : [eq(suppressions.sourceCampaignId, options.sourceCampaignId)]),
          // `citext` makes the comparison case-insensitive already; the
          // wildcards are what make it a search rather than an equality.
          ...(search === null ? [] : [like(suppressions.email, `%${escapeLike(search)}%`)]),
        ),
      )
      .orderBy(desc(suppressions.createdAt))
      .limit(Math.min(Math.max(options.limit ?? 100, 1), 500));

    return rows.map(toRow);
  }

  /**
   * The row for one address, so a repeated suppression can answer with the
   * suppression that already exists rather than an object of a second shape.
   */
  async findByEmail(scope: WorkspaceScope, email: string): Promise<SuppressionRow | null> {
    const [row] = await this.db
      .select()
      .from(suppressions)
      .where(
        and(
          eq(suppressions.workspaceId, scope.workspaceId),
          eq(suppressions.emailHash, suppressionHash(email)),
        ),
      )
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  async isSuppressed(scope: WorkspaceScope, email: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(
        and(
          eq(suppressions.workspaceId, scope.workspaceId),
          eq(suppressions.emailHash, suppressionHash(email)),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }

  /**
   * Which of these addresses are suppressed.
   *
   * One query for the whole batch, indexed on (workspace_id, email_hash).
   * Returns lowercased addresses, so a caller comparing against its own input
   * must lowercase too — which is why the returned set is documented as
   * normalised rather than left to chance.
   */
  async findSuppressed(
    scope: WorkspaceScope,
    emails: readonly string[],
  ): Promise<Set<string>> {
    if (emails.length === 0) return new Set();

    const hashes = emails.map((email) => suppressionHash(email));

    const rows = await this.db
      .select({ email: suppressions.email })
      .from(suppressions)
      .where(
        and(
          eq(suppressions.workspaceId, scope.workspaceId),
          inArray(suppressions.emailHash, hashes),
        ),
      );

    return new Set(rows.map((row) => row.email.trim().toLowerCase()));
  }

  async remove(scope: WorkspaceScope, id: SuppressionId): Promise<boolean> {
    const rows = await this.db
      .delete(suppressions)
      .where(and(eq(suppressions.id, id), eq(suppressions.workspaceId, scope.workspaceId)))
      .returning({ id: suppressions.id });

    return rows.length > 0;
  }

  async countUpTo(
    scope: WorkspaceScope,
    cap = 100_000,
  ): Promise<{ count: number; capped: boolean }> {
    const result = await this.db.execute(
      sql`SELECT count(*)::int AS matched FROM (
            SELECT 1 FROM suppressions
             WHERE workspace_id = ${scope.workspaceId}
             LIMIT ${cap + 1}
          ) capped`,
    );

    const first = (result as unknown as { rows: { matched: number }[] }).rows[0];
    const matched = first?.matched ?? 0;
    return { count: Math.min(matched, cap), capped: matched > cap };
  }
}

function toRow(row: typeof suppressions.$inferSelect): SuppressionRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    reason: row.reason,
    scope: row.scope,
    notes: row.notes,
    sourceCampaignId: row.sourceCampaignId,
    createdAt: row.createdAt,
  };
}

/**
 * Escapes the LIKE metacharacters in a search term.
 *
 * Without it, an address containing `%` matches every row and one
 * containing `_` matches a character it should have matched literally.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}
