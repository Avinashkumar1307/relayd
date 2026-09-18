import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { TemplateId, TemplateVersionId, UserId, WorkspaceId } from '@relayd/types';
import { templates, templateVersions } from '../schema/templates.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * Templates and their versions.
 *
 * The rule the database enforces and this file respects: a version with
 * `publishedAt` set cannot be modified. The trigger in migration 0007 raises
 * on any UPDATE to such a row, so nothing here needs to remember — but
 * `updateDraft` is guarded anyway, so the caller gets a clear answer rather
 * than a database exception surfacing three layers up.
 */

export interface TemplateRow {
  id: TemplateId;
  workspaceId: WorkspaceId;
  name: string;
  category: string | null;
  currentVersionId: TemplateVersionId | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TemplateVersionRow {
  id: TemplateVersionId;
  workspaceId: WorkspaceId;
  templateId: TemplateId;
  version: number;
  subject: string;
  preheader: string | null;
  htmlSource: string;
  htmlCompiled: string;
  textBody: string;
  variables: unknown;
  publishedAt: Date | null;
  createdAt: Date;
}

export class TemplateRepository {
  constructor(private readonly db: Executor) {}

  async create(
    scope: WorkspaceScope,
    input: { id: TemplateId; name: string; category?: string; createdBy?: UserId },
  ): Promise<TemplateRow> {
    const [row] = await this.db
      .insert(templates)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        name: input.name,
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      })
      .returning();

