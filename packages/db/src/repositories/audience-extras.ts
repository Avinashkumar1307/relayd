import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ContactId, ContactListId, TagId, UserId, WorkspaceId } from '@relayd/types';
import {
  contactListMembers,
  contactLists,
  contactSavedViews,
  contactTags,
  exportJobs,
  tags,
} from '../schema/audience.js';
import type { WorkspaceScope } from '../scope.js';
import { contactSearchPredicate } from '../helpers.js';
import type { Executor } from './executor.js';

/**
 * The audience reads and writes section D needs beyond CRUD.
 *
 * A separate file rather than additions to `contacts.ts` and
 * `contact-lists.ts` because these are all aggregates and set operations —
 * they answer "how many" and "which of these overlap", not "give me this
 * row" — and because two of them own tables that arrived in migration 0020.
 *
 * Every method takes a `WorkspaceScope` first and every statement carries an
 * explicit `workspace_id` predicate. RLS is the layer that actually holds,
 * but it is the last one; the predicate is the one a reader can see.
 */

/* --------------------------------------------------------------- saved views */

/**
 * The stored filter carries `| undefined` on each field explicitly: callers
 * hand over a parsed Zod object whose optional fields are present and
 * undefined, which `exactOptionalPropertyTypes` refuses against a bare `?`.
 */
export interface SavedViewFilterValues {
  status?: string | undefined;
  q?: string | undefined;
}

export interface SavedViewRow {
  id: string;
  workspaceId: WorkspaceId;
  key: string;
  label: string;
  filters: SavedViewFilterValues;
  createdAt: Date;
}

export class SavedViewRepository {
  constructor(private readonly db: Executor) {}

  async list(scope: WorkspaceScope): Promise<SavedViewRow[]> {
    const rows = await this.db
      .select()
      .from(contactSavedViews)
      .where(eq(contactSavedViews.workspaceId, scope.workspaceId))
      .orderBy(contactSavedViews.createdAt);

    return rows.map(toSavedView);
  }

  async findByKey(scope: WorkspaceScope, key: string): Promise<SavedViewRow | null> {
    const [row] = await this.db
      .select()
      .from(contactSavedViews)
      .where(
        and(
          eq(contactSavedViews.workspaceId, scope.workspaceId),
          eq(contactSavedViews.key, key),
        ),
      )
      .limit(1);

    return row === undefined ? null : toSavedView(row);
  }

  /**
   * Creates a view, or returns null when the key is taken.
   *
   * Null rather than a thrown constraint error: the caller turns it into a
   * 409 with the key in the message, and a repository that lets a raw
   * Postgres error escape has leaked the table name into the API.
   */
  async create(
    scope: WorkspaceScope,
    input: {
      id: string;
      key: string;
      label: string;
      filters: SavedViewFilterValues;
      createdBy?: UserId;
    },
  ): Promise<SavedViewRow | null> {
    const [row] = await this.db
      .insert(contactSavedViews)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        key: input.key,
        label: input.label,
        filters: input.filters,
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      })
      .onConflictDoNothing()
      .returning();

    return row === undefined ? null : toSavedView(row);
  }
}

function toSavedView(row: typeof contactSavedViews.$inferSelect): SavedViewRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    key: row.key,
    label: row.label,
    filters: (row.filters ?? {}) as SavedViewFilterValues,
    createdAt: row.createdAt,
  };
}

/* --------------------------------------------------------------- export jobs */

export type ExportResource = 'contacts' | 'suppressions' | 'lists' | 'tags' | 'segments';
export type ExportStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ExportJobRow {
  id: string;
  workspaceId: WorkspaceId;
  resource: ExportResource;
  status: ExportStatus;
  filters: Record<string, unknown>;
  rowCount: number | null;
  createdAt: Date;
}

export class ExportJobRepository {
  constructor(private readonly db: Executor) {}

