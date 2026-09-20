import { AUDIT_RANGE_DAYS, SYSTEM_ACTOR_ID } from '@relayd/validation';
import type { AuditLogFilters, ListAuditLogsQuery } from '@relayd/validation';
import { MAX_EXPORT_ROWS } from '@relayd/db';
import type {
  AuditLogQuery,
  AuditQueryRepository,
  AuditQueryRow,
  WorkspaceScope,
} from '@relayd/db';

/**
 * Reading the audit log (J6).
 *
 * Deliberately not `services/audit.ts`, which builds the rows every mutating
 * service writes. Nothing here writes; nothing there reads. Merging them
 * would put a filter parser and a CSV renderer in the file that every
 * transaction in the product imports.
 *
 * The shape returned is J6's, not the table's. `audit_logs` stores
 * `actor_type` plus a nullable `actor_id`, and the page shows an avatar and a
 * name; it stores `before` and `after` as jsonb, and the page shows one line
 * of prose. Doing that translation here rather than in the browser means an
 * API consumer gets the same sentence the dashboard shows, and means the
 * initials on the avatar cannot disagree with the name beside it.
 */

export type AuditActorKind = 'user' | 'system' | 'api_key';

export interface AuditEventDto {
  id: string;
  occurredAt: string;
  actor: { kind: AuditActorKind; name: string; initials: string };
  action: string;
  /** The object it happened to. Null for workspace-wide events. */
  resource: string | null;
  /** Beyond J6's columns, so a filter link can be built from a row. */
  resourceType: string;
  details: string;
}

export interface AuditPageDto {
  events: AuditEventDto[];
  /** J6's footer reads "1–10 of 3,412 events", which a cursor cannot say. */
  total: number;
  nextCursor?: string;
}

export interface AuditFilterOptionsDto {
  actors: { id: string; name: string }[];
  actions: string[];
  /** Not offered by J6 today; the `resource` filter accepts one. */
  resourceTypes: string[];
}

export interface AuditLogRepositories {
  auditQuery: AuditQueryRepository;
}

export type AuditLogUnitOfWork = <T>(
  fn: (repos: AuditLogRepositories) => Promise<T>,
) => Promise<T>;

export interface AuditLogServiceOptions {
  unitOfWork: AuditLogUnitOfWork;
  /** Injected so a test need not wait for the clock. */
  now?: () => Date;
  /**
   * The ceiling on one CSV export. `exportRecords` reports when it was hit,
   * so a truncated file is never returned silently.
   */
  maxExportRows?: number;
}

/** The repository's own ceiling, so the two cannot drift apart. */
const DEFAULT_MAX_EXPORT_ROWS = MAX_EXPORT_ROWS;

/** What the export writes, one record per row. */
export interface AuditExportRecord {
  occurredAt: string;
  actorKind: AuditActorKind;
  actor: string;
  action: string;
  resourceType: string;
  resource: string;
  details: string;
  before: string;
  after: string;
}

