import { api } from './client.js';

/**
 * Template endpoints (section F).
 *
 * `apps/api/src/routes/templates.ts` serves the eight calls below the fold:
 * list, get, create, rename, delete, save version, publish and preview.
 * Everything section F's frames draw beyond that — the Active/Archived tabs,
 * the card thumbnail, "Edited 2 min ago by Dana Haddad", the version's
 * campaigns, Duplicate, Send test — has no column or endpoint yet. Those
 * fields are optional here and every call site that needs one carries a
 * `BACKEND PENDING` comment, so the pages render correctly against the mocked
 * API, which supplies them, and against the real one, which does not.
 */

export interface Template {
  id: string;
  name: string;
  category: string | null;
  /** The published version a campaign would pick up. Null until one exists. */
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;

  /**
   * BACKEND PENDING: GET /templates.
   *
   * `state` is the newest version's state, not the template's: F1 shows
   * "Autumn escapes · Draft · 7 versions" for a template whose v6 is
   * published and whose v7 is being written. The two facts are different and
   * the card shows the one an author is looking for.
   */
  state?: 'draft' | 'published';
  /** BACKEND PENDING: GET /templates ("7 versions"). */
  versionCount?: number;
  /** BACKEND PENDING: GET /templates ("Edited 2 min ago by Dana Haddad"). */
  editedLabel?: string;
  /** BACKEND PENDING: GET /templates (the Active / Archived tabs). */
  archived?: boolean;
  /** BACKEND PENDING: GET /templates (the card thumbnail's header colour). */
  accent?: string;
  /** BACKEND PENDING: GET /templates (whether the thumbnail has a hero image). */
  hero?: boolean;
  /** BACKEND PENDING: PATCH /templates/:id (F2b Settings). */
  defaultSenderId?: string | null;
  /** BACKEND PENDING: PATCH /templates/:id (F2b Settings). */
  language?: string;
}

export interface MergeTag {
  field: string;
  default: string;
  required: boolean;
}

/** A campaign that sent, or will send, one version — F2b's version card. */
export interface VersionCampaign {
  id: string;
  name: string;
  status: string;
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

  /** BACKEND PENDING: GET /templates/:id — the header line ("Saved 2 min ago"). */
  savedLabel?: string;
  /** BACKEND PENDING: GET /templates/:id — the history card's fuller line. */
  historyLabel?: string;
  /** BACKEND PENDING: GET /templates/:id ("Published 15 Sep 2026, 14:20 by Farah Al-Mansoori"). */
  publishedLabel?: string;
  /** BACKEND PENDING: GET /templates/:id (the campaigns this version is used by). */
  campaigns?: VersionCampaign[];
}

export interface TemplateDetail {
  template: Template;
  /** Newest first. */
  versions: TemplateVersion[];
}

export interface Preview {
  subject: string;
  html: string;
  text: string;
  templateVersionId: string;
  version: number;
  published: boolean;
  /** BACKEND PENDING: POST /templates/versions/:versionId/preview (the inbox line). */
  preheader?: string;
  /** BACKEND PENDING: POST /templates/versions/:versionId/preview ("Northwind Voyages <hello@…>"). */
  fromName?: string;
  fromEmail?: string;
}

export interface PreviewContact {
  firstName?: string;
  lastName?: string;
  email?: string;
}

export const templateApi = {
  list: () => api.get<Template[]>('/templates'),

  get: (id: string) => api.get<TemplateDetail>(`/templates/${id}`),

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

  /**
   * BACKEND PENDING: PATCH /templates/:id accepts `name` only.
   *
   * F2b's Settings tab also sets the default sender and the language, which
   * have no column yet. Sent on the same route so there is one place to widen.
   */
  updateSettings: (id: string, input: { defaultSenderId?: string | null; language?: string }) =>
    api.patch<Template>(`/templates/${id}`, input),

  remove: (id: string) => api.delete<void>(`/templates/${id}`),

  /** BACKEND PENDING: POST /templates/:id/archive */
  archive: (id: string) => api.post<Template>(`/templates/${id}/archive`),

  /** BACKEND PENDING: POST /templates/:id/unarchive */
  unarchive: (id: string) => api.post<Template>(`/templates/${id}/unarchive`),

  /** BACKEND PENDING: POST /templates/:id/duplicate */
  duplicate: (id: string) => api.post<Template>(`/templates/${id}/duplicate`),

  saveVersion: (
    id: string,
    input: { subject: string; html: string; text?: string; preheader?: string },
  ) => api.post<TemplateVersion>(`/templates/${id}/versions`, input),

  publish: (versionId: string) =>
    api.post<TemplateVersion>(`/templates/versions/${versionId}/publish`),

  /** BACKEND PENDING: POST /templates/versions/:versionId/test */
  sendTest: (versionId: string, to: string) =>
    api.post<{ accepted: boolean }>(`/templates/versions/${versionId}/test`, { to }),

  preview: (versionId: string, contact: PreviewContact = {}) =>
    api.post<Preview>(`/templates/versions/${versionId}/preview`, contact),
};

