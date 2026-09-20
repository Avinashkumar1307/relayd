import { AppError } from '@relayd/types';
import type {
  ContactId,
  ContactListId,
  ImportJobId,
  SegmentId,
  SuppressionId,
  TagId,
  UserId,
} from '@relayd/types';
import { compilePreviewCount, SegmentAstError } from '@relayd/audience';
import { BASE_VIEW_KEYS, savedViewKeyFor } from '@relayd/validation';
import type {
  CreateExportRequest,
  CreateSavedViewRequest,
  SavedViewFilters,
} from '@relayd/validation';
import type {
  AudienceStatsRepository,
  ConsentRepository,
  ContactListRepository,
  ContactRepository,
  ContactRow,
  ExportJobRepository,
  ExportResource,
  ImportJobRepository,
  ListRow,
  SavedViewRepository,
  SegmentRepository,
  SuppressionRepository,
  TagMergeRepository,
  TagRepository,
  WorkspaceScope,
} from '@relayd/db';
import { AUDIT_ACTIONS_AUDIENCE, buildAuditEntry, type Actor } from './audit.js';
import type { AuditLogRepository } from '@relayd/db';

export interface AudienceRepositories {
  contacts: ContactRepository;
  lists: ContactListRepository;
  tags: TagRepository;
  segments: SegmentRepository;
  suppressions: SuppressionRepository;
  imports: ImportJobRepository;
  auditLogs: AuditLogRepository;
  consent: ConsentRepository;
  /** D1's saved-view tabs (migration 0020). */
  savedViews: SavedViewRepository;
  /** The Export button's durable record of what was asked for. */
  exports: ExportJobRepository;
  /** D1's header counts, D4's tag counts, D7's summary. */
  stats: AudienceStatsRepository;
  /** The one write that touches four tables at once. */
  tagMerge: TagMergeRepository;
}

/** D1's header line. */
export interface AudienceStatsDto {
  contacts: number;
  subscribed: number;
  suppressed: number;
  /** Rows the current filter matches — the footer's "1–8 of 48,213". */
  matching: number;
}

/** A saved view, drawn as a tab on D1. */
export interface SavedViewDto {
  key: string;
  label: string;
  status?: ContactRow['status'];
}

/** A list as D3's card draws it. */
export interface ListCardDto {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: Date;
  archived: boolean;
  /** "Archived 1 Sep 2026", or the member count while the list is active. */
  footnote: string;
  /** Not computed yet; see the note on `listLists`. */
  growth30d: number | null;
  trend: number[];
}

/** A tag as D4's table and its merge dialog draw it. */
export interface TagCardDto {
  id: string;
  name: string;
  color: string | null;
  createdAt: Date;
  contactCount: number;
  /** Segment names that reference this tag. */
  segments: string[];
}

export interface SuppressionSummaryDto {
  total: number;
  byReason: { reason: string; count: number }[];
}

export type AudienceUnitOfWork = <T>(
  fn: (repos: AudienceRepositories) => Promise<T>,
) => Promise<T>;

/**
 * Where an uploaded import file lives.
 *
 * Abstracted because production uses S3 with a presigned PUT and local
 * development has no object store at all. The importer streams from whatever
 * this returns, so swapping the implementation changes nothing downstream.
 */
export interface FileStorage {
  /** A URL the browser can upload to directly, plus the key to record. */
  createUploadUrl(input: {
    key: string;
    contentType: string;
    byteSize: number;
  }): Promise<{ uploadUrl: string; key: string; expiresInSeconds: number }>;
}

export interface AudienceServiceOptions {
  unitOfWork: AudienceUnitOfWork;
  storage: FileStorage;
  newId: () => string;
  now: () => Date;
  currentActor: () => Actor;
  /** Hard cap on a segment preview, per BUILD-PLAN Phase 2. */
  previewCap?: number;
}

export class AudienceService {
  constructor(private readonly options: AudienceServiceOptions) {}

  // ---------------------------------------------------------------- contacts

