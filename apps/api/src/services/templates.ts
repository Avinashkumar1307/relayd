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

export interface TemplateServiceOptions {
  unitOfWork: TemplateUnitOfWork;
  newId: () => string;
  currentActor: () => Actor;
}

export const AUDIT_ACTIONS_TEMPLATES = {
  created: 'template.created',
  versionSaved: 'template.version_saved',
  published: 'template.version_published',
  deleted: 'template.deleted',
} as const;

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
