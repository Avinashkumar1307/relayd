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
import type {
  ContactListRepository,
  ContactRepository,
  ContactRow,
  ImportJobRepository,
  SegmentRepository,
  SuppressionRepository,
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
    },
  ) {
    return this.options.unitOfWork((repos) => repos.contacts.list(scope, options));
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

  async listLists(scope: WorkspaceScope) {
    return this.options.unitOfWork((repos) => repos.lists.list(scope));
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

  async listTags(scope: WorkspaceScope) {
    return this.options.unitOfWork((repos) => repos.tags.list(scope));
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