    if (row === undefined) throw new Error('createTemplate: insert returned no row');
    return toTemplate(row);
  }

  async findById(scope: WorkspaceScope, id: TemplateId): Promise<TemplateRow | null> {
    const [row] = await this.db
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.id, id),
          eq(templates.workspaceId, scope.workspaceId),
          isNull(templates.deletedAt),
        ),
      )
      .limit(1);

    return row === undefined ? null : toTemplate(row);
  }

  async list(scope: WorkspaceScope, options: { limit?: number } = {}): Promise<TemplateRow[]> {
    const rows = await this.db
      .select()
      .from(templates)
      .where(and(eq(templates.workspaceId, scope.workspaceId), isNull(templates.deletedAt)))
      .orderBy(desc(templates.updatedAt))
      .limit(Math.min(Math.max(options.limit ?? 50, 1), 200));

    return rows.map(toTemplate);
  }

  async rename(
    scope: WorkspaceScope,
    id: TemplateId,
    name: string,
  ): Promise<TemplateRow | null> {
    const [row] = await this.db
      .update(templates)
      .set({ name, updatedAt: new Date() })
      .where(
        and(
          eq(templates.id, id),
          eq(templates.workspaceId, scope.workspaceId),
          isNull(templates.deletedAt),
        ),
      )
      .returning();

    return row === undefined ? null : toTemplate(row);
  }

  /**
   * Soft delete.
   *
   * Never hard: a sent campaign references the version it rendered, and
   * removing the template would take the version with it and leave the
   * campaign report describing content that no longer exists.
   */
  async softDelete(scope: WorkspaceScope, id: TemplateId): Promise<boolean> {
    const rows = await this.db
      .update(templates)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(templates.id, id),
          eq(templates.workspaceId, scope.workspaceId),
          isNull(templates.deletedAt),
        ),
      )
      .returning({ id: templates.id });

    return rows.length > 0;
  }

  // ---------------------------------------------------------------- versions

  /**
   * Creates the next version of a template.
   *
   * The number comes from a subquery rather than a read followed by a write,
   * so two concurrent saves cannot both decide they are version 4. If they
   * race anyway the unique index on (template_id, version) rejects one, which
   * is the durable guarantee.
   */
  async createVersion(
    scope: WorkspaceScope,
    input: {
      id: TemplateVersionId;
      templateId: TemplateId;
      subject: string;
      preheader?: string | null;
      htmlSource: string;
      htmlCompiled: string;
      textBody: string;
      variables: unknown;
      createdBy?: UserId;
    },
  ): Promise<TemplateVersionRow> {
    const nextVersion = sql<number>`(
      SELECT COALESCE(MAX(${templateVersions.version}), 0) + 1
      FROM ${templateVersions}
      WHERE ${templateVersions.templateId} = ${input.templateId}
    )`;

    const [row] = await this.db
      .insert(templateVersions)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        templateId: input.templateId,
        version: nextVersion,
        subject: input.subject,
        preheader: input.preheader ?? null,
        htmlSource: input.htmlSource,
        htmlCompiled: input.htmlCompiled,
        textBody: input.textBody,
        variables: input.variables,
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      })
      .returning();

    if (row === undefined) throw new Error('createVersion: insert returned no row');
    return toVersion(row);
  }

  async findVersion(
    scope: WorkspaceScope,
    id: TemplateVersionId,
  ): Promise<TemplateVersionRow | null> {
    const [row] = await this.db
      .select()
      .from(templateVersions)
      .where(
        and(eq(templateVersions.id, id), eq(templateVersions.workspaceId, scope.workspaceId)),
      )
      .limit(1);

    return row === undefined ? null : toVersion(row);
  }

  async listVersions(
    scope: WorkspaceScope,
    templateId: TemplateId,
  ): Promise<TemplateVersionRow[]> {
    const rows = await this.db
      .select()
      .from(templateVersions)
      .where(
        and(
          eq(templateVersions.templateId, templateId),
          eq(templateVersions.workspaceId, scope.workspaceId),
        ),
      )
      .orderBy(desc(templateVersions.version));

    return rows.map(toVersion);
  }

  /**
   * Edits a draft.
   *
   * Guarded on `published_at IS NULL`. The trigger would refuse anyway, but a
   * guarded update returns zero rows, which the service turns into a 409 —
   * rather than a Postgres exception escaping as a 500.
   */
  async updateDraft(
    scope: WorkspaceScope,
    id: TemplateVersionId,
    patch: {
      subject?: string;
      preheader?: string | null;
      htmlSource?: string;
      htmlCompiled?: string;
      textBody?: string;
      variables?: unknown;
    },
  ): Promise<TemplateVersionRow | null> {
    const [row] = await this.db
      .update(templateVersions)
      .set(patch)
      .where(
        and(
          eq(templateVersions.id, id),
          eq(templateVersions.workspaceId, scope.workspaceId),
          isNull(templateVersions.publishedAt),
        ),
      )
      .returning();

    return row === undefined ? null : toVersion(row);
  }

  /**
   * Publishes a draft, and points the template at it.
   *
   * Guarded the same way, so publishing twice is a no-op rather than a second
   * timestamp. Returns null when the version was already published.
   */
  async publish(
    scope: WorkspaceScope,
    id: TemplateVersionId,
    publishedBy?: UserId,
  ): Promise<TemplateVersionRow | null> {
    const [row] = await this.db
      .update(templateVersions)
      .set({
        publishedAt: new Date(),
        ...(publishedBy === undefined ? {} : { publishedBy }),
      })
      .where(
        and(
          eq(templateVersions.id, id),
          eq(templateVersions.workspaceId, scope.workspaceId),
          isNull(templateVersions.publishedAt),
        ),
      )
      .returning();

    if (row === undefined) return null;

    await this.db
      .update(templates)
      .set({ currentVersionId: id, updatedAt: new Date() })
      .where(
        and(eq(templates.id, row.templateId), eq(templates.workspaceId, scope.workspaceId)),
      );

    return toVersion(row);
  }
}

function toTemplate(row: typeof templates.$inferSelect): TemplateRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    category: row.category,
    currentVersionId: row.currentVersionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toVersion(row: typeof templateVersions.$inferSelect): TemplateVersionRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    templateId: row.templateId,
    version: row.version,
    subject: row.subject,
    preheader: row.preheader,
    htmlSource: row.htmlSource,
    htmlCompiled: row.htmlCompiled,
    textBody: row.textBody,
    variables: row.variables,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
  };
}
