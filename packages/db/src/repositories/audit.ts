import { sql, type SQL } from 'drizzle-orm';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * Reading the audit log (J6, docs/03 `/audit-logs`).
 *
 * Deliberately separate from `AuditLogRepository`, which appends. The write
 * side runs inside every mutating transaction in the product and must stay
 * one small insert; the read side is a filtered, joined, paginated query that
 * nothing on the write path should ever have to compile.
 *
 * **Scope.** `audit_logs.workspace_id` is nullable — platform events belong to
 * no workspace — so every predicate here is an equality against the caller's
 * workspace, which excludes the null rows by construction. That agrees with
 * the RLS policy in migration 0003, which is also an equality and therefore
 * also excludes them. Those rows are read by operators through
 * `relayd_global`, never here.
 *
 * **The index.** `ix_audit_ws_time` is `(workspace_id, occurred_at DESC)`.
 * Every query in this file leads with `workspace_id = $1` and orders by
 * `occurred_at DESC`, which is exactly the index's shape, so a page is a walk
 * down it rather than a scan. The tiebreak on `id DESC` is not in the index;
 * it costs an incremental sort within each group of rows sharing a timestamp,
 * which is one or two rows written by the same transaction. That is the price
 * of a cursor that cannot skip or repeat a row, and it is worth paying.
 * `audit_logs` is range-partitioned on `occurred_at`, so the ordered read is a
 * MergeAppend over the per-partition indexes; a bounded range also lets the
 * planner prune every partition outside it, which is why `range` defaults to
 * thirty days rather than to everything.
 */

export type AuditActorType = 'user' | 'api_key' | 'system' | 'provider';

export interface AuditLogQuery {
  /** A user id or an API key id. */
  actorId?: string | undefined;
  /** Rows Relayd or a provider wrote, which carry no actor id. */
  systemActor?: boolean | undefined;
  action?: string | undefined;
  /** Matches one object's id or a whole resource type. */
  resource?: string | undefined;
  /** Lower bound on `occurred_at`. Absent means the whole retained history. */
  since?: Date | undefined;
  /** Substring match over the action, the resource and the payloads. */
  search?: string | undefined;
}

export interface AuditQueryRow {
  id: string;
  occurredAt: Date;
  actorType: AuditActorType;
  actorId: string | null;
  /** The user's or key's name, when it still exists. Null once deleted. */
  actorName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
}

/** As the driver hands it back, before `occurred_at` is normalised to a Date. */
type RawAuditRow = Omit<AuditQueryRow, 'occurredAt'> & { occurredAt: Date | string };

export interface AuditLogPage {
  rows: AuditQueryRow[];
  nextCursor?: string;
}

export interface AuditFilterValues {
  actions: string[];
  resourceTypes: string[];
  actors: { actorType: AuditActorType; actorId: string | null; actorName: string | null }[];
}

/** Keyset position: the last row a page served. */
interface Cursor {
  occurredAt: string;
  id: string;
}

function encodeCursor(row: { occurredAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ occurredAt: row.occurredAt.toISOString(), id: row.id }),
    'utf8',
  ).toString('base64url');
}

/**
 * Reads a cursor, or null if it is not one.
 *
 * Null means no keyset predicate, which is "start from the beginning" — and
 * silently restarting re-serves rows the caller has already read, which in an
 * audit log reads as the same event happening twice. That is why the route
 * refuses an unreadable cursor with a 400 first (`auditCursorSchema` in
 * @relayd/validation); by the time one reaches here it has already parsed.
 * This is the second line, not the first.
 */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.occurredAt !== 'string' || typeof parsed.id !== 'string') return null;
    return Number.isNaN(Date.parse(parsed.occurredAt)) ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * Makes a user's search string a literal for LIKE.
 *
 * Without this, a `%` typed into J6's search box matches everything and a
 * `_` matches any character — not an injection, but a filter that quietly
 * lies about what it matched.
 */
