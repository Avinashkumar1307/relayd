import { compileTemplate, contactValues, renderTemplate } from '@relayd/campaigns';
import type { AuditLogRepository, TemplateRepository, WorkspaceScope } from '@relayd/db';
import { AppError } from '@relayd/types';
import type { TemplateId, TemplateVersionId, UserId } from '@relayd/types';
import { buildAuditEntry, type Actor } from './audit.js';

/**
 * Templates.
 *
 * Two rules run through everything here:
 *
 *   A published version is immutable. The database refuses to modify one, and
 *   this layer turns that refusal into a 409 rather than letting a Postgres
 *   exception escape as a 500.
 *
 *   HTML is compiled on save, never on send. The compiled output is what a
 *   reviewer approved and what a campaign will send; re-compiling later means
 *   a template can change because our allowlist changed.
 */

export interface TemplateRepositories {
  templates: TemplateRepository;
  auditLogs: AuditLogRepository;
}

export type TemplateUnitOfWork = <T>(fn: (repos: TemplateRepositories) => Promise<T>) => Promise<T>;

/**
 * How a test message actually leaves the building.
 *
 * A port rather than a queue handle, and deliberately the same shape as what
 * `ProviderService.testSend` already does: resolve the sender, check its
 * connection and its identity, enqueue. This service does not know what a
 * sender account is and must not learn — duplicating those three checks here
 * is how one copy ends up allowing a send from an identity the other copy
 * would have refused.
 *
 * The API cannot send the message itself in any case: docs/06 gives the API
 * task role permission to *write* provider secrets and not to read them, so
 * only the worker can obtain the credential. A test send is a job.
 *
 * Optional, exactly as `ProviderService.testSends` is: absent in a deployment
 * or a test with no queue, and then the endpoint answers 503 rather than
 * pretending.
 */
export interface TemplateTestSendPort {
  send(
    scope: WorkspaceScope,
    input: {
      /** Omitted means "the workspace's usable sender"; the port decides. */
      senderId?: string | undefined;
      to: readonly string[];
      subject: string;
      html: string;
      text: string;
      templateVersionId: string;
    },
  ): Promise<{ jobId: string; queued: number }>;
}

export interface TemplateServiceOptions {
  unitOfWork: TemplateUnitOfWork;
  newId: () => string;
  currentActor: () => Actor;
  /** Wired to the provider service's test-send path. See the port above. */
  testSends?: TemplateTestSendPort;
}

export const AUDIT_ACTIONS_TEMPLATES = {
  created: 'template.created',
  versionSaved: 'template.version_saved',
  published: 'template.version_published',
  deleted: 'template.deleted',
  archived: 'template.archived',
  unarchived: 'template.unarchived',
  duplicated: 'template.duplicated',
  testSent: 'template.test_sent',
} as const;

/** How many "(copy n)" names to try before giving up and saying so. */
const MAX_COPY_ATTEMPTS = 50;

/** A sample contact, for preview when the author has not chosen one. */
export const SAMPLE_CONTACT = {
  id: 'sample',
  email: 'sam@example.com',
  firstName: 'Sam',
  lastName: 'Rivera',
  attributes: { company: 'Example Ltd', city: 'London', plan: 'pro' },
};

export class TemplateService {
  constructor(private readonly options: TemplateServiceOptions) {}

  async list(scope: WorkspaceScope) {
    return this.options.unitOfWork((repos) => repos.templates.list(scope));
  }

  async get(scope: WorkspaceScope, id: TemplateId) {
    return this.options.unitOfWork(async (repos) => {
      const template = await repos.templates.findById(scope, id);
      if (template === null) throw new AppError('not_found', 'Template not found', 404);

      const versions = await repos.templates.listVersions(scope, id);
      return { template, versions };
    });
  }

  /**
   * Creates a template and its first draft in one step.
   *
   * A template with no versions is a row nobody can do anything with, and
   * making the author save twice before they can preview serves nothing.
   */
  async create(
    scope: WorkspaceScope,
    input: { name: string; category?: string; subject: string; html: string; text?: string; preheader?: string },
  ) {
    const compiled = compileTemplate({
      subject: input.subject,
      html: input.html,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.preheader === undefined ? {} : { preheader: input.preheader }),
    });

