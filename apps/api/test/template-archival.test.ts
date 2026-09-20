import { describe, expect, it } from 'vitest';
import type { WorkspaceScope } from '@relayd/db';
import type { TemplateId, TemplateVersionId } from '@relayd/types';
import {
  TemplateService,
  nextCopyName,
  type TemplateRepositories,
  type TemplateTestSendPort,
} from '../src/services/templates.js';

/**
 * Archive, unarchive, duplicate and send test (design frames F1 and F2a).
 *
 * The rules worth holding onto here, in order of how expensive getting them
 * wrong would be:
 *
 *   A duplicate is a draft. A copy that arrived published would be a version
 *   nobody reviewed that a campaign can pick up.
 *
 *   A duplicate copies the *newest* version, not the published one.
 *   Duplicating is something an author does while looking at a template, and
 *   silently dropping the draft on screen is a bug they will not notice until
 *   the copy is already sent.
 *
 *   Archiving is not deleting, and "already archived" is not "not found".
 *   One is a stale tab; the other is a broken link.
 *
 *   A test send is real mail outside campaigns, suppression and metering, so
 *   it is audited, and it is refused rather than faked when there is no
 *   queue to send it.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;

interface StoredTemplate {
  id: string;
  workspaceId: string;
  name: string;
  category: string | null;
  currentVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archived: boolean;
}

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
 * In-memory repositories that model the guards the SQL applies.
 *
 * `archive` and `unarchive` return null where the guarded UPDATE would match
 * zero rows, so the service is tested against the behaviour the database will
 * actually give it rather than a permissive fake.
 */
function fakeRepositories() {
  const templates = new Map<string, StoredTemplate>();
  const versions = new Map<string, StoredVersion>();
  const audit: { action: string; after?: unknown }[] = [];

  const copy = <T>(value: T): T => structuredClone(value) as T;

  const repos = {
    templates: {
      async create(_scope: WorkspaceScope, input: Record<string, unknown>) {
        const row: StoredTemplate = {
          id: String(input['id']),
          workspaceId: 'ws-1',
          name: String(input['name']),
          category: (input['category'] as string | undefined) ?? null,
          currentVersionId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          archived: false,
        };
        templates.set(row.id, row);
        return copy(row);
      },
      async findById(_scope: WorkspaceScope, id: string) {
        const row = templates.get(id);
        return row === undefined ? null : copy(row);
      },
      async list() {
        return [...templates.values()].map(copy);
      },
      async listNamesLike(_scope: WorkspaceScope, prefix: string) {
        return [...templates.values()]
          .map((row) => row.name)
          .filter((name) => name.startsWith(prefix));
      },
      async archive(_scope: WorkspaceScope, id: string) {
        const row = templates.get(id);
        // The guard: an archived row matches nothing.
        if (row === undefined || row.archived) return null;
        row.archived = true;
        return copy(row);
      },
      async unarchive(_scope: WorkspaceScope, id: string) {
        const row = templates.get(id);
        if (row === undefined || !row.archived) return null;
        row.archived = false;
        return copy(row);
      },
      async softDelete(_scope: WorkspaceScope, id: string) {
        return templates.delete(id);
      },
      async rename(_scope: WorkspaceScope, id: string, name: string) {
        const row = templates.get(id);
        if (row === undefined) return null;
        row.name = name;
        return copy(row);
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
        if (row === undefined || row.publishedAt !== null) return null;
        Object.assign(row, patch);
        return copy(row);
      },
      async publish(_scope: WorkspaceScope, id: string) {
        const row = versions.get(id);
        if (row === undefined || row.publishedAt !== null) return null;
        row.publishedAt = new Date();
        const template = templates.get(row.templateId);
        if (template !== undefined) template.currentVersionId = id;
        return copy(row);
      },
    },

    auditLogs: {
      async append(_scope: WorkspaceScope, entry: { action: string; after?: unknown }) {
        audit.push({ action: entry.action, after: entry.after });
      },
    },
  } as unknown as TemplateRepositories;

  return { repos, templates, versions, audit };
}

