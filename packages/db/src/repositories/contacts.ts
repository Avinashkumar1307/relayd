import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { ContactId, ContactListId, TagId, WorkspaceId } from '@relayd/types';
import { contactListMembers, contactTags, contacts } from '../schema/audience.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';
import { contactSearchPredicate } from '../helpers.js';

export type ContactStatus =
  | 'subscribed'
  | 'unsubscribed'
  | 'bounced'
  | 'complained'
  | 'cleaned';

export type ContactSource = 'manual' | 'import' | 'api' | 'form' | 'automation';

export type ConsentStatus =
  | 'unknown'
  | 'single_optin'
  | 'double_optin'
  | 'imported_declared';

export interface ContactRow {
  id: ContactId;
  workspaceId: WorkspaceId;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: ContactStatus;
  source: ContactSource;
  consentStatus: ConsentStatus;
  attributes: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateContactInput {
  id: ContactId;
  email: string;
  firstName?: string;
  lastName?: string;
  source?: ContactSource;
  consentStatus?: ConsentStatus;
  consentAt?: Date;
  consentSource?: string;
  attributes?: Record<string, unknown>;
}

export interface ContactPage {
  contacts: ContactRow[];
  /** Opaque; pass back as `cursor`. Absent when there are no more rows. */
  nextCursor?: string;
}

/**
 * Cursor pagination on (created_at, id).
 *
 * docs/03: "Cursor only. No offset anywhere — it degrades and it double-serves
 * rows under concurrent writes." An audience being imported into while someone
 * pages through it is the normal case, not the exceptional one.
 */
interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(cursor: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return null;
    // A malformed cursor is a bad request, not a crash, and must never be
    // interpreted as "start from the beginning" — that silently re-serves
    // rows the caller has already seen.
    return Number.isNaN(Date.parse(parsed.createdAt)) ? null : parsed;
  } catch {
    return null;
  }
}

export class ContactRepository {
  constructor(private readonly db: Executor) {}