  /**
   * Creates or updates a contact.
   *
   * A suppressed address is accepted rather than rejected, and comes back with
   * status `unsubscribed`. docs/03 is explicit about why: "Writing a suppressed
   * address returns 201 with status unsubscribed rather than an error, because
   * resurrecting a suppression silently would be worse." The caller learns the
   * contact exists; the suppression stays in force.
   */
  async createContact(
    scope: WorkspaceScope,
    input: {
      email: string;
      firstName?: string;
      lastName?: string;
      attributes?: Record<string, unknown>;
      listIds?: string[];
      tagIds?: string[];
      consent?: { status: string; source?: string; at?: Date };
      updateIfExists: boolean;
    },
  ): Promise<{ contact: ContactRow; created: boolean; suppressed: boolean }> {
    return this.options.unitOfWork(async (repos) => {
      const suppressed = await repos.suppressions.isSuppressed(scope, input.email);

      const existing = await repos.contacts.findByEmail(scope, input.email);
      if (existing !== null && !input.updateIfExists) {
        throw new AppError('conflict', 'A contact with that email already exists', 409);
      }

      const consentStatus = input.consent?.status as
        | 'unknown'
        | 'single_optin'
        | 'double_optin'
        | 'imported_declared'
        | undefined;

      const { contact, created } = await repos.contacts.upsert(scope, {
        id: this.options.newId() as ContactId,
        email: input.email,
        source: 'api',
        ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
        ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
        ...(input.attributes === undefined ? {} : { attributes: input.attributes }),
        ...(consentStatus === undefined ? {} : { consentStatus }),
        ...(input.consent?.at === undefined ? {} : { consentAt: input.consent.at }),
        ...(input.consent?.source === undefined ? {} : { consentSource: input.consent.source }),
      });

      // A suppressed contact is recorded as unsubscribed, so nothing
      // downstream has to remember to re-check before a send.
      const final =
        suppressed && contact.status === 'subscribed'
          ? ((await repos.contacts.update(scope, contact.id, { status: 'unsubscribed' })) ??
            contact)
          : contact;

      if (input.listIds !== undefined && input.listIds.length > 0) {
        await repos.contacts.addToList(
          scope,
          [final.id],
          input.listIds[0] as ContactListId,
        );
      }
      for (const tagId of input.tagIds ?? []) {
        await repos.contacts.addTag(scope, [final.id], tagId as TagId);
      }

      await this.audit(repos, scope, {
        action: created
          ? AUDIT_ACTIONS_AUDIENCE.contactCreated
          : AUDIT_ACTIONS_AUDIENCE.contactUpdated,
        resourceType: 'contact',
        resourceId: final.id,
        after: { email: final.email, status: final.status },
      });

      return { contact: final, created, suppressed };
    });
  }

  async listContacts(
    scope: WorkspaceScope,
    // Explicit `| undefined` on each: Zod's optional fields carry it, and
    // under exactOptionalPropertyTypes a bare `?` refuses them.
    options: {
      limit?: number | undefined;
      cursor?: string | undefined;
      status?: ContactRow['status'] | undefined;
      view?: string | undefined;
      q?: string | undefined;
    },
  ) {
    return this.options.unitOfWork(async (repos) => {
      const filter = await this.resolveView(repos, scope, options);
      return repos.contacts.list(scope, {
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...filter,
      });
    });
  }

  /**
   * D1's header line.
   *
   * Takes the same filter the list takes, because `matching` is the footer's
   * "of 48,213" and it has to be the count of the same query that produced
   * the rows. Sharing the filter resolution rather than the numbers: the two
   * are separate requests, so they can disagree by a write that landed
   * between them, and that is a great deal better than disagreeing by
   * construction.
   */
  async stats(
    scope: WorkspaceScope,
    options: {
      status?: ContactRow['status'] | undefined;
      view?: string | undefined;
      q?: string | undefined;
    },
  ): Promise<AudienceStatsDto> {
    return this.options.unitOfWork(async (repos) => {
      const filter = await this.resolveView(repos, scope, options);
      return repos.stats.contactStats(scope, {
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(filter.search === undefined ? {} : { search: filter.search }),
      });
    });
  }

  // -------------------------------------------------------------- saved views

  async listSavedViews(scope: WorkspaceScope): Promise<SavedViewDto[]> {
    return this.options.unitOfWork(async (repos) => {
      const rows = await repos.savedViews.list(scope);
      return rows.map((row) => toSavedViewDto(row.key, row.label, row.filters));
    });
  }

