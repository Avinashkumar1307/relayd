import type { Route, Row } from '../state.js';
import { collection, id, nowIso } from '../state.js';
import { PREVIEW_CAP, SUBSCRIBED_TOTAL, previewSample, segments as seed } from '../data/segments.js';

/**
 * Section D demo routes: segments.
 *
 * DEMO ONLY. `/segments/preview` is declared before `/segments/:id/preview`
 * only for readability — the patterns are disjoint — but `/segments/:id`
 * must come after both, because the first match wins.
 */

const segments = (): Row[] => collection('segments', () => seed);

const saved = (wanted: string): Row | undefined => segments().find((row) => row.id === wanted);

/**
 * A count for a definition.
 *
 * A saved definition answers with the number the list page shows for it, so
 * opening a segment and previewing it agree. Anything else — a definition
 * being edited — is hashed into a plausible number, which is what makes the
 * live preview move as a value is typed rather than sit still and look
 * broken.
 */
function countFor(definition: unknown): number {
  const json = JSON.stringify(definition ?? null);

  const match = segments().find((row) => JSON.stringify(row['definition']) === json);
  if (match !== undefined) return Number(match['cachedCount'] ?? 0);

  let hash = 0;
  for (const character of json) hash = (hash * 31 + character.charCodeAt(0)) % 100_000;
  return 2_400 + (hash % 22_000);
}

function preview(definition: unknown): Record<string, unknown> {
  const count = countFor(definition);
  return {
    count,
    capped: count > PREVIEW_CAP,
    cap: PREVIEW_CAP,
    subscribedTotal: SUBSCRIBED_TOTAL,
    sample: previewSample.slice(0, Math.min(previewSample.length, count)),
  };
}

export const routes: Route[] = [
  { method: 'GET', pattern: /^\/segments$/u, handler: () => segments() },
  {
    method: 'POST',
    pattern: /^\/segments$/u,
    handler: (_m, body) => {
      const input = body as { name: string; definition: unknown };
      const row: Row = {
        id: id('seg_'),
        name: input.name,
        definition: input.definition,
        cachedCount: countFor(input.definition),
        cachedAt: nowIso(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastUsedLabel: null,
      };
      segments().unshift(row);
      return row;
    },
  },
  {
    method: 'POST',
    pattern: /^\/segments\/preview$/u,
    handler: (_m, body) => preview((body as { definition?: unknown } | undefined)?.definition),
  },
  {
    method: 'POST',
    pattern: /^\/segments\/([^/]+)\/preview$/u,
    handler: (m) => preview(saved(m[1] ?? '')?.['definition']),
  },
  {
    method: 'PATCH',
    pattern: /^\/segments\/([^/]+)$/u,
    handler: (m, body) => {
      const row = saved(m[1] ?? '');
      if (row === undefined) return {};
      const input = body as { name?: string; definition?: unknown };
      if (input.name !== undefined) row['name'] = input.name;
      if (input.definition !== undefined) {
        row['definition'] = input.definition;
        row['cachedCount'] = countFor(input.definition);
      }
      row['updatedAt'] = nowIso();
      return row;
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/segments\/([^/]+)$/u,
    handler: (m) => {
      const rows = segments();
      const index = rows.findIndex((row) => row.id === m[1]);
      if (index >= 0) rows.splice(index, 1);
      return {};
    },
  },
];

/** SPA paths the demo smoke test walks for this section. */
export const previewPaths: string[] = [
  '/audience/segments',
  '/audience/segments/new',
  '/audience/segments/seg_eu_eng',
];