    return this.options.unitOfWork(async (repos) => {
      const templateId = this.options.newId() as TemplateId;

      const createdBy = this.actorUserId();

      const template = await repos.templates.create(scope, {
        id: templateId,
        name: input.name,
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(createdBy === undefined ? {} : { createdBy }),
      });

      const version = await repos.templates.createVersion(scope, {
        id: this.options.newId() as TemplateVersionId,
        templateId,
        subject: compiled.subject,
        preheader: compiled.preheader,
        htmlSource: input.html,
        htmlCompiled: compiled.htmlCompiled,
        textBody: compiled.textBody,
        variables: compiled.variables,
        ...(createdBy === undefined ? {} : { createdBy }),
      });

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_TEMPLATES.created,
        resourceId: templateId,
        after: { name: input.name },
      });

      return { template, version, removed: compiled.removed };
    });
  }

  /**
   * Saves a new draft version.
   *
   * Always a new version rather than editing the last one, unless that one is
   * still a draft. Editing history is what publishing exists to prevent.
   */
  async saveVersion(
    scope: WorkspaceScope,
    templateId: TemplateId,
    input: { subject: string; html: string; text?: string; preheader?: string },
  ) {
    const compiled = compileTemplate({
      subject: input.subject,
      html: input.html,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.preheader === undefined ? {} : { preheader: input.preheader }),
    });

    return this.options.unitOfWork(async (repos) => {
      const template = await repos.templates.findById(scope, templateId);
      if (template === null) throw new AppError('not_found', 'Template not found', 404);

      const createdBy = this.actorUserId();
      const versions = await repos.templates.listVersions(scope, templateId);
      const latest = versions[0];

      // The newest version is still a draft: update it in place, so an author
      // typing does not create forty versions.
      if (latest !== undefined && latest.publishedAt === null) {
        const updated = await repos.templates.updateDraft(scope, latest.id, {
          subject: compiled.subject,
          preheader: compiled.preheader,
          htmlSource: input.html,
          htmlCompiled: compiled.htmlCompiled,
          textBody: compiled.textBody,
          variables: compiled.variables,
        });

        if (updated === null) {
          // It was published between the read and the write.
          throw new AppError('conflict', 'That version was published and can no longer be edited', 409);
        }

        return { version: updated, removed: compiled.removed };
      }

      const version = await repos.templates.createVersion(scope, {
        id: this.options.newId() as TemplateVersionId,
        templateId,
        subject: compiled.subject,
        preheader: compiled.preheader,
        htmlSource: input.html,
        htmlCompiled: compiled.htmlCompiled,
        textBody: compiled.textBody,
        variables: compiled.variables,
        ...(createdBy === undefined ? {} : { createdBy }),
      });

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_TEMPLATES.versionSaved,
        resourceId: templateId,
        after: { version: version.version },
      });

      return { version, removed: compiled.removed };
    });
  }

  async publish(scope: WorkspaceScope, versionId: TemplateVersionId) {
    return this.options.unitOfWork(async (repos) => {
      const existing = await repos.templates.findVersion(scope, versionId);
      if (existing === null) throw new AppError('not_found', 'Version not found', 404);

      const published = await repos.templates.publish(scope, versionId, this.actorUserId());
      if (published === null) {
        throw new AppError('conflict', 'That version is already published', 409);
      }

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_TEMPLATES.published,
        resourceId: published.templateId,
        after: { versionId, version: published.version },
      });

      return published;
    });
  }

  async rename(scope: WorkspaceScope, id: TemplateId, name: string) {
    return this.options.unitOfWork(async (repos) => {
      const renamed = await repos.templates.rename(scope, id, name);
      if (renamed === null) throw new AppError('not_found', 'Template not found', 404);
      return renamed;
    });
  }

  /**
   * Archives a template (F1's Archived tab).
   *
   * Not a delete, and the difference is the point: a campaign that pinned
   * one of this template's versions still renders, the name stays reserved,
   * and the author can bring it back. `remove` is the irreversible one.
   */
  async archive(scope: WorkspaceScope, id: TemplateId) {
    return this.setArchived(scope, id, true);
  }

  async unarchive(scope: WorkspaceScope, id: TemplateId) {
    return this.setArchived(scope, id, false);
  }

  private async setArchived(scope: WorkspaceScope, id: TemplateId, archived: boolean) {
    return this.options.unitOfWork(async (repos) => {
      const updated = archived
        ? await repos.templates.archive(scope, id)
        : await repos.templates.unarchive(scope, id);

      if (updated === null) {
        // Zero rows is two different things, and telling them apart needs a
        // second read. Worth it: "already archived" is a stale tab and
        // "not found" is a broken link, and answering 404 to the first
        // would send the author looking for a template that is right there.
        const existing = await repos.templates.findById(scope, id);
        if (existing === null) throw new AppError('not_found', 'Template not found', 404);

        throw new AppError(
          'conflict',
          archived ? 'That template is already archived' : 'That template is not archived',
          409,
        );
      }

      await this.audit(repos, scope, {
        action: archived
          ? AUDIT_ACTIONS_TEMPLATES.archived
          : AUDIT_ACTIONS_TEMPLATES.unarchived,
        resourceId: id,
        after: { archived },
      });

      return updated;
    });
  }

  /**
   * Duplicates a template and its newest version.
   *
   * The newest version, not `currentVersionId`. Duplicating is something an
   * author does while looking at a template — usually the one they are in
   * the middle of editing — and handing them a copy of the last *published*
   * version would silently drop the draft they can see on screen.
   *
   * The copy is always a draft: `createVersion` writes `published_at` null
   * and nothing here publishes it. A copy that arrived published would be a
   * version nobody reviewed that a campaign could pick up.
   */
  async duplicate(scope: WorkspaceScope, id: TemplateId) {
    return this.options.unitOfWork(async (repos) => {
      const source = await repos.templates.findById(scope, id);
      if (source === null) throw new AppError('not_found', 'Template not found', 404);

      const versions = await repos.templates.listVersions(scope, id);
      const latest = versions[0];

      if (latest === undefined) {
        // Only reachable for a row written before `create` made the two
        // inseparable. A copy of nothing is not a template.
        throw new AppError('conflict', 'That template has no version to copy', 409);
      }

      const base = `${source.name} (copy)`;
      const name = nextCopyName(base, await repos.templates.listNamesLike(scope, base));

      if (name === null) {
        throw new AppError(
          'conflict',
          'There are too many copies of this template already. Rename one and try again.',
          409,
        );
      }

      const createdBy = this.actorUserId();
      const templateId = this.options.newId() as TemplateId;

      const template = await repos.templates.create(scope, {
        id: templateId,
        name,
        ...(source.category === null ? {} : { category: source.category }),
        ...(createdBy === undefined ? {} : { createdBy }),
      });

      // Copied verbatim, including `htmlCompiled`. Not re-compiled: the
      // compiled output is what a reviewer approved, and re-running it
      // through today's allowlist would mean a duplicate can differ from
      // its original because our sanitiser changed (see the note at the top
      // of this file).
      const version = await repos.templates.createVersion(scope, {
        id: this.options.newId() as TemplateVersionId,
        templateId,
        subject: latest.subject,
        preheader: latest.preheader,
        htmlSource: latest.htmlSource,
        htmlCompiled: latest.htmlCompiled,
        textBody: latest.textBody,
        variables: latest.variables,
        ...(createdBy === undefined ? {} : { createdBy }),
      });

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_TEMPLATES.duplicated,
        resourceId: templateId,
        after: { duplicatedFrom: id, name, versionId: version.id },
      });

      return template;
    });
  }

  /**
   * Sends one test message rendered from a version (F2a's "Send test").
   *
   * Renders through exactly the same path as `preview`, so what lands in the
   * inbox is what the preview pane showed. A second renderer would drift,
   * and the drift would only be visible in the one place nobody can inspect.
   *
   * The send itself goes through the port, which is the provider service's
   * test-send machinery — the sender, its connection and its identity are
   * checked there, once, for both endpoints.
   */
  async sendTest(
    scope: WorkspaceScope,
    versionId: TemplateVersionId,
    input: { to: string; senderId?: string | undefined },
  ): Promise<{ accepted: boolean; jobId: string }> {
    const port = this.options.testSends;

    if (port === undefined) {
      throw new AppError(
        'service_unavailable',
        'Test sending is not available on this deployment yet',
        503,
      );
    }

    return this.options.unitOfWork(async (repos) => {
      const version = await repos.templates.findVersion(scope, versionId);
      if (version === null) throw new AppError('not_found', 'Version not found', 404);

      const rendered = renderTemplate(
        {
          subject: version.subject,
          preheader: version.preheader,
          htmlCompiled: version.htmlCompiled,
          textBody: version.textBody,
        },
        { values: contactValues(SAMPLE_CONTACT), defaults: defaultsFrom(version.variables) },
      );

      const { jobId } = await port.send(scope, {
        ...(input.senderId === undefined ? {} : { senderId: input.senderId }),
        to: [input.to],
        // Marked, because a test message that looks exactly like the real
        // campaign is a test message somebody forwards to a customer.
        subject: `[Test] ${rendered.subject}`,
        html: rendered.html,
        text: rendered.text,
        templateVersionId: version.id,
      });

      // Audited for the same reason the provider test send is: it puts real
      // mail outside a campaign, and therefore outside suppression checks
      // and outside metering.
      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_TEMPLATES.testSent,
        resourceId: version.templateId,
        after: { versionId, recipients: 1 },
      });

      return { accepted: true, jobId };
    });
  }

  async remove(scope: WorkspaceScope, id: TemplateId): Promise<void> {
    await this.options.unitOfWork(async (repos) => {
      if (!(await repos.templates.softDelete(scope, id))) {
        throw new AppError('not_found', 'Template not found', 404);
      }

      await this.audit(repos, scope, {
        action: AUDIT_ACTIONS_TEMPLATES.deleted,
        resourceId: id,
      });
    });
  }

  /**
   * Renders a version against a sample contact.
   *
   * Returns the compiled HTML with merge tags substituted — which is what the
   * recipient would see. The caller must render it in a sandboxed iframe on a
   * separate origin (docs/06): sanitisation and isolation are two halves, and
   * this returns the half that is still markup.
   */
  async preview(
    scope: WorkspaceScope,
    versionId: TemplateVersionId,
    contact: Partial<typeof SAMPLE_CONTACT> = {},
  ) {
    return this.options.unitOfWork(async (repos) => {
      const version = await repos.templates.findVersion(scope, versionId);
      if (version === null) throw new AppError('not_found', 'Version not found', 404);

      const merged = { ...SAMPLE_CONTACT, ...contact };
      const defaults = defaultsFrom(version.variables);

      const rendered = renderTemplate(
        {
          subject: version.subject,
          preheader: version.preheader,
          htmlCompiled: version.htmlCompiled,
          textBody: version.textBody,
        },
        { values: contactValues(merged), defaults },
      );

      return {
        ...rendered,
        // Exposed now because a campaign records it at launch (BUILD-PLAN
        // Phase 4 item 6), and the preview is where an author confirms which
        // version they are about to commit to.
        templateVersionId: version.id,
        version: version.version,
        published: version.publishedAt !== null,
      };
    });
  }

  /**
   * The acting user, where there is one.
   *
   * An API key has no user id, which every `created_by` column allows.
   */
  private actorUserId(): UserId | undefined {
    const actor = this.options.currentActor();
    return actor.type === 'user' && actor.id !== undefined ? (actor.id as UserId) : undefined;
  }

  private async audit(
    repos: TemplateRepositories,
    scope: WorkspaceScope,
    entry: { action: string; resourceId: string; after?: Record<string, unknown> },
  ): Promise<void> {
    await repos.auditLogs.append(
      scope,
      buildAuditEntry({
        id: this.options.newId(),
        actor: this.options.currentActor(),
        resourceType: 'template',
        ...entry,
      }),
    );
  }
}