  /**
   * Saves the current filter as a tab.
   *
   * The key is derived from the label and must be free. A silent
   * de-duplicating suffix was tempting and is wrong: two tabs called
   * "Recent" that filter differently are indistinguishable on the strip, and
   * the person who made the second one would never learn why their view does
   * not do what they meant.
   */
  async createSavedView(
    scope: WorkspaceScope,
    input: CreateSavedViewRequest & { createdBy?: UserId },
  ): Promise<SavedViewDto> {
    return this.options.unitOfWork(async (repos) => {
      const key = savedViewKeyFor(input.label);

      if ((BASE_VIEW_KEYS as readonly string[]).includes(key)) {
        throw new AppError(
          'conflict',
          `"${input.label}" is one of the built-in views and cannot be saved over`,
          409,
        );
      }

      const row = await repos.savedViews.create(scope, {
        id: this.options.newId(),
        key,
        label: input.label,
        filters: input.filters,
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      });

      if (row === null) {
        throw new AppError('conflict', `A view called "${input.label}" already exists`, 409);
      }

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_AUDIENCE.savedViewCreated,
        resourceType: 'contact_saved_view',
        resourceId: row.id,
        after: { key: row.key, label: row.label, filters: row.filters },
      });

      return toSavedViewDto(row.key, row.label, row.filters);
    });
  }

  // ----------------------------------------------------------------- exports

  /**
   * Records that somebody asked for an export.
   *
   * The row is the intent and a worker turns it into a file. Nothing drains
   * `export_jobs` yet, so the job stays `pending` — which is true, and is
   * better than returning an id that names nothing at all.
   */
  async startExport(
    scope: WorkspaceScope,
    input: CreateExportRequest & { requestedBy?: UserId },
  ): Promise<{ id: string; status: string }> {
    return this.options.unitOfWork(async (repos) => {
      const job = await repos.exports.create(scope, {
        id: this.options.newId(),
        resource: input.resource as ExportResource,
        filters: {
          ...(input.filters ?? {}),
          ...(input.ids === undefined ? {} : { ids: input.ids }),
        },
        ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
      });

      // An export is a copy of the audience leaving the product. docs/06
      // treats that as a reportable act, so it is audited even though it
      // changes nothing.
      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_AUDIENCE.exportStarted,
        resourceType: 'export_job',
        resourceId: job.id,
        after: {
          resource: job.resource,
          selected: input.ids === undefined ? 'filter' : input.ids.length,
        },
      });

      return { id: job.id, status: job.status };
    });
  }

  async getContact(scope: WorkspaceScope, id: ContactId): Promise<ContactRow> {
    return this.options.unitOfWork(async (repos) => {
      const contact = await repos.contacts.findById(scope, id);
      if (contact === null) throw new AppError('not_found', 'Contact not found', 404);
      return contact;
    });
  }

  async updateContact(
    scope: WorkspaceScope,
    id: ContactId,
    patch: Parameters<ContactRepository['update']>[2],
  ): Promise<ContactRow> {
    return this.options.unitOfWork(async (repos) => {
      const before = await repos.contacts.findById(scope, id);
      if (before === null) throw new AppError('not_found', 'Contact not found', 404);

      const updated = await repos.contacts.update(scope, id, patch);
      if (updated === null) throw new AppError('not_found', 'Contact not found', 404);

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_AUDIENCE.contactUpdated,
        resourceType: 'contact',
        resourceId: id,
        before: { status: before.status },
        after: { status: updated.status },
      });

      return updated;
    });
  }

  async deleteContact(scope: WorkspaceScope, id: ContactId): Promise<void> {
    await this.options.unitOfWork(async (repos) => {
      if (!(await repos.contacts.softDelete(scope, id))) {
        throw new AppError('not_found', 'Contact not found', 404);
      }
      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_AUDIENCE.contactDeleted,
        resourceType: 'contact',
        resourceId: id,
      });
    });
  }

  async bulkTag(
    scope: WorkspaceScope,
    contactIds: string[],
    tagId: string,
    operation: 'add' | 'remove',
  ): Promise<{ affected: number }> {
    return this.options.unitOfWork(async (repos) => {
      const tag = await repos.tags.findById(scope, tagId as TagId);
      if (tag === null) throw new AppError('not_found', 'Tag not found', 404);

      const ids = contactIds as ContactId[];
      const affected =
        operation === 'add'
          ? await repos.contacts.addTag(scope, ids, tag.id)
          : await repos.contacts.removeTag(scope, ids, tag.id);

      await this.audit(repos, scope, {
        action:
          operation === 'add'
            ? AUDIT_ACTIONS_AUDIENCE.contactsTagged
            : AUDIT_ACTIONS_AUDIENCE.contactsUntagged,
        resourceType: 'tag',
        resourceId: tag.id,
        after: { tagName: tag.name, affected },
      });

      return { affected };
    });
  }

  // ------------------------------------------------------------------- lists

  async createList(scope: WorkspaceScope, input: { name: string; description?: string; createdBy?: UserId }) {
    return this.options.unitOfWork(async (repos) => {
      const list = await repos.lists.create(scope, {
        id: this.options.newId() as ContactListId,
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      });

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_AUDIENCE.listCreated,
        resourceType: 'contact_list',
        resourceId: list.id,
        after: { name: list.name },
      });

      return list;
    });
  }

  /**
   * D3's cards.
   *
   * `growth30d` and `trend` are null and empty rather than invented. Both
   * need a daily history of list membership that nothing records today; the
   * card renders without them, and a fabricated sparkline is worse than no
   * sparkline. See the note in the report.
   */
  async listLists(scope: WorkspaceScope): Promise<ListCardDto[]> {
    return this.options.unitOfWork(async (repos) => {
      const rows = await repos.lists.list(scope);
      return rows.map((row) => this.toListCard(row));
    });
  }

  async renameList(
    scope: WorkspaceScope,
    id: ContactListId,
    patch: { name: string; description?: string },
  ): Promise<ListCardDto> {
    return this.options.unitOfWork(async (repos) => {
      const before = await repos.lists.findById(scope, id);
      if (before === null) throw new AppError('not_found', 'List not found', 404);

      // D3 greys the Rename action on an archived card; the server refuses
      // it too, because a disabled button is a suggestion and this is the
      // rule.
      if (before.archivedAt !== null) {
        throw new AppError('conflict', 'An archived list cannot be renamed', 409);
      }

      const updated = await repos.lists.update(scope, id, patch);
      if (updated === null) throw new AppError('not_found', 'List not found', 404);

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_AUDIENCE.listRenamed,
        resourceType: 'contact_list',
        resourceId: id,
        before: { name: before.name },
        after: { name: updated.name },
      });

      return this.toListCard(updated);
    });
  }

  /**
   * Archives a list.
   *
   * Not a delete: campaigns that sent to this list still name it, and an
   * audience that vanishes from a past campaign's report is an audience
   * nobody can audit. The guarded update means archiving twice is a 409
   * rather than a second, later date on the card.
   */
  async archiveList(scope: WorkspaceScope, id: ContactListId): Promise<ListCardDto> {
    return this.options.unitOfWork(async (repos) => {
      const before = await repos.lists.findById(scope, id);
      if (before === null) throw new AppError('not_found', 'List not found', 404);

      const archived = await repos.lists.archive(scope, id, this.options.now());
      if (archived === null) {
        throw new AppError('conflict', 'That list is already archived', 409);
      }

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_AUDIENCE.listArchived,
        resourceType: 'contact_list',
        resourceId: id,
        after: { name: archived.name, memberCount: archived.memberCount },
      });

      return this.toListCard(archived);
    });
  }

  async deleteList(scope: WorkspaceScope, id: ContactListId): Promise<void> {
    await this.options.unitOfWork(async (repos) => {
      if (!(await repos.lists.remove(scope, id))) {
        throw new AppError('not_found', 'List not found', 404);
      }
      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_AUDIENCE.listDeleted,
        resourceType: 'contact_list',
        resourceId: id,
      });
    });
  }

  async changeListMembership(
    scope: WorkspaceScope,
    listId: ContactListId,
    contactIds: string[],
    operation: 'add' | 'remove',
  ): Promise<{ affected: number; memberCount: number }> {
    return this.options.unitOfWork(async (repos) => {
      const list = await repos.lists.findById(scope, listId);
      if (list === null) throw new AppError('not_found', 'List not found', 404);

      const ids = contactIds as ContactId[];
      const affected =
        operation === 'add'
          ? await repos.contacts.addToList(scope, ids, listId)
          : await repos.contacts.removeFromList(scope, ids, listId);

      // member_count is denormalised; recount rather than increment, so a
      // partial failure cannot leave the counter permanently wrong.
      const memberCount = await repos.lists.recountMembers(scope, listId);

      return { affected, memberCount };
    });
  }

  // -------------------------------------------------------------------- tags

  async createTag(scope: WorkspaceScope, input: { name: string; color?: string }) {
    return this.options.unitOfWork((repos) =>
      repos.tags.create(scope, {
        id: this.options.newId() as TagId,
        name: input.name,
        ...(input.color === undefined ? {} : { color: input.color }),
      }),
    );
  }

  /**
   * D4's table, and the rows its merge dialog shows.
   *
   * Three queries rather than one join: a tag's contact count and the
   * segments that reference it aggregate over different tables at different
   * cardinalities, and joining them would multiply one by the other.
   */
  async listTags(scope: WorkspaceScope): Promise<TagCardDto[]> {
    return this.options.unitOfWork(async (repos) => {
      const [rows, counts, segments] = await Promise.all([
        repos.tags.list(scope),
        repos.stats.tagCounts(scope),
        repos.stats.segmentsByTag(scope),
      ]);

      const countFor = new Map(counts.map((row) => [String(row.tagId), row.contactCount]));
      const segmentsFor = new Map<string, string[]>();
      for (const row of segments) {
        const key = String(row.tagId);
        segmentsFor.set(key, [...(segmentsFor.get(key) ?? []), row.name]);
      }

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        createdAt: row.createdAt,
        contactCount: countFor.get(String(row.id)) ?? 0,
        segments: segmentsFor.get(String(row.id)) ?? [],
      }));
    });
  }

  async renameTag(
    scope: WorkspaceScope,
    id: TagId,
    patch: { name?: string; color?: string },
  ): Promise<TagCardDto> {
    return this.options.unitOfWork(async (repos) => {
      const before = await repos.tags.findById(scope, id);
      if (before === null) throw new AppError('not_found', 'Tag not found', 404);

      const updated = await repos.tags.update(scope, id, patch);
      if (updated === null) throw new AppError('not_found', 'Tag not found', 404);

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_AUDIENCE.tagRenamed,
        resourceType: 'tag',
        resourceId: id,
        before: { name: before.name },
        after: { name: updated.name },
      });

      const counts = await repos.stats.tagCounts(scope);
      const segments = await repos.stats.segmentsByTag(scope);

      return {
        id: updated.id,
        name: updated.name,
        color: updated.color,
        createdAt: updated.createdAt,
        contactCount:
          counts.find((row) => String(row.tagId) === String(id))?.contactCount ?? 0,
        segments: segments
          .filter((row) => String(row.tagId) === String(id))
          .map((row) => row.name),
      };
    });
  }

  /**
   * What a merge would produce, before it happens.
   *
   * Every id is checked against the workspace first. Without that, the
   * overlap count for an id belonging to another workspace would be zero
   * rather than an error — which is the same answer as "these tags share
   * nobody", and the caller could not tell the two apart.
   */
  async mergePreview(
    scope: WorkspaceScope,
    tagIds: readonly string[],
  ): Promise<{ total: number; overlap: number }> {
    return this.options.unitOfWork(async (repos) => {
      await this.assertTagsExist(repos, scope, tagIds);
      return repos.stats.mergePreview(scope, tagIds as TagId[]);
    });
  }

  /**
   * Merges tags: one transaction, memberships move, duplicates collapse,
   * the losing tags go.
   *
   * The whole thing runs inside the unit of work, so a failure halfway
   * leaves no contact carrying a tag that no longer exists and no segment
   * pointing at one.
   */
  async mergeTags(
    scope: WorkspaceScope,
    input: { keepId: string; mergeIds: string[] },
  ): Promise<{ keepId: string; contacts: number }> {
    return this.options.unitOfWork(async (repos) => {
      const keep = await repos.tags.findById(scope, input.keepId as TagId);
      if (keep === null) throw new AppError('not_found', 'Tag not found', 404);
      await this.assertTagsExist(repos, scope, input.mergeIds);

      const losing = await Promise.all(
        input.mergeIds.map((id) => repos.tags.findById(scope, id as TagId)),
      );

      const result = await repos.tagMerge.merge(
        scope,
        keep.id,
        input.mergeIds as TagId[],
      );

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_AUDIENCE.tagsMerged,
        resourceType: 'tag',
        resourceId: keep.id,
        // The names, not only the ids: the losing tags no longer exist by
        // the time anybody reads this row, and an audit entry that says
        // "merged four uuids" answers nothing.
        before: { merged: losing.map((tag) => tag?.name ?? 'unknown') },
        after: {
          keptTag: keep.name,
          contacts: result.contacts,
          moved: result.moved,
          collapsed: result.collapsed,
          segmentsRewritten: result.segmentsRewritten,
        },
      });

      return { keepId: keep.id, contacts: result.contacts };
    });
  }

  async deleteTag(scope: WorkspaceScope, id: TagId): Promise<void> {
    await this.options.unitOfWork(async (repos) => {
      if (!(await repos.tags.remove(scope, id))) {
        throw new AppError('not_found', 'Tag not found', 404);
      }
    });
  }

  // ---------------------------------------------------------------- segments

  /**
   * Saves a segment, validating the definition first.
   *
   * Compiling at save time means an invalid definition is refused now rather
   * than stored and then failing every time someone opens it.
   */
  async createSegment(scope: WorkspaceScope, input: { name: string; definition: unknown }) {
    return this.options.unitOfWork(async (repos) => {
      this.assertCompilable(input.definition, scope);

      return repos.segments.create(scope, {
        id: this.options.newId() as SegmentId,
        name: input.name,
        definition: input.definition,
      });
    });
  }

  async listSegments(scope: WorkspaceScope) {
    return this.options.unitOfWork((repos) => repos.segments.list(scope));
  }

  async deleteSegment(scope: WorkspaceScope, id: SegmentId): Promise<void> {
    await this.options.unitOfWork(async (repos) => {
      if (!(await repos.segments.remove(scope, id))) {
        throw new AppError('not_found', 'Segment not found', 404);
      }
    });
  }

  /**
   * Preview count for a saved segment or an unsaved definition.
   *
   * Capped, and the response says whether the cap was hit, so the UI can show
   * "10,000+" rather than a number that took four seconds to be wrong.
   */
  async previewSegment(
    scope: WorkspaceScope,
    input: { segmentId?: SegmentId; definition?: unknown },
  ): Promise<{ count: number; capped: boolean; cap: number }> {
    return this.options.unitOfWork(async (repos) => {
      let definition = input.definition;

      if (input.segmentId !== undefined) {
        const segment = await repos.segments.findById(scope, input.segmentId);
        if (segment === null) throw new AppError('not_found', 'Segment not found', 404);
        definition = segment.definition;
      }

      if (definition === undefined) {
        throw new AppError('validation_failed', 'A segment or a definition is required', 400);
      }

      const cap = this.options.previewCap ?? 10_000;
      const compiled = this.compile(definition, scope, cap);
      const result = await repos.segments.previewCount(scope, compiled);

      if (input.segmentId !== undefined && !result.capped) {
        await repos.segments.cacheCount(scope, input.segmentId, result.count);
      }

      return { ...result, cap };
    });
  }

  // ------------------------------------------------------------ suppressions

  async addSuppression(
    scope: WorkspaceScope,
    input: { email: string; reason: string; notes?: string },
  ) {
    return this.options.unitOfWork(async (repos) => {
      const row = await repos.suppressions.add(scope, {
        id: this.options.newId() as SuppressionId,
        email: input.email,
        reason: input.reason as 'manual',
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      });

      // Suppressing also marks the contact, so a stale contact row cannot
      // read as sendable to anything that has not consulted suppressions.
      const contact = await repos.contacts.findByEmail(scope, input.email);
      if (contact !== null && contact.status === 'subscribed') {
        await repos.contacts.update(scope, contact.id, { status: 'unsubscribed' });
      }

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_AUDIENCE.suppressionAdded,
        resourceType: 'suppression',
        after: { email: input.email, reason: input.reason },
      });

      // Null means it was already suppressed, which is the desired state.
      return row;
    });
  }

  async listSuppressions(scope: WorkspaceScope, options: { limit?: number } = {}) {
    return this.options.unitOfWork((repos) => repos.suppressions.list(scope, options));
  }

  /** D7's counts by reason, and the total it prints beside them. */
  async suppressionSummary(scope: WorkspaceScope): Promise<SuppressionSummaryDto> {
    return this.options.unitOfWork(async (repos) => {
      const byReason = await repos.stats.suppressionSummary(scope);
      return {
        total: byReason.reduce((sum, row) => sum + row.count, 0),
        byReason,
      };
    });
  }

  /**
   * The options D7's Source filter offers.
   *
   * "Any campaign" is prepended here rather than in the browser so that the
   * value the chip sends back (`any`) is defined on the side that has to
   * interpret it.
   *
   * The list is empty until suppressions start carrying the campaign that
   * caused them — see the note on `suppressions.source_campaign_id` in
   * migration 0020. An empty filter is the honest rendering of "nothing has
   * a campaign attached yet".
   */
  async suppressionSources(
    scope: WorkspaceScope,
  ): Promise<{ value: string; label: string }[]> {
    return this.options.unitOfWork(async (repos) => {
      const rows = await repos.stats.suppressionSources(scope);
      return [
        { value: 'any', label: 'Any campaign' },
        ...rows.map((row) => ({ value: row.id, label: row.name })),
      ];
    });
  }

  async removeSuppression(scope: WorkspaceScope, id: SuppressionId): Promise<void> {
    await this.options.unitOfWork(async (repos) => {
      if (!(await repos.suppressions.remove(scope, id))) {
        throw new AppError('not_found', 'Suppression not found', 404);
      }
      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_AUDIENCE.suppressionRemoved,
        resourceType: 'suppression',
        resourceId: id,
      });
    });
  }

  // ----------------------------------------------------------------- imports

  /**
   * Starts an import by handing back a direct upload URL.
   *
   * The file never passes through the API. A 100 MB upload streamed through a
   * request handler occupies a worker for its whole duration and puts the
   * file in memory twice; a presigned PUT costs us nothing and the worker
   * streams it back down when it runs.
   */
  async createImport(
    scope: WorkspaceScope,
    input: { filename: string; byteSize: number; fileType: 'csv' | 'tsv' | 'xlsx'; createdBy?: UserId },
  ) {
    const id = this.options.newId() as ImportJobId;
    const key = `imports/${scope.workspaceId}/${id}/${sanitiseFilename(input.filename)}`;

    const upload = await this.options.storage.createUploadUrl({
      key,
      contentType: contentTypeFor(input.fileType),
      byteSize: input.byteSize,
    });

    return this.options.unitOfWork(async (repos) => {
      const job = await repos.imports.create(scope, {
        id,
        s3Key: upload.key,
        originalFilename: input.filename,
        byteSize: input.byteSize,
        fileType: input.fileType,
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      });

      return { job, upload };
    });
  }

  async getImport(scope: WorkspaceScope, id: ImportJobId) {
    return this.options.unitOfWork(async (repos) => {
      const job = await repos.imports.findById(scope, id);
      if (job === null) throw new AppError('not_found', 'Import not found', 404);
      return job;
    });
  }

  async listImports(scope: WorkspaceScope) {
    return this.options.unitOfWork((repos) => repos.imports.list(scope));
  }

  async listImportErrors(scope: WorkspaceScope, id: ImportJobId, limit?: number) {
    return this.options.unitOfWork(async (repos) => {
      const job = await repos.imports.findById(scope, id);
      if (job === null) throw new AppError('not_found', 'Import not found', 404);
      return repos.imports.listRowErrors(scope, id, limit === undefined ? {} : { limit });
    });
  }

  /**
   * Stores the column mapping and readies the job for the importer.
   *
   * The consent declaration is mandatory and lands in `options`, where the
   * consumer copies it onto every contact the import creates. docs/02: it is
   * what lets a workspace be defended when a provider asks, and what lets one
   * that lied be suspended.
   */
  async setImportMapping(
    scope: WorkspaceScope,
    id: ImportJobId,
    input: {
      mapping: Record<string, string>;
      options: {
        updateExisting: boolean;
        addToListIds: string[];
        tagIds: string[];
        consentDeclaration: string;
        consentSource: string;
      };
    },
  ) {
    return this.options.unitOfWork(async (repos) => {
      const job = await repos.imports.findById(scope, id);
      if (job === null) throw new AppError('not_found', 'Import not found', 404);

      const mapped = Object.values(input.mapping);
      if (!mapped.includes('email')) {
        throw new AppError(
          'validation_failed',
          'One column must be mapped to the email field',
          422,
        );
      }

      const accepted = await repos.imports.setMapping(scope, id, input.mapping, input.options);
      if (!accepted) {
        // Already validating, processing or finished. Re-mapping a running
        // import would change what it is doing halfway through the file.
        throw new AppError(
          'conflict',
          `This import is ${job.status} and its mapping can no longer be changed`,
          409,
        );
      }

      // docs/06: "Every import records a declared consent source ... Stored,
      // timestamped, attributed to a user."
      //
      // A row rather than a field inside `options`, which is where
      // `consentDeclaration` lives (docs/02). The jsonb blob has no
      // timestamp of its own, no attribution, and nothing stopping it being
      // edited later to say something else — which is exactly what it would
      // need to survive to be worth anything in a dispute.
      //
      // No `audienceFingerprint`: the subject here is the file, not an
      // audience. That null is also what stops an import attestation being
      // reused to authorise a campaign launch.
      const actor = this.options.currentActor();

      if (actor.type === 'user' && actor.id !== undefined) {
        await repos.consent.record(scope, {
          id: this.options.newId(),
          subjectKind: 'import',
          subjectId: id,
          source: input.options.consentSource,
          detail: input.options.consentDeclaration,
          attestedBy: actor.id,
        });
      }

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_AUDIENCE.importStarted,
        resourceType: 'import_job',
        resourceId: id,
        after: { mappedColumns: Object.keys(input.mapping).length },
      });

      const updated = await repos.imports.findById(scope, id);
      if (updated === null) throw new AppError('not_found', 'Import not found', 404);
      return updated;
    });
  }

  async cancelImport(scope: WorkspaceScope, id: ImportJobId): Promise<void> {
    await this.options.unitOfWork(async (repos) => {
      const cancelled = await repos.imports.transition(
        scope,
        id,
        ['pending', 'mapping', 'validating', 'processing'],
        'cancelled',
        { completedAt: this.options.now() },
      );

      if (!cancelled) {
        // Already finished, already cancelled, or never existed.
        throw new AppError('conflict', 'This import can no longer be cancelled', 409);
      }
    });
  }

  // ----------------------------------------------------------------- private

  /**
   * Turns `?view=` into the filter it stands for.
   *
   * The view's own filter is the base and the request's explicit `status`
   * and `q` win over it, so typing in the search box while a view is
   * selected narrows the view rather than being silently discarded.
   *
   * An unknown key is a 404, not an empty filter. A tab whose view has been
   * deleted must not quietly become "all contacts" — the reader would see a
   * different audience than the tab's name claims.
   */
  private async resolveView(
    repos: AudienceRepositories,
    scope: WorkspaceScope,
    options: {
      status?: ContactRow['status'] | undefined;
      view?: string | undefined;
      q?: string | undefined;
    },
  ): Promise<{ status?: ContactRow['status']; search?: string }> {
    let stored: SavedViewFilters = {};

    if (options.view !== undefined && !(BASE_VIEW_KEYS as readonly string[]).includes(options.view)) {
      const view = await repos.savedViews.findByKey(scope, options.view);
      if (view === null) throw new AppError('not_found', 'Saved view not found', 404);
      stored = view.filters as SavedViewFilters;
    }

    const status = options.status ?? stored.status;
    const search = options.q ?? stored.q;

    return {
      ...(status === undefined ? {} : { status }),
      ...(search === undefined || search === '' ? {} : { search }),
    };
  }

  /**
   * Every id names a tag in this workspace, or 404.
   *
   * One `findById` per id rather than a batched read: a merge selection is a
   * handful of tags, and the point is the answer per id, not the throughput.
   */
  private async assertTagsExist(
    repos: AudienceRepositories,
    scope: WorkspaceScope,
    tagIds: readonly string[],
  ): Promise<void> {
    for (const id of tagIds) {
      if ((await repos.tags.findById(scope, id as TagId)) === null) {
        throw new AppError('not_found', 'Tag not found', 404);
      }
    }
  }

  private toListCard(row: ListRow): ListCardDto {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      memberCount: row.memberCount,
      createdAt: row.createdAt,
      archived: row.archivedAt !== null,
      footnote:
        row.archivedAt === null
          ? `${row.memberCount.toLocaleString('en-US')} contacts`
          : `Archived ${formatDay(row.archivedAt)}`,
      // Neither is computed: a list's daily membership history is not
      // recorded anywhere, and a made-up sparkline is worse than none.
      growth30d: null,
      trend: [],
    };
  }

  private compile(definition: unknown, scope: WorkspaceScope, cap: number) {
    try {
      return compilePreviewCount(definition, scope.workspaceId, cap);
    } catch (error) {
      if (error instanceof SegmentAstError) {
        throw new AppError('validation_failed', error.message, 400);
      }
      throw error;
    }
  }

  private assertCompilable(definition: unknown, scope: WorkspaceScope): void {
    this.compile(definition, scope, 1);
  }

  private async audit(
    repos: AudienceRepositories,
    scope: WorkspaceScope,
    entry: {
      action: string;
      resourceType: string;
      resourceId?: string;
      before?: unknown;
      after?: unknown;
    },
  ): Promise<void> {
    await repos.auditLogs.append(
      scope,
      buildAuditEntry({
        id: this.options.newId(),
        actor: this.options.currentActor(),
        ...entry,
      }),
    );
  }
}