  async create(
    scope: WorkspaceScope,
    input: {
      id: string;
      resource: ExportResource;
      filters: Record<string, unknown>;
      requestedBy?: UserId;
    },
  ): Promise<ExportJobRow> {
    const [row] = await this.db
      .insert(exportJobs)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        resource: input.resource,
        filters: input.filters,
        ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
      })
      .returning();

    if (row === undefined) throw new Error('createExport: insert returned no row');
    return toExportJob(row);
  }

  async findById(scope: WorkspaceScope, id: string): Promise<ExportJobRow | null> {
    const [row] = await this.db
      .select()
      .from(exportJobs)
      .where(and(eq(exportJobs.id, id), eq(exportJobs.workspaceId, scope.workspaceId)))
      .limit(1);

    return row === undefined ? null : toExportJob(row);
  }

  /** Newest first, for an exports panel that does not exist yet. */
  async list(scope: WorkspaceScope, options: { limit?: number } = {}): Promise<ExportJobRow[]> {
    const rows = await this.db
      .select()
      .from(exportJobs)
      .where(eq(exportJobs.workspaceId, scope.workspaceId))
      .orderBy(desc(exportJobs.createdAt))
      .limit(Math.min(Math.max(options.limit ?? 20, 1), 100));

    return rows.map(toExportJob);
  }
}

function toExportJob(row: typeof exportJobs.$inferSelect): ExportJobRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    resource: row.resource,
    status: row.status,
    filters: (row.filters ?? {}) as Record<string, unknown>,
    rowCount: row.rowCount,
    createdAt: row.createdAt,
  };
}

/* ------------------------------------------------------------------ insights */

export interface AudienceStatsRow {
  contacts: number;
  subscribed: number;
  suppressed: number;
  matching: number;
}

export interface TagStatsRow {
  tagId: TagId;
  contactCount: number;
}

export interface TagMergePreviewRow {
  /** Distinct contacts carrying at least one of the tags — the merged total. */
  total: number;
  /** Contacts carrying more than one of them; the rows that collapse. */
  overlap: number;
}

export interface SuppressionSummaryRow {
  reason: string;
  count: number;
}

export interface SuppressionSourceRow {
  id: string;
  name: string;
}

/** One tag on one contact, for D1's Tags column and D2's header chips. */
export interface ContactTagRow {
  contactId: ContactId;
  tagId: TagId;
  name: string;
  color: string | null;
}

/** One list membership, for D1's Lists column and D2's Lists section. */
export interface ContactListNameRow {
  contactId: ContactId;
  listId: ContactListId;
  name: string;
}

/**
 * One line of D2's engagement timeline.
 *
 * Read from `campaign_recipients`, not `email_events`: the recipient row is
 * the per-contact, per-campaign record and is indexed by contact, where the
 * event table is partitioned by time and is the largest in the system. A
 * drawer must not scan it.
 */
export interface ContactActivityRow {
  id: string;
  state: string;
  at: Date;
  campaignName: string;
}

/**
 * Aggregates for D1's header, D4's tag table and D7's summary.
 *
 * Raw SQL rather than the query builder throughout: every one of these is a
 * `FILTER`, a `HAVING` or a `DISTINCT` that Drizzle would render less
 * legibly than it reads here, and all of them are read-only.
 */
export class AudienceStatsRepository {
  constructor(private readonly db: Executor) {}

  /**
   * D1's header line, in one pass.
   *
   * `contacts` and `subscribed` come from a single scan of
   * `ix_contacts_ws_status`; `matching` is the same scan with the page's
   * filter applied, which is why it is a FILTER clause rather than a second
   * query. `suppressed` counts suppression rows, not contacts — an address
   * can be suppressed without ever having been a contact, and D1's
   * "suppressed and never sent to" means exactly that set.
   */
  async contactStats(
    scope: WorkspaceScope,
    filter: { status?: string | undefined; search?: string | undefined } = {},
  ): Promise<AudienceStatsRow> {
    const status = filter.status ?? null;
    const search = filter.search === undefined || filter.search === '' ? null : filter.search;

    const { rows } = await this.db.execute<{
      contacts: number;
      subscribed: number;
      suppressed: number;
      matching: number;
    }>(sql`
      SELECT count(*)::int AS "contacts",
             count(*) FILTER (WHERE status = 'subscribed')::int AS "subscribed",
             count(*) FILTER (
               WHERE (${status}::text IS NULL OR status = ${status}::text)
                 AND (${search}::text IS NULL OR ${contactSearchPredicate(search)})
             )::int AS "matching",
             (SELECT count(*)::int FROM suppressions
               WHERE workspace_id = ${scope.workspaceId}) AS "suppressed"
        FROM contacts
       WHERE workspace_id = ${scope.workspaceId}
         AND deleted_at IS NULL
    `);

    const row = rows[0];
    return {
      contacts: row?.contacts ?? 0,
      subscribed: row?.subscribed ?? 0,
      suppressed: row?.suppressed ?? 0,
      matching: row?.matching ?? 0,
    };
  }

