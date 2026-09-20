import type { SegmentNode } from '@relayd/audience/browser';
import { api } from './client.js';

/**
 * Segment endpoints.
 *
 * Kept apart from `audience.ts` so the segment builder — the one page in the
 * audience section with a wire format of its own — owns its types. The wire
 * format is the AST from `@relayd/audience/browser`: the same schema the API
 * validates with and the same one the SQL compiler reads, so the builder
 * cannot produce a definition the server would refuse for a shape reason.
 *
 * ## What the backend has, and what D5 needs that it does not
 *
 * `apps/api/src/routes/audience.ts` serves GET/POST `/audience/segments`,
 * DELETE `/audience/segments/:id`, POST `/audience/segments/preview` and
 * POST `/audience/segments/:id/preview`. The fields marked BACKEND PENDING
 * below are drawn on frame D5a/D5b and have no column or endpoint yet; they
 * are optional here so the page renders correctly against both the mocked
 * API, which supplies them, and the real one, which does not.
 */

export interface Segment {
  id: string;
  name: string;
  definition: SegmentNode | null;
  /** The last preview count the server cached. Null until one is computed. */
  cachedCount: number | null;
  cachedAt: string | null;
  createdAt: string;
  /** BACKEND PENDING: GET /audience/segments (no `updated_at` column yet). */
  updatedAt?: string;
  /** BACKEND PENDING: GET /audience/segments (the D5a "Last used" column). */
  lastUsedLabel?: string | null;
}

/** A row of the D5b "Sample" panel. */
export interface SegmentSample {
  email: string;
  /** "AE · engaged 2d ago" — the right-hand meta on each sample row. */
  meta: string;
}

export interface SegmentPreview {
  count: number;
  /** True when the count stopped at `cap`; the UI then says "up to". */
  capped: boolean;
  cap: number;
  /** BACKEND PENDING: POST /audience/segments/preview ("of 45,102 subscribed"). */
  subscribedTotal?: number;
  /** BACKEND PENDING: POST /audience/segments/preview (the D5b sample panel). */
  sample?: SegmentSample[];
}

export const segmentApi = {
  list: () => api.get<Segment[]>('/audience/segments'),

  create: (input: { name: string; definition: SegmentNode }) =>
    api.post<Segment>('/audience/segments', input),

  /** BACKEND PENDING: PATCH /audience/segments/:id — saving an edit. */
  update: (id: string, input: { name: string; definition: SegmentNode }) =>
    api.patch<Segment>(`/audience/segments/${id}`, input),

  remove: (id: string) => api.delete<void>(`/audience/segments/${id}`),

  /** The count for a definition being edited, before it is saved. */
  preview: (definition: SegmentNode) =>
    api.post<SegmentPreview>('/audience/segments/preview', { definition }),

  previewSaved: (id: string) => api.post<SegmentPreview>(`/audience/segments/${id}/preview`),
};

/** Query keys, in one place so an invalidation cannot miss a page. */
export const segmentKeys = {
  all: ['audience', 'segments'] as const,
  /**
   * The live preview is keyed by the definition itself.
   *
   * Keying by segment id instead would serve the previous count while the
   * user edits a value — and a count that lags the rules it claims to
   * describe is worse than no count, because it reads as settled.
   */
  preview: (definition: unknown) => ['audience', 'segments', 'preview', definition] as const,
};