/**
 * Strips a filename down to something safe to embed in a storage key.
 *
 * The key is built from user input and ends up in a URL path; a filename
 * containing "../" would otherwise let an upload land outside its own prefix.
 */
function sanitiseFilename(filename: string): string {
  return (
    filename
      .replace(/[^A-Za-z0-9._-]/gu, '_')
      .replace(/\.{2,}/gu, '.')
      .slice(-120) || 'upload'
  );
}

/** A stored view row as D1's tab strip wants it. */
function toSavedViewDto(
  key: string,
  label: string,
  filters: { status?: string | undefined },
): SavedViewDto {
  return {
    key,
    label,
    ...(filters.status === undefined
      ? {}
      : { status: filters.status as ContactRow['status'] }),
  };
}

/**
 * "12 Mar 2026" — the date format every D frame prints.
 *
 * Written out rather than left to `Intl`, for the reason the browser copy in
 * `apps/web/src/api/audience-extra.ts` gives: current ICU abbreviates
 * September as "Sept" in en-GB and the frames say "19 Sep 2026", so a date
 * rendered through `Intl` changes spelling when the runtime's ICU is
 * updated. UTC, because the workspace timezone is not modelled yet.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDay(value: Date): string {
  return `${value.getUTCDate()} ${MONTHS[value.getUTCMonth()] ?? ''} ${value.getUTCFullYear()}`;
}

function contentTypeFor(fileType: 'csv' | 'tsv' | 'xlsx'): string {
  switch (fileType) {
    case 'csv':
      return 'text/csv';
    case 'tsv':
      return 'text/tab-separated-values';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
}