function likeLiteral(value: string): string {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

/** Distinct values are bounded by this window, so a picker cannot scan history. */
const FILTER_OPTION_DAYS = 90;
/** And by this many values, so a workspace with thousands cannot hang the page. */
const FILTER_OPTION_LIMIT = 200;

/** Rows per round trip while streaming an export. */
const DEFAULT_STREAM_CHUNK = 1000;
/** The hard ceiling on one export, so a single request cannot pull a history. */
export const MAX_EXPORT_ROWS = 100_000;

export class AuditQueryRepository {
  constructor(private readonly db: Executor) {}

  /**
   * One page, newest first.
   *
   * `cursor` and `offset` are both accepted because the two callers want
   * different things: the dashboard pages by number and wants a total, an API
   * consumer follows `nextCursor`. Only one is ever set — the route refuses a
   * request carrying both.
   */
  async list(
    scope: WorkspaceScope,
    query: AuditLogQuery,
    paging: { limit: number; cursor?: string | undefined; offset?: number | undefined },
  ): Promise<AuditLogPage> {
    const limit = Math.min(Math.max(paging.limit, 1), 200);
    const cursor = paging.cursor === undefined ? null : decodeCursor(paging.cursor);
    const offset = Math.max(paging.offset ?? 0, 0);

    const where = this.where(scope, query);
    if (cursor !== null) {
      where.push(
        sql`(al.occurred_at, al.id) < (${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    // One extra row answers "is there another page" without a second count.
    const { rows } = await this.db.execute<RawAuditRow>(sql`
      SELECT al.id::text          AS "id",
             al.occurred_at       AS "occurredAt",
             al.actor_type        AS "actorType",
             al.actor_id::text    AS "actorId",
             coalesce(u.name, k.name) AS "actorName",
             al.action            AS "action",
             al.resource_type     AS "resourceType",
             al.resource_id::text AS "resourceId",
             al.before            AS "before",
             al.after             AS "after"
        FROM audit_logs al
        -- users is cross-tenant by design (migration 0003): a person exists
        -- before any workspace. The row being joined from is already this
        -- workspace's, so only actors who acted here are ever named.
        LEFT JOIN users u
          ON al.actor_type = 'user' AND u.id = al.actor_id
        -- api_keys is tenant-owned, so the join carries the workspace too.
        -- Without it a key id colliding across workspaces could supply a name
        -- from somebody else's workspace.
        LEFT JOIN api_keys k
          ON al.actor_type = 'api_key'
         AND k.id = al.actor_id
         AND k.workspace_id = al.workspace_id
       WHERE ${sql.join(where, sql` AND `)}
       ORDER BY al.occurred_at DESC, al.id DESC
       LIMIT ${limit + 1}
      OFFSET ${offset}
    `);

    // The driver returns a Date for timestamptz, but a fake executor in a unit
    // test hands back whatever it was given, so this normalises both.
    const page = rows.slice(0, limit).map((row) => ({
      ...row,
      occurredAt: row.occurredAt instanceof Date ? row.occurredAt : new Date(row.occurredAt),
    }));
    const last = page.at(-1);

    return {
      rows: page,
      ...(rows.length > limit && last !== undefined ? { nextCursor: encodeCursor(last) } : {}),
    };
  }

  /**
   * How many rows match, for J6's "1–10 of 3,412".
   *
   * No join: both joins in `list` are LEFT and narrow nothing, so counting
   * through them would cost two index lookups per row for a number that does
   * not depend on them.
   */
  async count(scope: WorkspaceScope, query: AuditLogQuery): Promise<number> {
    const { rows } = await this.db.execute<{ total: number }>(sql`
      SELECT count(*)::int AS "total"
        FROM audit_logs al
       WHERE ${sql.join(this.where(scope, query), sql` AND `)}
    `);

    return rows[0]?.total ?? 0;
  }

  /**
   * The distinct values the pickers offer.
   *
   * Bounded twice — a ninety-day window and two hundred values — because this
   * is a `DISTINCT` over an append-only table and an unbounded one gets
   * slower every week until somebody notices.
   */
  async filterOptions(scope: WorkspaceScope, options: { now: Date }): Promise<AuditFilterValues> {
    const since = new Date(options.now.getTime() - FILTER_OPTION_DAYS * 86_400_000);
    const window = sql`al.workspace_id = ${scope.workspaceId} AND al.occurred_at >= ${since.toISOString()}::timestamptz`;

    const actions = await this.db.execute<{ action: string }>(sql`
      SELECT DISTINCT al.action AS "action"
        FROM audit_logs al
       WHERE ${window}
       ORDER BY al.action
       LIMIT ${FILTER_OPTION_LIMIT}
    `);

    const resourceTypes = await this.db.execute<{ resourceType: string }>(sql`
      SELECT DISTINCT al.resource_type AS "resourceType"
        FROM audit_logs al
       WHERE ${window}
       ORDER BY al.resource_type
       LIMIT ${FILTER_OPTION_LIMIT}
    `);

    const actors = await this.db.execute<{
      actorType: AuditActorType;
      actorId: string | null;
      actorName: string | null;
    }>(sql`
      SELECT al.actor_type          AS "actorType",
             al.actor_id::text      AS "actorId",
             coalesce(u.name, k.name) AS "actorName"
        FROM (
          SELECT DISTINCT al.actor_type, al.actor_id, al.workspace_id
            FROM audit_logs al
           WHERE ${window}
           ORDER BY al.actor_type, al.actor_id
           LIMIT ${FILTER_OPTION_LIMIT}
        ) al
        LEFT JOIN users u
          ON al.actor_type = 'user' AND u.id = al.actor_id
        LEFT JOIN api_keys k
          ON al.actor_type = 'api_key'
         AND k.id = al.actor_id
         AND k.workspace_id = al.workspace_id
       ORDER BY al.actor_type, "actorName" NULLS LAST
    `);

    return {
      actions: actions.rows.map((row) => row.action),
      resourceTypes: resourceTypes.rows.map((row) => row.resourceType),
      actors: actors.rows,
    };
  }

  /**
   * The same query, as a stream.
   *
   * Keyset chunks rather than one big result: the export must not build the
   * whole file — nor the whole result set — in memory, and a deepening
   * `OFFSET` over an append-only table would get quadratically slower as it
   * went. Capped at `MAX_EXPORT_ROWS`; the caller reports when it truncated.
   */
  async *stream(
    scope: WorkspaceScope,
    query: AuditLogQuery,
    options: { chunkSize?: number | undefined; maxRows?: number | undefined } = {},
  ): AsyncGenerator<AuditQueryRow> {
    const chunkSize = Math.min(Math.max(options.chunkSize ?? DEFAULT_STREAM_CHUNK, 1), 5000);
    const maxRows = Math.min(Math.max(options.maxRows ?? MAX_EXPORT_ROWS, 1), MAX_EXPORT_ROWS);

    let cursor: string | undefined;
    let emitted = 0;

    for (;;) {
      const remaining = maxRows - emitted;
      if (remaining <= 0) return;

      const page = await this.list(scope, query, {
        limit: Math.min(chunkSize, remaining),
        ...(cursor === undefined ? {} : { cursor }),
      });

      for (const row of page.rows) {
        yield row;
        emitted += 1;
      }

      if (page.nextCursor === undefined) return;
      cursor = page.nextCursor;
    }
  }

  /**
   * The shared predicate list.
   *
   * Private, so the scope-reflection scan does not see it as a repository
   * method — and it takes the scope first regardless, because the workspace
   * equality is the first thing in every list it builds.
   */
  private where(scope: WorkspaceScope, query: AuditLogQuery): SQL[] {
    const parts: SQL[] = [sql`al.workspace_id = ${scope.workspaceId}`];

    if (query.since !== undefined) {
      parts.push(sql`al.occurred_at >= ${query.since.toISOString()}::timestamptz`);
    }

    if (query.systemActor === true) {
      parts.push(sql`al.actor_type IN ('system','provider')`);
    } else if (query.actorId !== undefined) {
      parts.push(sql`al.actor_id = ${query.actorId}::uuid`);
    }

    if (query.action !== undefined) {
      parts.push(sql`al.action = ${query.action}`);
    }

    if (query.resource !== undefined) {
      // The column is cast, never the parameter: `'campaign'::uuid` would
      // raise, so filtering by a resource type would be an error instead of a
      // filter.
      parts.push(
        sql`(al.resource_id::text = ${query.resource} OR al.resource_type = ${query.resource})`,
      );
    }

    if (query.search !== undefined) {
      const pattern = likeLiteral(query.search);
      parts.push(sql`(
        al.action ILIKE ${pattern} ESCAPE '\\'
        OR al.resource_type ILIKE ${pattern} ESCAPE '\\'
        OR al.resource_id::text ILIKE ${pattern} ESCAPE '\\'
        OR coalesce(al.before::text, '') ILIKE ${pattern} ESCAPE '\\'
        OR coalesce(al.after::text, '') ILIKE ${pattern} ESCAPE '\\'
      )`);
    }

    return parts;
  }
}
