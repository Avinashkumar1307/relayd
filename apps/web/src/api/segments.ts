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
 * `apps/api/src/routes/audience.ts` serves GET/POST `/segments`,
 * PATCH/DELETE `/segments/:id`, POST `/segments/preview` and
 * POST `/segments/:id/preview` — every call below reaches a real route.
 * Two fields are still missing and are marked at their declarations:
 * `Segment.lastUsedLabel` and `SegmentPreview.sample`. They are optional
 * here so the page renders correctly against both the preview server,
 * which supplies them, and the real API, which does not.
 */

export interface Segment {
  id: string;
  name: string;
  definition: SegmentNode | null;
  /** The last preview count the server cached. Null until one is computed. */
  cachedCount: number | null;
  cachedAt: string | null;
  createdAt: string;
  /** Bumped on every save; D5a's "Updated" column. */
  updatedAt: string;
  /**
   * BACKEND PENDING: `GET /segments` has no `lastUsedLabel` field. The
   * endpoint is real; this one needs a record of which campaign last sent
   * to a segment, which nothing writes, so D5a's "Last used" reads "-".
   */
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
  /** The denominator D5b prints: "of 45,102 subscribed". */
  subscribedTotal: number;
  /**
   * BACKEND PENDING: `POST /segments/preview` has no `sample` field. The
   * endpoint is real; a sample needs a compiler entry point that selects
   * rows rather than counting them (`compilePreviewCount` only counts), so
   * D5b's sample panel stays empty.
   */
  sample?: SegmentSample[];
}

export const segmentApi = {
  list: () => api.get<Segment[]>('/segments'),

  create: (input: { name: string; definition: SegmentNode }) =>
    api.post<Segment>('/segments', input),

  update: (id: string, input: { name: string; definition: SegmentNode }) =>
    api.patch<Segment>(`/segments/${id}`, input),

  remove: (id: string) => api.delete<void>(`/segments/${id}`),

  /** The count for a definition being edited, before it is saved. */
  preview: (definition: SegmentNode) =>
    api.post<SegmentPreview>('/segments/preview', { definition }),

  previewSaved: (id: string) => api.post<SegmentPreview>(`/segments/${id}/preview`),
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
