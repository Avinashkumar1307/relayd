import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
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
  /**
   * F1's Active / Archived tabs.
   *
   * Exposed as a boolean rather than the timestamp: nothing above this layer
   * has a use for *when* a template was archived, and a nullable date read as
   * a flag is how `if (template.archivedAt)` eventually becomes
   * `if (template.archivedAt !== undefined)` against a row that always has
   * the key.
   */
  archived: boolean;
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

  /**
   * Every template in the workspace, archived ones included.
   *
   * F1 draws Active and Archived as two tabs over one list and filters in
   * the browser, so filtering here would empty the second tab. The `archived`
   * flag on each row is what the tabs split on.
   */
  async list(scope: WorkspaceScope, options: { limit?: number } = {}): Promise<TemplateRow[]> {
    const rows = await this.db
      .select()
      .from(templates)
      .where(and(eq(templates.workspaceId, scope.workspaceId), isNull(templates.deletedAt)))
      .orderBy(desc(templates.updatedAt))
      .limit(Math.min(Math.max(options.limit ?? 50, 1), 200));

    return rows.map(toTemplate);
  }

  /**
   * The names already in use that begin with `prefix`, for picking a free
   * name for a duplicate.
   *
   * `uq_template_name` is unique per workspace on non-deleted rows, so
   * "Autumn escapes (copy)" fails with a 23505 the second time somebody
   * duplicates the same template. One read of the neighbourhood is cheaper
   * and far more legible than catching a constraint violation inside a
   * transaction that would then have to be rolled back to a savepoint.
   *
   * The read is advisory, not a guarantee: two duplicates racing can still
   * both pick the same name, and the unique index is what actually decides.
   * The service turns that loss into a 409 rather than a 500.
   */
  async listNamesLike(scope: WorkspaceScope, prefix: string): Promise<string[]> {
    const rows = await this.db
      .select({ name: templates.name })
      .from(templates)
      .where(
        and(
          eq(templates.workspaceId, scope.workspaceId),
          isNull(templates.deletedAt),
          // `like` with an escaped prefix: a template named "50% off" must
          // not turn its own name into a wildcard.
          sql`${templates.name} LIKE ${`${escapeLike(prefix)}%`} ESCAPE '\\'`,
        ),
      )
      .limit(200);

    return rows.map((row) => row.name);
  }

  /**
   * Archives a template. Guarded, so archiving twice reports honestly.
   *
   * Not a delete: the row stays readable, `uq_template_name` keeps its name
   * reserved, and a campaign that pinned one of its versions still renders.
   */
  async archive(scope: WorkspaceScope, id: TemplateId): Promise<TemplateRow | null> {
    const [row] = await this.db
      .update(templates)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(templates.id, id),
          eq(templates.workspaceId, scope.workspaceId),
          isNull(templates.deletedAt),
          isNull(templates.archivedAt),
        ),
      )
      .returning();

    return row === undefined ? null : toTemplate(row);
  }

  /** The inverse, guarded the same way. */
  async unarchive(scope: WorkspaceScope, id: TemplateId): Promise<TemplateRow | null> {
    const [row] = await this.db
      .update(templates)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(templates.id, id),
          eq(templates.workspaceId, scope.workspaceId),
          isNull(templates.deletedAt),
          isNotNull(templates.archivedAt),
        ),
      )
      .returning();

    return row === undefined ? null : toTemplate(row);
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

/** `LIKE` metacharacters, so a template named "50% off" matches itself only. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
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
    archived: row.archivedAt !== null,
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
