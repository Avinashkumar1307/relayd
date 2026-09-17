import { and, desc, eq, lt } from 'drizzle-orm';
import type { WorkspaceId } from '@relayd/types';
import { auditLogs } from '../schema/identity.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

export type ActorType = 'user' | 'api_key' | 'system' | 'provider';

export interface AuditEntry {
  id: string;
  actorType: ActorType;
  actorId?: string;
  /** Dotted action name: workspace.updated, member.role_changed. */
  action: string;
  resourceType: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export interface AuditRow extends AuditEntry {
  workspaceId: WorkspaceId | null;
  occurredAt: Date;
}

export class AuditLogRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Appends one audit row.
   *
   * Written inside the same transaction as the action it records, so an
   * action cannot commit without its audit trail and an audit row cannot
   * survive a rolled-back action. That is also why the write path must never
   * fail for a recoverable reason — see the DEFAULT partition on audit_logs.
   */
  async append(scope: WorkspaceScope, entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLogs).values({
      id: entry.id,
      workspaceId: scope.workspaceId,
      actorType: entry.actorType,
      action: entry.action,
      resourceType: entry.resourceType,
      ...(entry.actorId === undefined ? {} : { actorId: entry.actorId }),
      ...(entry.resourceId === undefined ? {} : { resourceId: entry.resourceId }),
      ...(entry.before === undefined ? {} : { before: entry.before }),
      ...(entry.after === undefined ? {} : { after: entry.after }),
      ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
      ...(entry.ip === undefined ? {} : { ip: entry.ip }),
      ...(entry.userAgent === undefined ? {} : { userAgent: entry.userAgent }),
    });
  }

  /**
   * Newest first, keyset-paginated on occurred_at.
   *
   * Cursor rather than offset, per docs/03: offset degrades and double-serves
   * rows under concurrent writes, and this table only ever grows.
   */
  async list(
    scope: WorkspaceScope,
    options: { limit?: number; before?: Date } = {},
  ): Promise<AuditRow[]> {
    const limit = Math.min(options.limit ?? 50, 200);

    const predicate =
      options.before === undefined
        ? eq(auditLogs.workspaceId, scope.workspaceId)
        : and(
            eq(auditLogs.workspaceId, scope.workspaceId),
            lt(auditLogs.occurredAt, options.before),
          );

    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(predicate)
      .orderBy(desc(auditLogs.occurredAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      actorType: row.actorType,
      action: row.action,
      resourceType: row.resourceType,
      occurredAt: row.occurredAt,
      ...(row.actorId === null ? {} : { actorId: row.actorId }),
      ...(row.resourceId === null ? {} : { resourceId: row.resourceId }),
      ...(row.before === null ? {} : { before: row.before }),
      ...(row.after === null ? {} : { after: row.after }),
      ...(row.requestId === null ? {} : { requestId: row.requestId }),
      ...(row.ip === null ? {} : { ip: row.ip }),
      ...(row.userAgent === null ? {} : { userAgent: row.userAgent }),
    }));
  }
}
