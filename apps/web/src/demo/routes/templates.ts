import type { Route, Row } from '../state.js';
import { collection, find, id, nowIso, state } from '../state.js';
import { AUTUMN_ID, previewHtml, render, versions as versionSeed } from '../data/templates.js';

/**
 * Section F demo routes: templates, their versions and the preview.
 *
 * DEMO ONLY. The `/versions/...` and `/:id/versions` patterns come before
 * the bare `/templates/:id` ones because the first match wins here, and a
 * dynamic segment would otherwise claim "versions" as an id.
 *
 * Versions live in their own collection rather than in `state`, so this
 * section's store is this section's file.
 */

const versions = collection('templateVersions', () => versionSeed);

const forTemplate = (templateId: string): Row[] =>
  versions
    .filter((row) => row['templateId'] === templateId)
    .sort((a, b) => (b['version'] as number) - (a['version'] as number));

const PEOPLE: Record<string, Record<string, string>> = {
  'amira.khalil@example.com': { first_name: 'Amira', last_name: 'Khalil', loyalty_tier: 'Gold', home_airport: 'DXB' },
  'aisha.khan@example.com': { first_name: 'Aisha', last_name: 'Khan', loyalty_tier: 'Silver', home_airport: 'LHR' },
};

function newVersion(templateId: string, body: unknown): Row {
  const input = (body ?? {}) as { subject?: string; html?: string; text?: string; preheader?: string };
  const previous = forTemplate(templateId)[0];
  const next = ((previous?.['version'] as number | undefined) ?? 0) + 1;

  const row: Row = {
    id: id('tplv_'),
    templateId,
    version: next,
    subject: input.subject ?? (previous?.['subject'] as string | undefined) ?? '',
    preheader: input.preheader ?? (previous?.['preheader'] as string | null | undefined) ?? null,
    htmlSource: input.html ?? (previous?.['htmlSource'] as string | undefined) ?? '',
    htmlCompiled: input.html ?? (previous?.['htmlCompiled'] as string | undefined) ?? '',
    textBody: input.text ?? (previous?.['textBody'] as string | undefined) ?? '',
    variables: previous?.['variables'] ?? [],
    publishedAt: null,
    createdAt: nowIso(),
    savedLabel: 'Saved just now',
    historyLabel: 'Editing · saved just now by Dana Haddad',
  };

  versions.push(row);

  const template = find(state.templates, templateId);
  if (template !== undefined) {
    template['state'] = 'draft';
    template['versionCount'] = forTemplate(templateId).length;
    template['editedLabel'] = 'Edited just now by Dana Haddad';
    template['updatedAt'] = nowIso();
  }

  return row;
}