  /**
   * The tags carried by a page of contacts, in one query.
   *
   * Taken as a batch rather than per row: D1 draws fifty contacts and a
   * per-row read would be fifty round trips for one table.
   */
  async tagsForContacts(
    scope: WorkspaceScope,
    contactIds: readonly ContactId[],
  ): Promise<ContactTagRow[]> {
    if (contactIds.length === 0) return [];

    const rows = await this.db
      .select({
        contactId: contactTags.contactId,
        tagId: tags.id,
        name: tags.name,
        color: tags.color,
      })
      .from(contactTags)
      .innerJoin(
        tags,
        and(eq(tags.id, contactTags.tagId), eq(tags.workspaceId, contactTags.workspaceId)),
      )
      .where(
        and(
          eq(contactTags.workspaceId, scope.workspaceId),
          inArray(contactTags.contactId, [...contactIds]),
        ),
      )
      .orderBy(tags.name);

    return rows;
  }

  /** The lists a page of contacts belongs to, in one query. */
  async listsForContacts(
    scope: WorkspaceScope,
    contactIds: readonly ContactId[],
  ): Promise<ContactListNameRow[]> {
    if (contactIds.length === 0) return [];

    const rows = await this.db
      .select({
        contactId: contactListMembers.contactId,
        listId: contactLists.id,
        name: contactLists.name,
      })
      .from(contactListMembers)
      .innerJoin(
        contactLists,
        and(
          eq(contactLists.id, contactListMembers.listId),
          eq(contactLists.workspaceId, contactListMembers.workspaceId),
        ),
      )
      .where(
        and(
          eq(contactListMembers.workspaceId, scope.workspaceId),
          inArray(contactListMembers.contactId, [...contactIds]),
        ),
      )
      .orderBy(contactLists.name);

    return rows;
  }

  /**
   * D2's engagement timeline: what happened to this contact, newest first.
   *
   * `terminal_at` falls back to `sent_at` and then to the row's own
   * `updated_at`, because a recipient that is still queued has neither of
   * the first two and the drawer still has to place it on the timeline.
   */
  async contactActivity(
    scope: WorkspaceScope,
    contactId: ContactId,
    options: { limit?: number } = {},
  ): Promise<ContactActivityRow[]> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

    const { rows } = await this.db.execute<{
      id: string;
      state: string;
      at: Date;
      campaignName: string;
    }>(sql`
      SELECT r.id::text                                          AS "id",
             r.state                                             AS "state",
             COALESCE(r.terminal_at, r.sent_at, r.updated_at)    AS "at",
             c.name                                              AS "campaignName"
        FROM campaign_recipients r
        JOIN campaigns c
          ON c.id = r.campaign_id AND c.workspace_id = r.workspace_id
       WHERE r.workspace_id = ${scope.workspaceId}
         AND r.contact_id = ${contactId}
       ORDER BY COALESCE(r.terminal_at, r.sent_at, r.updated_at) DESC
       LIMIT ${limit}
    `);

