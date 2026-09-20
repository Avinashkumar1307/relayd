import { and, eq, isNull, sql } from 'drizzle-orm';
import type { ContactListId, TagId, UserId, WorkspaceId } from '@relayd/types';
import { contactListMembers, contactLists, contactTags, tags } from '../schema/audience.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

export interface ListRow {
  id: ContactListId;
  workspaceId: WorkspaceId;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: Date;
  /** Set when the list was archived (migration 0020); null while active. */
  archivedAt: Date | null;
}

export class ContactListRepository {
  constructor(private readonly db: Executor) {}

  async create(
    scope: WorkspaceScope,
    input: { id: ContactListId; name: string; description?: string; createdBy?: UserId },
  ): Promise<ListRow> {
    const [row] = await this.db
      .insert(contactLists)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      })
      .returning();

    if (row === undefined) throw new Error('createList: insert returned no row');
    return toListRow(row);
  }

  async list(scope: WorkspaceScope): Promise<ListRow[]> {
    const rows = await this.db
      .select()
      .from(contactLists)
      .where(eq(contactLists.workspaceId, scope.workspaceId));

    return rows.map(toListRow);
  }

  async findById(scope: WorkspaceScope, id: ContactListId): Promise<ListRow | null> {
    const [row] = await this.db
      .select()
      .from(contactLists)
      .where(and(eq(contactLists.id, id), eq(contactLists.workspaceId, scope.workspaceId)))
      .limit(1);

    return row === undefined ? null : toListRow(row);
  }

  async update(
    scope: WorkspaceScope,
    id: ContactListId,
    patch: { name?: string; description?: string },
  ): Promise<ListRow | null> {
    const [row] = await this.db
      .update(contactLists)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(contactLists.id, id), eq(contactLists.workspaceId, scope.workspaceId)))
      .returning();

    return row === undefined ? null : toListRow(row);
  }

  async remove(scope: WorkspaceScope, id: ContactListId): Promise<boolean> {
    const rows = await this.db
      .delete(contactLists)
      .where(and(eq(contactLists.id, id), eq(contactLists.workspaceId, scope.workspaceId)))
      .returning({ id: contactLists.id });

    return rows.length > 0;
  }

  /**
   * Archives a list, once.
   *
   * Guarded on `archived_at IS NULL` and returning the row, so a second
   * archive of the same list reports zero rows rather than silently moving
   * the date forward. D3 prints that date on the card; an idempotent call
   * that rewrote it would change what the card says for no reason.
   *
   * Archiving is deliberately not deleting: the list stays visible and
   * read-only, and anything that referenced it — a campaign's audience, an
   * import's target — still resolves.
   */
  async archive(
    scope: WorkspaceScope,
    id: ContactListId,
    at: Date,
  ): Promise<ListRow | null> {
    const [row] = await this.db
      .update(contactLists)
      .set({ archivedAt: at, updatedAt: at })
      .where(
        and(
          eq(contactLists.id, id),
          eq(contactLists.workspaceId, scope.workspaceId),
          isNull(contactLists.archivedAt),
        ),
      )
      .returning();

    return row === undefined ? null : toListRow(row);
  }

  /**
   * Recomputes member_count from the membership table.
   *
   * The column is denormalised and reconciled rather than maintained
   * transactionally, because a bulk import adding 500,000 memberships must not
   * also serialise 500,000 updates onto one list row. docs/02 marks it
   * "reconciled nightly"; this is that reconciliation, callable on demand.
   */
  async recountMembers(scope: WorkspaceScope, id: ContactListId): Promise<number> {
    const [row] = await this.db
      .update(contactLists)
      .set({
        memberCount: sql<number>`(
          SELECT count(*)::int FROM ${contactListMembers}
           WHERE ${contactListMembers.listId} = ${id}
             AND ${contactListMembers.workspaceId} = ${scope.workspaceId}
        )`,
        updatedAt: new Date(),
      })
      .where(and(eq(contactLists.id, id), eq(contactLists.workspaceId, scope.workspaceId)))
      .returning({ memberCount: contactLists.memberCount });

    return row?.memberCount ?? 0;
  }
}

export interface TagRow {
  id: TagId;
  workspaceId: WorkspaceId;
  name: string;
  color: string | null;
  createdAt: Date;
}

export class TagRepository {
  constructor(private readonly db: Executor) {}

  async create(
    scope: WorkspaceScope,
    input: { id: TagId; name: string; color?: string },
  ): Promise<TagRow> {
    const [row] = await this.db
      .insert(tags)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        name: input.name,
        ...(input.color === undefined ? {} : { color: input.color }),
      })
      .returning();

    if (row === undefined) throw new Error('createTag: insert returned no row');
    return toTagRow(row);
  }

  async list(scope: WorkspaceScope): Promise<TagRow[]> {
    const rows = await this.db.select().from(tags).where(eq(tags.workspaceId, scope.workspaceId));
    return rows.map(toTagRow);
  }

  async findById(scope: WorkspaceScope, id: TagId): Promise<TagRow | null> {
    const [row] = await this.db
      .select()
      .from(tags)
      .where(and(eq(tags.id, id), eq(tags.workspaceId, scope.workspaceId)))
      .limit(1);

    return row === undefined ? null : toTagRow(row);
  }

  /**
   * Renames or recolours a tag.
   *
   * Returns null when the tag is not this workspace's, which the service
   * turns into a 404 — the same answer a non-existent tag gets, so the
   * endpoint cannot be used to discover that another workspace owns an id
   * (docs/06: cross-tenant reads are 404, never 403).
   *
   * A name that collides with another tag in the workspace raises the
   * `uq_tag_name` unique violation rather than being silently ignored; the
   * service maps it to a 409. Silently keeping the old name would leave the
   * dialog showing a rename that did not happen.
   */
  async update(
    scope: WorkspaceScope,
    id: TagId,
    patch: { name?: string; color?: string },
  ): Promise<TagRow | null> {
    const [row] = await this.db
      .update(tags)
      .set(patch)
      .where(and(eq(tags.id, id), eq(tags.workspaceId, scope.workspaceId)))
      .returning();

    return row === undefined ? null : toTagRow(row);
  }

  /** Deleting a tag removes its assignments, by cascade. */
  async remove(scope: WorkspaceScope, id: TagId): Promise<boolean> {
    const rows = await this.db
      .delete(tags)
      .where(and(eq(tags.id, id), eq(tags.workspaceId, scope.workspaceId)))
      .returning({ id: tags.id });

    return rows.length > 0;
  }

  async countAssignments(scope: WorkspaceScope, id: TagId): Promise<number> {
    const rows = await this.db
      .select({ contactId: contactTags.contactId })
      .from(contactTags)
      .where(and(eq(contactTags.tagId, id), eq(contactTags.workspaceId, scope.workspaceId)));

    return rows.length;
  }
}

function toListRow(row: typeof contactLists.$inferSelect): ListRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    memberCount: row.memberCount,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}

function toTagRow(row: typeof tags.$inferSelect): TagRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    color: row.color,
    createdAt: row.createdAt,
  };
}