export const routes: Route[] = [
  { method: 'GET', pattern: /^\/templates$/u, handler: () => state.templates },

  {
    method: 'POST',
    pattern: /^\/templates$/u,
    handler: (_m, body) => {
      const input = (body ?? {}) as { name: string; subject?: string; html?: string };
      const templateId = id('tpl_');

      const template: Row = {
        id: templateId,
        name: input.name,
        category: null,
        currentVersionId: null,
        state: 'draft',
        versionCount: 1,
        editedLabel: 'Edited just now by Dana Haddad',
        archived: false,
        accent: '#141B3D',
        hero: true,
        defaultSenderId: 'snd1',
        language: 'en',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      state.templates.unshift(template);
      const version = newVersion(templateId, { subject: input.subject, html: input.html, text: '' });

      return { template, version, removed: [] };
    },
  },

  {
    method: 'POST',
    pattern: /^\/templates\/versions\/([^/]+)\/preview$/u,
    handler: (m, body) => {
      const version = find(versions, m[1] ?? '');
      const input = (body ?? {}) as { email?: string; firstName?: string; lastName?: string };
      const contact = PEOPLE[input.email ?? ''] ?? {};
      const subject = render((version?.['subject'] as string | undefined) ?? '', contact);

      return {
        subject,
        html:
          version?.['templateId'] === AUTUMN_ID || version === undefined
            ? previewHtml(contact)
            : render((version['htmlCompiled'] as string | undefined) ?? '', contact),
        text: render((version?.['textBody'] as string | undefined) ?? '', contact),
        preheader: render((version?.['preheader'] as string | undefined) ?? '', contact),
        fromName: 'Northwind Voyages',
        fromEmail: 'hello@northwind.travel',
        templateVersionId: version?.['id'] ?? m[1] ?? '',
        version: version?.['version'] ?? 1,
        published: (version?.['publishedAt'] ?? null) !== null,
      };
    },
  },

  {
    method: 'POST',
    pattern: /^\/templates\/versions\/([^/]+)\/publish$/u,
    handler: (m) => {
      const version = find(versions, m[1] ?? '');
      if (version === undefined) return {};

      version['publishedAt'] = nowIso();
      version['publishedLabel'] = 'Published just now by Dana Haddad';
      delete version['savedLabel'];

      const template = find(state.templates, version['templateId'] as string);
      if (template !== undefined) {
        template['currentVersionId'] = version['id'];
        template['state'] = 'published';
        template['updatedAt'] = nowIso();
      }

      return version;
    },
  },

  {
    method: 'POST',
    pattern: /^\/templates\/versions\/([^/]+)\/test$/u,
    handler: () => ({ accepted: true }),
  },

  {
    method: 'POST',
    pattern: /^\/templates\/([^/]+)\/versions$/u,
    handler: (m, body) => newVersion(m[1] ?? '', body),
  },

  {
    method: 'POST',
    pattern: /^\/templates\/([^/]+)\/archive$/u,
    handler: (m) => {
      const row = find(state.templates, m[1] ?? '');
      if (row !== undefined) row['archived'] = true;
      return row ?? {};
    },
  },

  {
    method: 'POST',
    pattern: /^\/templates\/([^/]+)\/unarchive$/u,
    handler: (m) => {
      const row = find(state.templates, m[1] ?? '');
      if (row !== undefined) row['archived'] = false;
      return row ?? {};
    },
  },

  {
    method: 'POST',
    pattern: /^\/templates\/([^/]+)\/duplicate$/u,
    handler: (m) => {
      const source = find(state.templates, m[1] ?? '');
      if (source === undefined) return {};

      const templateId = id('tpl_');
      const copy: Row = {
        ...source,
        id: templateId,
        name: `${source['name'] as string} (copy)`,
        currentVersionId: null,
        state: 'draft',
        versionCount: 1,
        editedLabel: 'Edited just now by Dana Haddad',
        archived: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      state.templates.unshift(copy);
      const latest = forTemplate(source['id'])[0];
      newVersion(templateId, {
        subject: latest?.['subject'],
        html: latest?.['htmlSource'],
        text: latest?.['textBody'],
        preheader: latest?.['preheader'],
      });

      return copy;
    },
  },

  {
    method: 'PATCH',
    pattern: /^\/templates\/([^/]+)$/u,
    handler: (m, body) => {
      const row = find(state.templates, m[1] ?? '');
      if (row !== undefined) Object.assign(row, body as object);
      return row ?? {};
    },
  },

  {
    method: 'DELETE',
    pattern: /^\/templates\/([^/]+)$/u,
    handler: (m) => {
      state.templates = state.templates.filter((row) => row.id !== m[1]);
      return {};
    },
  },

  {
    method: 'GET',
    pattern: /^\/templates\/([^/]+)$/u,
    handler: (m) => {
      const template = find(state.templates, m[1] ?? '') ?? state.templates[0];
      return {
        template,
        versions: template === undefined ? [] : forTemplate(template.id),
      };
    },
  },
];

/** SPA paths the demo smoke test walks for this section. */
export const previewPaths: string[] = ['/templates', `/templates/${AUTUMN_ID}`];