    // node-postgres hands back `timestamptz` as a Date already; a driver
    // that hands back a string would otherwise reach the formatter as one.
    return rows.map((row) => ({ ...row, at: new Date(row.at) }));
  }

  /** How many contacts carry each tag, for D4's table and its merge dialog. */
  async tagCounts(scope: WorkspaceScope): Promise<TagStatsRow[]> {
    const { rows } = await this.db.execute<{ tagId: TagId; contactCount: number }>(sql`
      SELECT t.id                 AS "tagId",
             count(ct.contact_id)::int AS "contactCount"
        FROM tags t
        LEFT JOIN contact_tags ct
          ON ct.tag_id = t.id AND ct.workspace_id = t.workspace_id
       WHERE t.workspace_id = ${scope.workspaceId}
       GROUP BY t.id
    `);

    return rows;
  }

  /**
   * Which segments reference each tag, by name.
   *
   * A segment definition is a nested AST, so a `has_tag` node can sit at any
   * depth and jsonb containment cannot find it. The tag id is a UUID, so a
   * text match on the rendered definition finds every reference and cannot
   * plausibly collide with anything else in the document. `segments` holds
   * tens of rows per workspace, so the scan is free.
   */
  async segmentsByTag(scope: WorkspaceScope): Promise<{ tagId: TagId; name: string }[]> {
    const { rows } = await this.db.execute<{ tagId: TagId; name: string }>(sql`
      SELECT t.id AS "tagId", s.name AS "name"
        FROM tags t
        JOIN segments s
          ON s.workspace_id = t.workspace_id
         AND s.definition::text LIKE '%' || t.id::text || '%'
       WHERE t.workspace_id = ${scope.workspaceId}
       ORDER BY s.name
    `);

    return rows;
  }

  /**
   * What a merge would produce, before it happens.
   *
   * `total` is the count the surviving tag would end up with; `overlap` is
   * how many of those already carry two or more of the selected tags, which
   * is the number D4 prints as "had both".
   */
  async mergePreview(
    scope: WorkspaceScope,
    tagIds: readonly TagId[],
  ): Promise<TagMergePreviewRow> {
    if (tagIds.length === 0) return { total: 0, overlap: 0 };

    const { rows } = await this.db.execute<{ total: number; overlap: number }>(sql`
      WITH held AS (
        SELECT contact_id, count(*) AS tags_held
          FROM contact_tags
         WHERE workspace_id = ${scope.workspaceId}
           AND tag_id = ANY(${sql.raw(uuidArray(tagIds))})
         GROUP BY contact_id
      )
      SELECT count(*)::int AS "total",
             count(*) FILTER (WHERE tags_held > 1)::int AS "overlap"
        FROM held
    `);

    const row = rows[0];
    return { total: row?.total ?? 0, overlap: row?.overlap ?? 0 };
  }

  /** D7's counts by reason, and the total it prints beside them. */
  async suppressionSummary(scope: WorkspaceScope): Promise<SuppressionSummaryRow[]> {
    const { rows } = await this.db.execute<{ reason: string; count: number }>(sql`
      SELECT reason, count(*)::int AS "count"
        FROM suppressions
       WHERE workspace_id = ${scope.workspaceId}
       GROUP BY reason
       ORDER BY count(*) DESC, reason
    `);

    return rows;
  }

  /**
   * The campaigns that have produced a suppression, for D7's Source filter.
   *
   * Reads `suppressions.source_campaign_id` (migration 0020) rather than
   * chasing `source_event_id` into `email_events`: that table is partitioned
   * by time and is the largest in the system, and a filter dropdown must not
   * scan it. Empty until the events worker starts writing the column, which
   * is the truthful answer in the meantime.
   */
  async suppressionSources(scope: WorkspaceScope): Promise<SuppressionSourceRow[]> {
    const { rows } = await this.db.execute<{ id: string; name: string }>(sql`
      SELECT DISTINCT c.id::text AS "id", c.name AS "name"
        FROM suppressions s
        JOIN campaigns c
          ON c.id = s.source_campaign_id AND c.workspace_id = s.workspace_id
       WHERE s.workspace_id = ${scope.workspaceId}
       ORDER BY c.name
    `);

    return rows;
  }
}

/* ----------------------------------------------------------------- tag merge */

export interface TagMergeResult {
  /** Memberships moved onto the surviving tag. */
  moved: number;
  /** Memberships dropped because the contact already carried the survivor. */
  collapsed: number;
  /** Segment definitions rewritten to point at the survivor. */
  segmentsRewritten: number;
  /** Contacts carrying the survivor once the merge has run. */
  contacts: number;
}

