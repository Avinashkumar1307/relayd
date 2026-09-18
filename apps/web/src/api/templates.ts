import { api } from './client.js';

/** Template endpoints. */

export interface Template {
  id: string;
  name: string;
  category: string | null;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MergeTag {
  field: string;
  default: string;
  required: boolean;
}

export interface TemplateVersion {
  id: string;
  templateId: string;
  version: number;
  subject: string;
  preheader: string | null;
  htmlSource: string;
  htmlCompiled: string;
  textBody: string;
  variables: MergeTag[];
  publishedAt: string | null;
  createdAt: string;
}

export interface Preview {
  subject: string;
  html: string;
  text: string;
  templateVersionId: string;
  version: number;
  published: boolean;
}

export interface SaveResult {
  version: TemplateVersion;
  removed: string[];
}

export const templateApi = {
  list: () => api.get<Template[]>('/templates'),

  get: (id: string) =>
    api.get<{ template: Template; versions: TemplateVersion[] }>(`/templates/${id}`),

  create: (input: {
    name: string;
    subject: string;
    html: string;
    text?: string;
    preheader?: string;
  }) =>
    api.post<{ template: Template; version: TemplateVersion; removed: string[] }>(
      '/templates',
      input,
    ),

  rename: (id: string, name: string) => api.patch<Template>(`/templates/${id}`, { name }),

  remove: (id: string) => api.delete<void>(`/templates/${id}`),

  saveVersion: (
    id: string,
    input: { subject: string; html: string; text?: string; preheader?: string },
  ) => api.post<TemplateVersion>(`/templates/${id}/versions`, input),

  publish: (versionId: string) =>
    api.post<TemplateVersion>(`/templates/versions/${versionId}/publish`),

  preview: (
    versionId: string,
    contact: { firstName?: string; lastName?: string; email?: string } = {},
  ) => api.post<Preview>(`/templates/versions/${versionId}/preview`, contact),
};

export const templateKeys = {
  all: ['templates'] as const,
  one: (id: string) => ['templates', id] as const,
  preview: (versionId: string, contact: unknown) => ['templates', 'preview', versionId, contact] as const,
};

/**
 * The merge tags an author can insert.
 *
 * A fixed list rather than one derived from the workspace's contact
 * attributes: those vary per contact, and offering a tag that most of the
 * audience cannot satisfy is how a campaign goes out addressed to "".
 * Custom attributes are typed by hand, deliberately.
 */
export const STANDARD_MERGE_TAGS: { field: string; label: string; suggestedDefault: string }[] = [
  { field: 'first_name', label: 'First name', suggestedDefault: 'there' },
  { field: 'last_name', label: 'Last name', suggestedDefault: '' },
  { field: 'email', label: 'Email address', suggestedDefault: '' },
];