export const templateKeys = {
  /**
   * Unscoped, and kept: `routes/campaigns/wizard.tsx` spreads it
   * (`[currentWorkspaceId, ...templateKeys.all]`) and is a shared contract
   * this section does not own.
   */
  all: ['templates'] as const,
  /** Kept for the same reason — the wizard reads one template by id. */
  one: (id: string) => ['templates', id] as const,

  scoped: (workspaceId: string | null) => [workspaceId, 'templates'] as const,
  list: (workspaceId: string | null) => [workspaceId, 'templates', 'list'] as const,
  detail: (workspaceId: string | null, id: string) =>
    [workspaceId, 'templates', id] as const,
  preview: (workspaceId: string | null, versionId: string, contact: unknown) =>
    [workspaceId, 'templates', 'preview', versionId, contact] as const,
};

/* ------------------------------------------------------------ merge tags -- */

export interface MergeTagOption {
  /** The token exactly as it is written into the HTML. */
  token: string;
  /** The description under it in the picker. */
  hint: string;
  /** The amber "required" pill: the one tag every template must carry. */
  required?: boolean;
}

/**
 * The picker's list, verbatim from F2a ("MERGE TAGS · FALLBACK IN QUOTES").
 *
 * A fixed list rather than one derived from the workspace's contact
 * attributes: those vary per contact, and offering a tag most of the audience
 * cannot satisfy is how a campaign goes out addressed to "". A custom
 * attribute outside this list is typed by hand, deliberately.
 *
 * The tokens are content. They are written into the source and rendered
 * literally everywhere in the app — only the preview endpoint interpolates
 * them, and only server-side.
 */
export const MERGE_TAGS: readonly MergeTagOption[] = [
  { token: '{{first_name|"there"}}', hint: 'Contact first name, fallback “there”' },
  { token: '{{last_name|""}}', hint: 'Contact last name' },
  { token: '{{loyalty_tier|"Member"}}', hint: 'Custom attribute' },
  { token: '{{home_airport|"DXB"}}', hint: 'Custom attribute' },
  { token: '{{unsubscribe_url}}', hint: 'One-click unsubscribe page', required: true },
  { token: '{{preferences_url}}', hint: 'Manage preferences' },
  { token: '{{view_in_browser_url}}', hint: 'Hosted copy of this email' },
];

/**
 * The system tags, which have no fallback because they always resolve.
 *
 * Used by the lint: a `{{first_name}}` with no `|` is a merge tag missing its
 * fallback; a `{{unsubscribe_url}}` with no `|` is correct.
 */
export const SYSTEM_TAGS: readonly string[] = [
  'unsubscribe_url',
  'preferences_url',
  'view_in_browser_url',
];

/* --------------------------------------------------------- preview people -- */

export interface PreviewPerson extends PreviewContact {
  id: string;
  /** "Amira Khalil · Gold · DXB" — the label in F2a's "Preview as". */
  label: string;
}

/**
 * BACKEND PENDING: GET /templates/preview-contacts.
 *
 * F2a previews as a named contact so an author sees what a real fallback
 * looks like rather than a row of empty strings. There is no endpoint that
 * returns a representative sample yet, so the personas are fixed.
 */
export const PREVIEW_PEOPLE: readonly PreviewPerson[] = [
  {
    id: 'amira',
    label: 'Amira Khalil · Gold · DXB',
    firstName: 'Amira',
    lastName: 'Khalil',
    email: 'amira.khalil@example.com',
  },
  {
    id: 'aisha',
    label: 'Aisha Khan · Silver · LHR',
    firstName: 'Aisha',
    lastName: 'Khan',
    email: 'aisha.khan@example.com',
  },
  {
    id: 'anonymous',
    label: 'Contact with no attributes',
    email: 'no-attributes@example.com',
  },
];

/** The starter a new template opens with. */
export const STARTER_SUBJECT = 'Hi {{first_name|"there"}}';
export const STARTER_HTML = `<!doctype html>
<html lang="en">
<body style="margin:0;background:#F7F8FC;font-family:Inter,Arial,sans-serif">
  <table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0">
    <tr><td style="padding:28px">
      <h1 style="font-size:22px;margin:0">Write your headline</h1>
      <p>Hi {{first_name|"there"}}, write your message here.</p>
    </td></tr>
    <tr><td style="padding:20px 28px;font-size:12px;color:#6B7280">
      <a href="{{unsubscribe_url}}">Unsubscribe</a>
      · <a href="{{preferences_url}}">Preferences</a>
    </td></tr>
  </table>
</body>
</html>`;
