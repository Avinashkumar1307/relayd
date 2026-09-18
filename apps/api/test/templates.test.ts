import { describe, expect, it } from 'vitest';
import { TemplateService, defaultsFrom } from '../src/services/templates.js';
import type { TemplateRepositories } from '../src/services/templates.js';
import type { WorkspaceScope } from '@relayd/db';
import type { TemplateId, TemplateVersionId } from '@relayd/types';

/**
 * The template service.
 *
 * The Phase 4 gate names the rule under test here: a published version cannot
 * be mutated. The database enforces it with a trigger; this asserts the layer
 * above turns that into an answer a caller can act on.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;

interface StoredVersion {
  id: string;
  workspaceId: string;
  templateId: string;
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

/**
 * In-memory repositories that model the trigger.
 *
 * `updateDraft` and `publish` refuse a published row exactly as the guarded
 * SQL does, so the service is tested against the behaviour the database will
 * actually give it rather than a permissive fake.
 */
function fakeRepositories() {
  const templates = new Map<string, Record<string, unknown>>();
  const versions = new Map<string, StoredVersion>();
  const audit: string[] = [];

  const copy = <T>(value: T): T => structuredClone(value) as T;

  const repos = {
    templates: {
      async create(_scope: WorkspaceScope, input: Record<string, unknown>) {
        const row = {
          id: input['id'],
          workspaceId: 'ws-1',
          name: input['name'],
          category: input['category'] ?? null,
          currentVersionId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        templates.set(String(input['id']), row);
        return copy(row);
      },
      async findById(_scope: WorkspaceScope, id: string) {
        const row = templates.get(id);
        return row === undefined ? null : copy(row);
      },
      async list() {
        return [...templates.values()].map(copy);
      },
      async rename(_scope: WorkspaceScope, id: string, name: string) {
        const row = templates.get(id);
        if (row === undefined) return null;
        row['name'] = name;
        return copy(row);
      },
      async softDelete(_scope: WorkspaceScope, id: string) {
        return templates.delete(id);
      },

      async createVersion(_scope: WorkspaceScope, input: Record<string, unknown>) {
        const existing = [...versions.values()].filter(
          (v) => v.templateId === input['templateId'],
        );
        const row: StoredVersion = {
          id: String(input['id']),
          workspaceId: 'ws-1',
          templateId: String(input['templateId']),
          version: existing.length + 1,
          subject: String(input['subject']),
          preheader: (input['preheader'] as string | null) ?? null,
          htmlSource: String(input['htmlSource']),
          htmlCompiled: String(input['htmlCompiled']),
          textBody: String(input['textBody']),
          variables: input['variables'],
          publishedAt: null,
          createdAt: new Date(),
        };
        versions.set(row.id, row);
        return copy(row);
      },
      async findVersion(_scope: WorkspaceScope, id: string) {
        const row = versions.get(id);
        return row === undefined ? null : copy(row);
      },
      async listVersions(_scope: WorkspaceScope, templateId: string) {
        return [...versions.values()]
          .filter((v) => v.templateId === templateId)
          .sort((a, b) => b.version - a.version)
          .map(copy);
      },
      async updateDraft(_scope: WorkspaceScope, id: string, patch: Record<string, unknown>) {
        const row = versions.get(id);
        // The guard the SQL applies: published rows match nothing.
        if (row === undefined || row.publishedAt !== null) return null;
        Object.assign(row, patch);
        return copy(row);
      },
      async publish(_scope: WorkspaceScope, id: string) {
        const row = versions.get(id);
        if (row === undefined || row.publishedAt !== null) return null;
        row.publishedAt = new Date();

        const template = templates.get(row.templateId);
        if (template !== undefined) template['currentVersionId'] = id;

        return copy(row);
      },
    },

    auditLogs: {
      async append(_scope: WorkspaceScope, entry: Record<string, unknown>) {
        audit.push(String(entry['action']));
      },
    },
  } as unknown as TemplateRepositories;

  return { repos, templates, versions, audit };
}

function build() {
  const { repos, templates, versions, audit } = fakeRepositories();
  let counter = 0;

  const service = new TemplateService({
    unitOfWork: async (fn) => fn(repos),
    newId: () => {
      counter += 1;
      return `id-${counter}`;
    },
    currentActor: () => ({ type: 'user', id: 'user-1' }),
  });

  return { service, templates, versions, audit };
}

const BASIC = {
  name: 'Welcome',
  subject: 'Hi {{ first_name | there }}',
  html: '<p>Hello {{ first_name | there }}</p>',
};

describe('creating a template', () => {
  it('creates the template and its first draft together', async () => {
    // A template with no versions is a row nobody can do anything with.
    const { service, templates, versions } = build();

    const result = await service.create(SCOPE, BASIC);

    expect(templates.size).toBe(1);
    expect(versions.size).toBe(1);
    expect(result.version.version).toBe(1);
    expect(result.version.publishedAt).toBeNull();
  });

  it('compiles the HTML on save and reports what was stripped', async () => {
    const { service } = build();

    const result = await service.create(SCOPE, {
      ...BASIC,
      html: '<p>Hi</p><script>alert(1)</script>',
    });

    expect(result.version.htmlCompiled).not.toContain('<script');
    expect(result.removed).toContain('<script>');
    // The author's own markup is kept, so they can edit it back.
    expect(result.version.htmlSource).toContain('<script>');
  });

  it('derives a text part', async () => {
    const { service } = build();
    const result = await service.create(SCOPE, BASIC);

    expect(result.version.textBody).toContain('Hello {{ first_name | there }}');
  });

  it('records the merge tags it found', async () => {
    const { service } = build();
    const result = await service.create(SCOPE, BASIC);

    expect(result.version.variables).toEqual([
      { field: 'first_name', default: 'there', required: false },
    ]);
  });
});

describe('saving versions', () => {
  it('updates the draft in place rather than making a new one', async () => {
    // An author typing must not create forty versions.
    const { service, versions } = build();
    const created = await service.create(SCOPE, BASIC);

    await service.saveVersion(SCOPE, created.template.id as TemplateId, {
      subject: 'Hi again',
      html: '<p>Changed</p>',
    });

    expect(versions.size).toBe(1);
    expect([...versions.values()][0]?.subject).toBe('Hi again');
  });

  it('creates a new version once the last one is published', async () => {
    const { service, versions } = build();
    const created = await service.create(SCOPE, BASIC);
    await service.publish(SCOPE, created.version.id as TemplateVersionId);

    const saved = await service.saveVersion(SCOPE, created.template.id as TemplateId, {
      subject: 'Version two',
      html: '<p>Two</p>',
    });

    expect(versions.size).toBe(2);
    expect(saved.version.version).toBe(2);
    expect(saved.version.publishedAt).toBeNull();
  });

  it('refuses to edit a published version', async () => {
    // The gate criterion. A campaign records the version it rendered, so
    // editing one rewrites what a customer already sent.
    const { service, versions } = build();
    const created = await service.create(SCOPE, BASIC);
    const versionId = created.version.id as TemplateVersionId;

    await service.publish(SCOPE, versionId);

    const published = versions.get(versionId);
    const before = { ...(published as StoredVersion) };

    // Saving now makes a new version and leaves the published one alone.
    await service.saveVersion(SCOPE, created.template.id as TemplateId, {
      subject: 'Sneaky edit',
      html: '<p>Sneaky</p>',
    });

    expect(versions.get(versionId)).toEqual(before);
  });
});

describe('publishing', () => {
  it('marks the version published and points the template at it', async () => {
    const { service, templates } = build();
    const created = await service.create(SCOPE, BASIC);

    const published = await service.publish(SCOPE, created.version.id as TemplateVersionId);

    expect(published.publishedAt).not.toBeNull();
    expect(templates.get(created.template.id)?.['currentVersionId']).toBe(created.version.id);
  });

  it('refuses a second publish rather than answering 200', async () => {
    // Publishing twice means the caller believes something untrue, and a 200
    // would let them keep believing it.
    const { service } = build();
    const created = await service.create(SCOPE, BASIC);
    const versionId = created.version.id as TemplateVersionId;

    await service.publish(SCOPE, versionId);
    await expect(service.publish(SCOPE, versionId)).rejects.toThrow(/already published/u);
  });

  it('refuses a version that does not exist', async () => {
    const { service } = build();
    await expect(service.publish(SCOPE, 'nope' as TemplateVersionId)).rejects.toThrow(/not found/u);
  });

  it('records it in the audit log', async () => {
    const { service, audit } = build();
    const created = await service.create(SCOPE, BASIC);
    await service.publish(SCOPE, created.version.id as TemplateVersionId);

    expect(audit).toContain('template.version_published');
  });
});

describe('preview', () => {
  it('renders against a sample contact', async () => {
    const { service } = build();
    const created = await service.create(SCOPE, BASIC);

    const preview = await service.preview(SCOPE, created.version.id as TemplateVersionId);

    expect(preview.subject).toBe('Hi Sam');
    expect(preview.html).toContain('Hello Sam');
  });

  it('accepts overrides, so an author can try an awkward value', async () => {
    const { service } = build();
    const created = await service.create(SCOPE, BASIC);

    const preview = await service.preview(SCOPE, created.version.id as TemplateVersionId, {
      firstName: 'A very long name indeed',
    });

    expect(preview.subject).toBe('Hi A very long name indeed');
  });

  it('renders the default when the sample has nothing for the field', async () => {
    const { service } = build();
    const created = await service.create(SCOPE, {
      ...BASIC,
      subject: 'For {{ unknown_field | everyone }}',
    });

    const preview = await service.preview(SCOPE, created.version.id as TemplateVersionId);
    expect(preview.subject).toBe('For everyone');
  });

  it('escapes a hostile override', async () => {
    const { service } = build();
    const created = await service.create(SCOPE, BASIC);

    const preview = await service.preview(SCOPE, created.version.id as TemplateVersionId, {
      firstName: '<img src=x onerror=alert(1)>',
    });

    expect(preview.html).not.toMatch(/<img[^>]*onerror/u);
  });

  it('exposes the version id a campaign would record', async () => {
    // BUILD-PLAN Phase 4 item 6. The preview is where an author confirms
    // which version they are about to commit a campaign to.
    const { service } = build();
    const created = await service.create(SCOPE, BASIC);

    const preview = await service.preview(SCOPE, created.version.id as TemplateVersionId);

    expect(preview.templateVersionId).toBe(created.version.id);
    expect(preview.version).toBe(1);
    expect(preview.published).toBe(false);
  });

  it('is deterministic', async () => {
    const { service } = build();
    const created = await service.create(SCOPE, BASIC);
    const versionId = created.version.id as TemplateVersionId;

    const first = await service.preview(SCOPE, versionId);
    const second = await service.preview(SCOPE, versionId);

    expect(second).toEqual(first);
  });
});

describe('reading the stored variables', () => {
  it('turns the blob into a field-to-default map', () => {
    expect(
      defaultsFrom([
        { field: 'first_name', default: 'there', required: false },
        { field: 'company', default: '', required: true },
      ]),
    ).toEqual({ first_name: 'there', company: '' });
  });

  it('survives anything else without throwing', () => {
    // The column is jsonb and a row written by an older version of this code
    // is not a reason to fail a send.
    expect(defaultsFrom(null)).toEqual({});
    expect(defaultsFrom('nonsense')).toEqual({});
    expect(defaultsFrom([1, 2, 3])).toEqual({});
    expect(defaultsFrom([{ field: 'x' }])).toEqual({});
  });
});