/**
 * Merging tags.
 *
 * One repository of its own because it is the only write in the audience
 * domain that touches four tables, and because the order of the statements
 * is the correctness argument: collapse first, then move, then rewrite, then
 * delete. Doing the move before the collapse would hit the
 * `(contact_id, tag_id)` primary key on every contact that already carried
 * both.
 *
 * The caller runs it inside the unit-of-work transaction, so either all of
 * it happens or none of it does.
 */
export class TagMergeRepository {
  constructor(private readonly db: Executor) {}

  async merge(
    scope: WorkspaceScope,
    keepId: TagId,
    mergeIds: readonly TagId[],
  ): Promise<TagMergeResult> {
    if (mergeIds.length === 0) {
      return { moved: 0, collapsed: 0, segmentsRewritten: 0, contacts: 0 };
    }

    const losers = sql.raw(uuidArray(mergeIds));

    // 1. Drop the memberships that would collide with one the contact
    //    already has. These are the rows the preview counted as "overlap".
    const collapsed = await this.db.execute(sql`
      DELETE FROM contact_tags ct
       WHERE ct.workspace_id = ${scope.workspaceId}
         AND ct.tag_id = ANY(${losers})
         AND EXISTS (
           SELECT 1 FROM contact_tags keep
            WHERE keep.workspace_id = ct.workspace_id
              AND keep.contact_id = ct.contact_id
              AND keep.tag_id = ${keepId}
         )
    `);

    // 2. Move what is left. Nothing can collide now.
    const moved = await this.db.execute(sql`
      UPDATE contact_tags
         SET tag_id = ${keepId}
       WHERE workspace_id = ${scope.workspaceId}
         AND tag_id = ANY(${losers})
    `);

    // 3. Point every segment that named a losing tag at the survivor.
    //    A UUID is long enough that a textual replace cannot hit anything
    //    else, and the alternative — walking an arbitrarily nested AST in
    //    SQL — is far more to get wrong.
    let segmentsRewritten = 0;
    for (const loser of mergeIds) {
      const result = await this.db.execute(sql`
        UPDATE segments
           SET definition = replace(definition::text, ${loser}::text, ${keepId}::text)::jsonb,
               updated_at = now()
         WHERE workspace_id = ${scope.workspaceId}
           AND definition::text LIKE '%' || ${loser}::text || '%'
      `);
      segmentsRewritten += rowCountOf(result);
    }

    // 4. The losing tags go. contact_tags is already empty of them.
    await this.db.execute(sql`
      DELETE FROM tags
       WHERE workspace_id = ${scope.workspaceId}
         AND id = ANY(${losers})
    `);

    const { rows } = await this.db.execute<{ contacts: number }>(sql`
      SELECT count(*)::int AS "contacts"
        FROM contact_tags
       WHERE workspace_id = ${scope.workspaceId}
         AND tag_id = ${keepId}
    `);

    return {
      moved: rowCountOf(moved),
      collapsed: rowCountOf(collapsed),
      segmentsRewritten,
      contacts: rows[0]?.contacts ?? 0,
    };
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * A UUID array literal for `= ANY(...)`.
 *
 * Built by hand rather than bound, because Drizzle renders a JS array as a
 * parameter list rather than as one array parameter and `ANY` needs the
 * array. Every element is checked against the UUID grammar first, so nothing
 * that is not a UUID can reach the SQL text — which is the only reason this
 * is allowed to be interpolated at all.
 */
function uuidArray(ids: readonly string[]): string {
  const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
  for (const id of ids) {
    if (!UUID.test(id)) throw new Error(`uuidArray: ${JSON.stringify(id)} is not a UUID`);
  }
  return `ARRAY[${ids.map((id) => `'${id}'`).join(',')}]::uuid[]`;
}

/** node-postgres reports affected rows as `rowCount`; Drizzle passes it through. */
function rowCountOf(result: unknown): number {
  const count = (result as { rowCount?: number | null } | undefined)?.rowCount;
  return typeof count === 'number' ? count : 0;
}