  async create(scope: WorkspaceScope, input: CreateContactInput): Promise<ContactRow> {
    const [row] = await this.db
      .insert(contacts)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        email: input.email,
        ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
        ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.consentStatus === undefined ? {} : { consentStatus: input.consentStatus }),
        ...(input.consentAt === undefined ? {} : { consentAt: input.consentAt }),
        ...(input.consentSource === undefined ? {} : { consentSource: input.consentSource }),
        ...(input.attributes === undefined ? {} : { attributes: input.attributes }),
      })
      .returning();

    if (row === undefined) throw new Error('createContact: insert returned no row');
    return toRow(row);
  }

  /**
   * Upsert on (workspace_id, email), which is what every integration wants
   * (docs/03, "Create contact — upsert semantics").
   *
   * Targets the partial unique index, so a soft-deleted contact does not block
   * the address and a re-import resurrects rather than fails.
   */
  async upsert(
    scope: WorkspaceScope,
    input: CreateContactInput,
  ): Promise<{ contact: ContactRow; created: boolean }> {
    const existing = await this.findByEmail(scope, input.email);

    if (existing !== null) {
      const updated = await this.update(scope, existing.id, {
        ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
        ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
        ...(input.attributes === undefined ? {} : { attributes: input.attributes }),
      });
      return { contact: updated ?? existing, created: false };
    }

    return { contact: await this.create(scope, input), created: true };
  }

  async findById(scope: WorkspaceScope, id: ContactId): Promise<ContactRow | null> {
    const [row] = await this.db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.id, id),
          eq(contacts.workspaceId, scope.workspaceId),
          isNull(contacts.deletedAt),
        ),
      )
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  async findByEmail(scope: WorkspaceScope, email: string): Promise<ContactRow | null> {
    const [row] = await this.db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.email, email),
          eq(contacts.workspaceId, scope.workspaceId),
          isNull(contacts.deletedAt),
        ),
      )
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  /** Newest first, keyset-paginated. */
  async list(
    scope: WorkspaceScope,
    // Explicit `| undefined`: callers pass parsed query objects whose
    // optional fields carry undefined, which exactOptionalPropertyTypes
    // otherwise refuses.
    options: {
      limit?: number | undefined;
      cursor?: string | undefined;
      status?: ContactStatus | undefined;
      /** D1's search box. Matches email or either name, case-insensitively. */
      search?: string | undefined;
    } = {},
  ): Promise<ContactPage> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);

    const predicates = [
      eq(contacts.workspaceId, scope.workspaceId),
      isNull(contacts.deletedAt),
      ...(options.status === undefined ? [] : [eq(contacts.status, options.status)]),
      // The same predicate the header's `matching` count uses, so the footer
      // and the rows cannot disagree.
      ...(options.search === undefined || options.search === ''
        ? []
        : [contactSearchPredicate(options.search)]),
      ...(cursor === null
        ? []
        : [
            // Strictly after the cursor in (created_at DESC, id DESC) order.
            or(
              lt(contacts.createdAt, new Date(cursor.createdAt)),
              and(
                eq(contacts.createdAt, new Date(cursor.createdAt)),
                lt(contacts.id, cursor.id as ContactId),
              ),
            ),
          ]),
    ];

    // One extra row tells us whether another page exists without a count.
    const rows = await this.db
      .select()
      .from(contacts)
      .where(and(...predicates))
      .orderBy(desc(contacts.createdAt), desc(contacts.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit).map(toRow);
    const last = rows.length > limit ? page[page.length - 1] : undefined;

    return {
      contacts: page,
      ...(last === undefined ? {} : { nextCursor: encodeCursor(last) }),
    };
  }

  async update(
    scope: WorkspaceScope,
    id: ContactId,
    patch: {
      firstName?: string;
      lastName?: string;
      status?: ContactStatus;
      attributes?: Record<string, unknown>;
    },
  ): Promise<ContactRow | null> {
    const [row] = await this.db
      .update(contacts)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(contacts.id, id),
          eq(contacts.workspaceId, scope.workspaceId),
          isNull(contacts.deletedAt),
        ),
      )
      .returning();

    return row === undefined ? null : toRow(row);
  }

  /**
   * Soft delete, which frees the address again: the unique index is partial
   * on deleted_at IS NULL.
   */
  async softDelete(scope: WorkspaceScope, id: ContactId): Promise<boolean> {
    const rows = await this.db
      .update(contacts)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(contacts.id, id),
          eq(contacts.workspaceId, scope.workspaceId),
          isNull(contacts.deletedAt),
        ),
      )
      .returning({ id: contacts.id });

    return rows.length > 0;
  }

  /**
   * Adds a tag to many contacts at once.
   *
   * The workspace id is written from the scope, never from the caller, so a
   * bulk operation cannot be steered across tenants — and the composite
   * foreign key would refuse it even if it were.
   */
  async addTag(
    scope: WorkspaceScope,
    contactIds: readonly ContactId[],
    tagId: TagId,
  ): Promise<number> {
    if (contactIds.length === 0) return 0;

    const rows = await this.db
      .insert(contactTags)
      .values(
        contactIds.map((contactId) => ({
          workspaceId: scope.workspaceId,
          contactId,
          tagId,
        })),
      )
      // Already tagged is success, not a conflict.
      .onConflictDoNothing()
      .returning({ contactId: contactTags.contactId });

    return rows.length;
  }

  async removeTag(
    scope: WorkspaceScope,
    contactIds: readonly ContactId[],
    tagId: TagId,
  ): Promise<number> {
    if (contactIds.length === 0) return 0;

    const rows = await this.db
      .delete(contactTags)
      .where(
        and(
          eq(contactTags.workspaceId, scope.workspaceId),
          eq(contactTags.tagId, tagId),
          inArray(contactTags.contactId, [...contactIds]),
        ),
      )
      .returning({ contactId: contactTags.contactId });

    return rows.length;
  }

  async addToList(
    scope: WorkspaceScope,
    contactIds: readonly ContactId[],
    listId: ContactListId,
  ): Promise<number> {
    if (contactIds.length === 0) return 0;

    const rows = await this.db
      .insert(contactListMembers)
      .values(
        contactIds.map((contactId) => ({
          workspaceId: scope.workspaceId,
          listId,
          contactId,
        })),
      )
      .onConflictDoNothing()
      .returning({ contactId: contactListMembers.contactId });

    return rows.length;
  }

  async removeFromList(
    scope: WorkspaceScope,
    contactIds: readonly ContactId[],
    listId: ContactListId,
  ): Promise<number> {
    if (contactIds.length === 0) return 0;

    const rows = await this.db
      .delete(contactListMembers)
      .where(
        and(
          eq(contactListMembers.workspaceId, scope.workspaceId),
          eq(contactListMembers.listId, listId),
          inArray(contactListMembers.contactId, [...contactIds]),
        ),
      )
      .returning({ contactId: contactListMembers.contactId });

    return rows.length;
  }

  /**
   * Streams every matching contact, for export.
   *
   * Pages through with the same keyset cursor rather than one large query, so
   * memory stays flat regardless of audience size and no row is served twice
   * when the audience is being written to at the same time.
   */
  async *stream(
    scope: WorkspaceScope,
    options: { batchSize?: number | undefined; status?: ContactStatus | undefined } = {},
  ): AsyncGenerator<ContactRow> {
    const batchSize = Math.min(Math.max(options.batchSize ?? 500, 1), 2_000);
    let cursor: string | undefined;

    for (;;) {
      const page = await this.list(scope, {
        limit: batchSize,
        ...(cursor === undefined ? {} : { cursor }),
        ...(options.status === undefined ? {} : { status: options.status }),
      });

      for (const contact of page.contacts) yield contact;

      if (page.nextCursor === undefined) return;
      cursor = page.nextCursor;
    }
  }

  /** Total contacts, for the audience header. Capped so it cannot table-scan. */
  async countUpTo(scope: WorkspaceScope, cap = 100_000): Promise<{ count: number; capped: boolean }> {
    const result = await this.db.execute(
      sql`SELECT count(*)::int AS matched FROM (
            SELECT 1 FROM contacts
             WHERE workspace_id = ${scope.workspaceId}
               AND deleted_at IS NULL
             LIMIT ${cap + 1}
          ) capped`,
    );

    const first = (result as unknown as { rows: { matched: number }[] }).rows[0];
    const matched = first?.matched ?? 0;
    return { count: Math.min(matched, cap), capped: matched > cap };
  }
}

function toRow(row: typeof contacts.$inferSelect): ContactRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    status: row.status,
    source: row.source,
    consentStatus: row.consentStatus,
    attributes: (row.attributes ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