function build(options: { testSends?: TemplateTestSendPort } = {}) {
  const { repos, templates, versions, audit } = fakeRepositories();
  let counter = 0;

  const service = new TemplateService({
    unitOfWork: async (fn) => fn(repos),
    newId: () => {
      counter += 1;
      return `id-${counter}`;
    },
    currentActor: () => ({ type: 'user', id: 'user-1' }),
    ...(options.testSends === undefined ? {} : { testSends: options.testSends }),
  });

  return { service, templates, versions, audit };
}

const BASIC = {
  name: 'Autumn escapes',
  subject: 'Hi {{ first_name | there }}',
  html: '<p>Hello {{ first_name | there }}</p>',
};

/* ------------------------------------------------------------- archiving -- */

describe('archiving a template', () => {
  it('marks it archived without deleting it', async () => {
    const { service, templates } = build();
    const created = await service.create(SCOPE, BASIC);

    const archived = await service.archive(SCOPE, created.template.id as TemplateId);

    expect(archived.archived).toBe(true);
    // The row is still there, which is the whole difference from delete: a
    // campaign that pinned one of its versions must still render.
    expect(templates.has(created.template.id)).toBe(true);
  });

  it('brings it back', async () => {
    const { service } = build();
    const created = await service.create(SCOPE, BASIC);
    const id = created.template.id as TemplateId;

    await service.archive(SCOPE, id);
    expect((await service.unarchive(SCOPE, id)).archived).toBe(false);
  });

  it('answers 409, not 404, when it is already archived', async () => {
    // A stale tab is not a broken link, and answering 404 would send the
    // author looking for a template that is right there in front of them.
    const { service } = build();
    const created = await service.create(SCOPE, BASIC);
    const id = created.template.id as TemplateId;

    await service.archive(SCOPE, id);

    await expect(service.archive(SCOPE, id)).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
  });

  it('answers 409 when unarchiving something that is not archived', async () => {
    const { service } = build();
    const created = await service.create(SCOPE, BASIC);

    await expect(
      service.unarchive(SCOPE, created.template.id as TemplateId),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('answers 404 for a template in another workspace', async () => {
    const { service } = build();
    await expect(service.archive(SCOPE, 'nope' as TemplateId)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('records both directions in the audit log', async () => {
    const { service, audit } = build();
    const created = await service.create(SCOPE, BASIC);
    const id = created.template.id as TemplateId;

    await service.archive(SCOPE, id);
    await service.unarchive(SCOPE, id);

    expect(audit.map((entry) => entry.action)).toContain('template.archived');
    expect(audit.map((entry) => entry.action)).toContain('template.unarchived');
  });
});

/* ----------------------------------------------------------- duplicating -- */

describe('duplicating a template', () => {
  it('copies the template and its version', async () => {
    const { service, templates, versions } = build();
    const created = await service.create(SCOPE, BASIC);

    const copy = await service.duplicate(SCOPE, created.template.id as TemplateId);

    expect(templates.size).toBe(2);
    expect(versions.size).toBe(2);
    expect(copy.id).not.toBe(created.template.id);
    expect(copy.name).toBe('Autumn escapes (copy)');
  });

  it('makes the copy a draft', async () => {
    // A copy that arrived published would be a version nobody reviewed that
    // a campaign can pick up.
    const { service, versions } = build();
    const created = await service.create(SCOPE, BASIC);
    await service.publish(SCOPE, created.version.id as TemplateVersionId);

    const copy = await service.duplicate(SCOPE, created.template.id as TemplateId);

    expect(copy.currentVersionId).toBeNull();
    const copied = [...versions.values()].filter((v) => v.templateId === copy.id);
    expect(copied).toHaveLength(1);
    expect(copied[0]?.publishedAt).toBeNull();
    expect(copied[0]?.version).toBe(1);
  });

  it('copies the newest version, not the published one', async () => {
    // Duplicating is something an author does while looking at a template.
    // Handing them a copy that dropped the draft on screen is wrong.
    const { service, versions } = build();
    const created = await service.create(SCOPE, BASIC);
    await service.publish(SCOPE, created.version.id as TemplateVersionId);

    await service.saveVersion(SCOPE, created.template.id as TemplateId, {
      subject: 'The draft on screen',
      html: '<p>Draft</p>',
    });

    const copy = await service.duplicate(SCOPE, created.template.id as TemplateId);
    const copied = [...versions.values()].find((v) => v.templateId === copy.id);

    expect(copied?.subject).toBe('The draft on screen');
  });

  it('copies the compiled HTML rather than recompiling it', async () => {
    // Re-running the source through today's allowlist would mean a
    // duplicate can differ from its original because our sanitiser changed.
    const { service, versions } = build();
    const created = await service.create(SCOPE, BASIC);

    const copy = await service.duplicate(SCOPE, created.template.id as TemplateId);
    const copied = [...versions.values()].find((v) => v.templateId === copy.id);

    expect(copied?.htmlCompiled).toBe(created.version.htmlCompiled);
    expect(copied?.htmlSource).toBe(created.version.htmlSource);
  });

  it('keeps the category', async () => {
    const { service } = build();
    const created = await service.create(SCOPE, { ...BASIC, category: 'campaign' });

    const copy = await service.duplicate(SCOPE, created.template.id as TemplateId);
    expect(copy.category).toBe('campaign');
  });

  it('picks a free name when one copy already exists', async () => {
    // `uq_template_name` is unique per workspace, so a second "(copy)" is a
    // 23505 rather than a second template.
    const { service } = build();
    const created = await service.create(SCOPE, BASIC);
    const id = created.template.id as TemplateId;

    await service.duplicate(SCOPE, id);
    const second = await service.duplicate(SCOPE, id);

    expect(second.name).toBe('Autumn escapes (copy 2)');
  });

  it('answers 404 for a template in another workspace', async () => {
    const { service } = build();
    await expect(service.duplicate(SCOPE, 'nope' as TemplateId)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('records it in the audit log, naming what it was copied from', async () => {
    const { service, audit } = build();
    const created = await service.create(SCOPE, BASIC);

    await service.duplicate(SCOPE, created.template.id as TemplateId);

    const entry = audit.find((row) => row.action === 'template.duplicated');
    expect(entry).toBeDefined();
    expect((entry?.after as { duplicatedFrom?: string })?.duplicatedFrom).toBe(
      created.template.id,
    );
  });
});

describe('choosing a name for a copy', () => {
  it('takes the plain one when it is free', () => {
    expect(nextCopyName('Autumn escapes (copy)', [])).toBe('Autumn escapes (copy)');
  });

  it('numbers from two, not one', () => {
    // "(copy 1)" beside "(copy)" reads as though the first one is missing.
    expect(nextCopyName('Autumn escapes (copy)', ['Autumn escapes (copy)'])).toBe(
      'Autumn escapes (copy 2)',
    );
  });

  it('does not nest brackets', () => {
    // "Autumn escapes (copy) (copy)" is what a naive retry produces and it
    // is unreadable by the fourth copy.
    const taken = ['Autumn escapes (copy)', 'Autumn escapes (copy 2)'];
    expect(nextCopyName('Autumn escapes (copy)', taken)).toBe('Autumn escapes (copy 3)');
  });

  it('gives up rather than looping forever', () => {
    const taken = ['Base (copy)'];
    for (let n = 2; n <= 50; n += 1) taken.push(`Base (copy ${n})`);

    expect(nextCopyName('Base (copy)', taken)).toBeNull();
  });
});

/* ------------------------------------------------------------ send test -- */

describe('sending a test message', () => {
  const recording = () => {
    const sent: Record<string, unknown>[] = [];
    const port: TemplateTestSendPort = {
      async send(_scope, input) {
        sent.push({ ...input });
        return { jobId: 'job-1', queued: 1 };
      },
    };
    return { sent, port };
  };

  it('renders the version and queues it', async () => {
    const { sent, port } = recording();
    const { service } = build({ testSends: port });
    const created = await service.create(SCOPE, BASIC);

    const result = await service.sendTest(SCOPE, created.version.id as TemplateVersionId, {
      to: 'dana@example.com',
    });

    expect(result).toEqual({ accepted: true, jobId: 'job-1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.['to']).toEqual(['dana@example.com']);
  });

  it('renders it the same way the preview does', async () => {
    // What lands in the inbox has to be what the preview pane showed. A
    // second renderer would drift, and the drift would only be visible in
    // the one place nobody can inspect.
    const { sent, port } = recording();
    const { service } = build({ testSends: port });
    const created = await service.create(SCOPE, BASIC);
    const versionId = created.version.id as TemplateVersionId;

    const preview = await service.preview(SCOPE, versionId);
    await service.sendTest(SCOPE, versionId, { to: 'dana@example.com' });

    expect(sent[0]?.['html']).toBe(preview.html);
    expect(sent[0]?.['text']).toBe(preview.text);
  });

  it('marks the subject as a test', async () => {
    // A test message that looks exactly like the real campaign is a test
    // message somebody forwards to a customer.
    const { sent, port } = recording();
    const { service } = build({ testSends: port });
    const created = await service.create(SCOPE, BASIC);

    await service.sendTest(SCOPE, created.version.id as TemplateVersionId, {
      to: 'dana@example.com',
    });

    expect(String(sent[0]?.['subject'])).toMatch(/^\[Test\] /u);
  });

  it('passes a chosen sender through, and omits it when there is none', async () => {
    const { sent, port } = recording();
    const { service } = build({ testSends: port });
    const created = await service.create(SCOPE, BASIC);
    const versionId = created.version.id as TemplateVersionId;

    await service.sendTest(SCOPE, versionId, { to: 'a@example.com', senderId: 'sa-9' });
    await service.sendTest(SCOPE, versionId, { to: 'b@example.com' });

    expect(sent[0]?.['senderId']).toBe('sa-9');
    expect(sent[1]).not.toHaveProperty('senderId');
  });

  it('audits it, because it is mail outside campaigns and metering', async () => {
    const { port } = recording();
    const { service, audit } = build({ testSends: port });
    const created = await service.create(SCOPE, BASIC);

    await service.sendTest(SCOPE, created.version.id as TemplateVersionId, {
      to: 'dana@example.com',
    });

    expect(audit.map((entry) => entry.action)).toContain('template.test_sent');
  });

  it('answers 404 for a version in another workspace', async () => {
    const { port } = recording();
    const { service } = build({ testSends: port });

    await expect(
      service.sendTest(SCOPE, 'nope' as TemplateVersionId, { to: 'dana@example.com' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('answers 503 rather than pretending when no queue is wired', async () => {
    // The same answer `POST /senders/:id/test` gives. Returning
    // `accepted: true` for a message nothing will ever send is worse than
    // an error: the author waits for mail that is not coming.
    const { service } = build();
    const created = await service.create(SCOPE, BASIC);

    await expect(
      service.sendTest(SCOPE, created.version.id as TemplateVersionId, {
        to: 'dana@example.com',
      }),
    ).rejects.toMatchObject({ status: 503, code: 'service_unavailable' });
  });

  it('does not read the version before refusing an unwired deployment', async () => {
    // Cheapest refusal first: there is nothing to learn from a read whose
    // result cannot be used.
    const { service } = build();
    await expect(
      service.sendTest(SCOPE, 'nope' as TemplateVersionId, { to: 'x@example.com' }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