/**
 * The first free name in the "X (copy)", "X (copy 2)", … sequence.
 *
 * Pure, so the rule is testable without a database, and separate from the
 * repository read so the read stays one statement. Returns null when the
 * whole sequence is taken, which the caller turns into a 409 — an endpoint
 * that loops until it finds a free integer is an endpoint that hangs.
 *
 * Advisory: `uq_template_name` is what actually decides, and two duplicates
 * racing can still both pick the same name.
 */
export function nextCopyName(base: string, taken: readonly string[]): string | null {
  const used = new Set(taken);
  if (!used.has(base)) return base;

  for (let n = 2; n <= MAX_COPY_ATTEMPTS; n += 1) {
    // "Autumn escapes (copy 2)", not "Autumn escapes (copy) (copy)" — the
    // second is what a naive retry produces and it is unreadable by the
    // fourth copy.
    const candidate = `${base.replace(/\)$/u, '')} ${n})`;
    if (!used.has(candidate)) return candidate;
  }

  return null;
}

/** The stored `variables` blob, as a field-to-default map. */
export function defaultsFrom(variables: unknown): Record<string, string> {
  if (!Array.isArray(variables)) return {};

  const defaults: Record<string, string> = {};
  for (const entry of variables) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record['field'] === 'string' && typeof record['default'] === 'string') {
      defaults[record['field']] = record['default'];
    }
  }

  return defaults;
}
