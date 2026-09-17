import { apiRequestEnvelope, api } from './client.js';

/**
 * The audience endpoints, typed.
 *
 * Kept apart from the pages so a component never builds a URL. The list
 * endpoints are cursor-paginated, never offset: an audience is being written
 * to while it is being read, and an offset page silently skips or repeats
 * contacts when a row is inserted between two requests.
 */

export type ContactStatus = 'subscribed' | 'unsubscribed' | 'bounced' | 'complained' | 'cleaned';

export interface Contact {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: ContactStatus;
  attributes: Record<string, unknown>;
  createdAt: string;
}

export interface ContactPage {
  contacts: Contact[];
  nextCursor?: string;
}

export interface ContactList {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  createdAt: string;
}

export interface Suppression {
  id: string;
  email: string;
  reason: 'unsubscribe' | 'hard_bounce' | 'complaint' | 'manual' | 'invalid';
  notes: string | null;
  createdAt: string;
}

export type ImportStatus =
  | 'pending'
  | 'mapping'
  | 'validating'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ImportJob {
  id: string;
  originalFilename: string;
  fileType: 'csv' | 'tsv' | 'xlsx';
  status: ImportStatus;
  columnMapping: Record<string, string> | null;
  totalRows: number | null;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface ImportRowError {
  rowNumber: number;
  columnName?: string;
  errorCode: string;
  message: string;
  rawValue?: string;
}

/** The fields an import column can be mapped onto. */
export const CONTACT_FIELDS = [
  { value: 'email', label: 'Email address' },
  { value: 'firstName', label: 'First name' },
  { value: 'lastName', label: 'Last name' },
] as const;

/**
 * A raw response, for the list endpoints that carry pagination in `meta`.
 *
 * apiRequest unwraps `data` and discards `meta`, which is right for every
 * other call and wrong for these.
 */
async function getPage<T>(path: string): Promise<{ data: T[]; nextCursor?: string }> {
  const envelope = await apiRequestEnvelope<T[]>(path, { method: 'GET' });
  return {
    data: envelope.data,
    ...(envelope.meta?.nextCursor === undefined ? {} : { nextCursor: envelope.meta.nextCursor }),
  };
}

export const audienceApi = {
  listContacts: (params: { limit?: number; cursor?: string; status?: ContactStatus }) => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.cursor !== undefined) query.set('cursor', params.cursor);
    if (params.status !== undefined) query.set('status', params.status);
    const suffix = query.toString();
    return getPage<Contact>(`/audience/contacts${suffix === '' ? '' : `?${suffix}`}`);
  },

  createContact: (input: {
    email: string;
    firstName?: string;
    lastName?: string;
  }) => api.post<Contact & { wasCreated: boolean; suppressed: boolean }>('/audience/contacts', input),

  updateContact: (id: string, patch: { status?: ContactStatus; firstName?: string; lastName?: string }) =>
    api.patch<Contact>(`/audience/contacts/${id}`, patch),

  deleteContact: (id: string) => api.delete<void>(`/audience/contacts/${id}`),

  listLists: () => api.get<ContactList[]>('/audience/lists'),
  createList: (input: { name: string; description?: string }) =>
    api.post<ContactList>('/audience/lists', input),
  deleteList: (id: string) => api.delete<void>(`/audience/lists/${id}`),

  listTags: () => api.get<Tag[]>('/audience/tags'),
  createTag: (input: { name: string; color?: string }) => api.post<Tag>('/audience/tags', input),
  deleteTag: (id: string) => api.delete<void>(`/audience/tags/${id}`),

  listSuppressions: () => api.get<Suppression[]>('/audience/suppressions'),
  createSuppression: (input: { email: string; reason?: Suppression['reason']; notes?: string }) =>
    api.post<Suppression>('/audience/suppressions', input),
  deleteSuppression: (id: string) => api.delete<void>(`/audience/suppressions/${id}`),

  listImports: () => api.get<ImportJob[]>('/audience/imports'),
  getImport: (id: string) => api.get<ImportJob>(`/audience/imports/${id}`),
  listImportErrors: (id: string) => api.get<ImportRowError[]>(`/audience/imports/${id}/errors`),
  cancelImport: (id: string) => api.post<ImportJob>(`/audience/imports/${id}/cancel`),

  createImport: (input: { filename: string; byteSize: number; fileType: 'csv' | 'tsv' | 'xlsx' }) =>
    api.post<{
      id: string;
      status: ImportStatus;
      upload: { url: string; expiresInSeconds: number };
    }>('/audience/imports', input),

  setImportMapping: (
    id: string,
    input: {
      mapping: Record<string, string>;
      options: {
        updateExisting: boolean;
        addToListIds: string[];
        tagIds: string[];
        consentDeclaration: string;
      };
    },
  ) => api.post<ImportJob>(`/audience/imports/${id}/mapping`, input),
};

/** Query keys, in one place so an invalidation cannot miss a page. */
export const audienceKeys = {
  contacts: (filters: { status?: ContactStatus; cursor?: string }) =>
    ['audience', 'contacts', filters] as const,
  lists: ['audience', 'lists'] as const,
  tags: ['audience', 'tags'] as const,
  suppressions: ['audience', 'suppressions'] as const,
  imports: ['audience', 'imports'] as const,
  import: (id: string) => ['audience', 'imports', id] as const,
  importErrors: (id: string) => ['audience', 'imports', id, 'errors'] as const,
};