export class AuditLogService {
  constructor(private readonly options: AuditLogServiceOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * One page and the size of the whole filtered set.
   *
   * The count runs on every request because the page's footer is a count, and
   * it is the reason the default range is thirty days: bounded, it is a walk
   * down `ix_audit_ws_time` rather than a scan of the workspace's history.
   */
  async list(scope: WorkspaceScope, query: ListAuditLogsQuery): Promise<AuditPageDto> {
    const filters = this.toRepositoryQuery(query);
    const offset = query.page === undefined ? 0 : (query.page - 1) * query.limit;

    return this.options.unitOfWork(async (repos) => {
      const page = await repos.auditQuery.list(scope, filters, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(offset === 0 ? {} : { offset }),
      });
      const total = await repos.auditQuery.count(scope, filters);

      return {
        events: page.rows.map((row) => toEvent(row)),
        total,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    });
  }

  /** What the Actor and Action pickers offer. */
  async filterOptions(scope: WorkspaceScope): Promise<AuditFilterOptionsDto> {
    return this.options.unitOfWork(async (repos) => {
      const values = await repos.auditQuery.filterOptions(scope, { now: this.now() });

      const actors: { id: string; name: string }[] = [];
      let hasSystem = false;

      for (const actor of values.actors) {
        if (actor.actorType === 'system' || actor.actorType === 'provider') {
          hasSystem = true;
          continue;
        }
        if (actor.actorId === null) continue;
        // A workspace can hold two actors with the same name; the id is what
        // the filter sends, so it is what de-duplicates.
        if (actors.some((existing) => existing.id === actor.actorId)) continue;
        actors.push({ id: actor.actorId, name: nameFor(actor.actorType, actor.actorName) });
      }

      actors.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      // Relayd last: it is the one actor that is always present and least
      // often what somebody is looking for.
      if (hasSystem) actors.push({ id: SYSTEM_ACTOR_ID, name: 'Relayd' });

      return { actors, actions: values.actions, resourceTypes: values.resourceTypes };
    });
  }

  /**
   * The same query as records, streamed.
   *
   * A generator rather than an array: the route writes each record as it
   * arrives, so neither the rows nor the rendered file is ever held whole in
   * memory. The unit of work stays open for the length of the stream, which
   * is what keeps every chunk inside the one transaction that carries the
   * workspace scope.
   */
  async exportRecords(
    scope: WorkspaceScope,
    filters: AuditLogFilters,
    write: (record: AuditExportRecord) => void | Promise<void>,
  ): Promise<{ rows: number; truncated: boolean }> {
    const query = this.toRepositoryQuery(filters);
    const maxRows = this.options.maxExportRows ?? DEFAULT_MAX_EXPORT_ROWS;

    return this.options.unitOfWork(async (repos) => {
      let rows = 0;

      // One more than the cap, so hitting it is distinguishable from landing
      // exactly on it — a truncated export that does not say so is worse than
      // no export.
      for await (const row of repos.auditQuery.stream(scope, query, { maxRows: maxRows + 1 })) {
        if (rows >= maxRows) return { rows, truncated: true };
        await write(toRecord(row));
        rows += 1;
      }

      return { rows, truncated: false };
    });
  }

  /** Validated filters to the repository's predicate shape. */
  private toRepositoryQuery(filters: AuditLogFilters): AuditLogQuery {
    // Null means `all`: no lower bound, and the one range that cannot use
    // partition pruning. Everything else is a window ending now.
    const days = AUDIT_RANGE_DAYS[filters.range];
    const since = days === null ? undefined : new Date(this.now().getTime() - days * 86_400_000);

    return {
      ...(since === undefined ? {} : { since }),
      ...(filters.actor === undefined
        ? {}
        : filters.actor === SYSTEM_ACTOR_ID
          ? { systemActor: true }
          : { actorId: filters.actor }),
      ...(filters.action === undefined ? {} : { action: filters.action }),
      ...(filters.resource === undefined ? {} : { resource: filters.resource }),
      ...(filters.q === undefined ? {} : { search: filters.q }),
    };
  }
}

/**
 * The four stored actor types collapse to the three J6 draws.
 *
 * `provider` becomes `system` because from the customer's side a bounce
 * applied by SES and a partition created by the scheduler are both "not a
 * person here"; the distinction is kept in the CSV, where there is room.
 */
function kindFor(actorType: AuditQueryRow['actorType']): AuditActorKind {
  if (actorType === 'user') return 'user';
  if (actorType === 'api_key') return 'api_key';
  return 'system';
}

function nameFor(actorType: AuditQueryRow['actorType'], actorName: string | null): string {
  if (actorType === 'system') return 'Relayd';
  if (actorType === 'provider') return 'Provider';
  if (actorName !== null && actorName !== '') return actorName;
  // The actor is gone but the row is not: an audit log that forgets who did
  // something the moment they leave is not an audit log.
  return actorType === 'api_key' ? 'Deleted key' : 'Removed user';
}

/** Up to two letters, from the first and last word. Never empty. */
export function initialsFor(name: string): string {
  const words = name.split(/\s+/u).filter((word) => word !== '');
  const first = words[0]?.[0] ?? '?';
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

const MAX_VALUE_CHARS = 60;
const MAX_DETAIL_CHARS = 240;

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return truncate(value, MAX_VALUE_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return truncate(value.map((item) => renderValue(item)).join(', '), MAX_VALUE_CHARS);
  return truncate(JSON.stringify(value), MAX_VALUE_CHARS);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * One line of prose for the Details column.
 *
 * Built from the payloads the row already carries rather than from a
 * per-action phrase book: every mutating service writes a small curated
 * `after` (a name, a status, a count), so "status: active → suspended" is
 * both accurate and automatic, and a new action added next month gets a
 * sensible line without anybody remembering to add one here.
 */
export function detailsFor(row: Pick<AuditQueryRow, 'action' | 'before' | 'after'>): string {
  const after = asRecord(row.after);
  const before = asRecord(row.before);

  const parts: string[] = [];

  for (const [key, value] of Object.entries(after ?? {})) {
    const previous = before === null ? undefined : before[key];
    parts.push(
      previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)
        ? `${key}: ${renderValue(previous)} → ${renderValue(value)}`
        : `${key}: ${renderValue(value)}`,
    );
  }

  // A deletion carries only `before`. Saying what was removed is the whole
  // value of the row.
  if (after === null && before !== null) {
    for (const [key, value] of Object.entries(before)) {
      parts.push(`${key}: ${renderValue(value)}`);
    }
  }

  return parts.length === 0 ? sentenceFor(row.action) : truncate(parts.join(', '), MAX_DETAIL_CHARS);
}

/** `campaign.launched` with nothing attached reads as "Campaign launched". */
function sentenceFor(action: string): string {
  const words = action.split('.').flatMap((part) => part.split('_')).filter((part) => part !== '');
  const [head, ...rest] = words;
  if (head === undefined) return action;
  return [head.charAt(0).toUpperCase() + head.slice(1), ...rest].join(' ');
}

function toEvent(row: AuditQueryRow): AuditEventDto {
  const name = nameFor(row.actorType, row.actorName);

  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    actor: { kind: kindFor(row.actorType), name, initials: initialsFor(name) },
    action: row.action,
    resource: row.resourceId,
    resourceType: row.resourceType,
    details: detailsFor(row),
  };
}

function toRecord(row: AuditQueryRow): AuditExportRecord {
  const name = nameFor(row.actorType, row.actorName);

  return {
    occurredAt: row.occurredAt.toISOString(),
    actorKind: kindFor(row.actorType),
    actor: name,
    action: row.action,
    resourceType: row.resourceType,
    resource: row.resourceId ?? '',
    details: detailsFor(row),
    // The raw payloads, which is what the export has room for and the screen
    // does not.
    before: row.before === null || row.before === undefined ? '' : JSON.stringify(row.before),
    after: row.after === null || row.after === undefined ? '' : JSON.stringify(row.after),
  };
}
