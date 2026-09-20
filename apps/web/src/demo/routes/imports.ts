import type { Route, Row } from '../state.js';
import { find, id, nowIso, state } from '../state.js';
import { importErrors } from '../data/imports.js';

/**
 * Section D demo routes: contact imports.
 *
 * DEMO ONLY. The `/errors` and `/upload` patterns are declared before the
 * bare `/audience/imports/:id` one because the first match wins and the
 * dynamic segment would otherwise swallow them.
 *
 * POST answers with an upload envelope rather than the job row: the real API
 * hands back a signed URL the browser uploads to directly, and the page is
 * written against that shape. The URL points back through `/api/v1` so the
 * demo transport answers it — anything else leaves the preview's upload
 * hanging on a host that does not exist.
 */

/** Jobs that have been started. A draft waiting to be mapped is not history. */
const STARTED = ['validating', 'processing', 'completed', 'failed', 'cancelled'];

const asNumber = (value: unknown): number => (typeof value === 'number' ? value : 0);

/**
 * Advances a job the previewer started, so stage 4 actually moves.
 *
 * Only jobs marked `simulated` advance: `imp_3c8v2` is the snapshot D6d was
 * drawn from and has to keep its numbers, or the frame and the preview stop
 * being comparable.
 */
function advance(job: Row): Row {
  if (job['simulated'] !== true || job['status'] !== 'processing') return job;

  const total = asNumber(job['totalRows']);
  const processed = Math.min(total, asNumber(job['processedRows']) + Math.ceil(total / 12));
  const created = Math.round(processed * 0.86);
  const updated = Math.round(processed * 0.08);
  const skipped = Math.round(processed * 0.03);

  job['processedRows'] = processed;
  job['createdCount'] = created;
  job['updatedCount'] = updated;
  job['skippedCount'] = skipped;
  job['failedCount'] = processed - created - updated - skipped;

  if (processed >= total) {
    job['status'] = 'completed';
    job['completedAt'] = nowIso();
  }

  return job;
}

export const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/audience\/imports$/u,
    handler: () => state.imports.filter((job) => STARTED.includes(String(job['status']))).map(advance),
  },
  {
    method: 'GET',
    pattern: /^\/audience\/imports\/([^/]+)\/errors$/u,
    handler: (m) => importErrors[m[1] ?? ''] ?? [],
  },
  {
    method: 'PUT',
    pattern: /^\/audience\/imports\/([^/]+)\/upload$/u,
    handler: () => ({ ok: true }),
  },
  {
    method: 'GET',
    pattern: /^\/audience\/imports\/([^/]+)$/u,
    handler: (m) => {
      const job = find(state.imports, m[1] ?? '');
      return job === undefined ? (state.imports[1] as Row) : advance(job);
    },
  },
  {
    method: 'POST',
    pattern: /^\/audience\/imports\/([^/]+)\/mapping$/u,
    handler: (m, body) => {
      const job = find(state.imports, m[1] ?? '');
      if (job === undefined) return {};

      const input = body as { mapping?: Record<string, string> } | undefined;
      job['columnMapping'] = input?.mapping ?? job['columnMapping'];
      job['status'] = 'processing';
      job['simulated'] = true;
      job['totalRows'] = job['rowCount'] ?? 14_286;
      job['processedRows'] = 0;
      job['createdCount'] = 0;
      job['updatedCount'] = 0;
      job['skippedCount'] = 0;
      job['failedCount'] = 0;
      job['attestedBy'] = 'Dana Haddad';
      job['createdAt'] = nowIso();
      return job;
    },
  },
  {
    method: 'POST',
    pattern: /^\/audience\/imports\/([^/]+)\/cancel$/u,
    handler: (m) => {
      const job = find(state.imports, m[1] ?? '');
      if (job === undefined) return {};
      job['status'] = 'cancelled';
      job['simulated'] = false;
      job['completedAt'] = nowIso();
      return job;
    },
  },
  {
    method: 'POST',
    pattern: /^\/audience\/imports$/u,
    handler: (_m, body) => {
      const input = body as { filename: string; fileType: string; byteSize?: number };
      const job: Row = {
        id: id('imp_'),
        originalFilename: input.filename,
        fileType: input.fileType,
        status: 'mapping',
        columnMapping: null,
        // The browser reads the real file's headers, so the demo deliberately
        // does not send a column analysis for a fresh upload: what the
        // mapping form shows is what was actually dropped on it.
        totalRows: null,
        processedRows: 0,
        createdCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        createdAt: nowIso(),
        completedAt: null,
        byteSize: input.byteSize ?? 0,
        encoding: 'UTF-8',
        rowCount: 14_286,
        invalidEmailCount: 412,
        existingEmailCount: 1_104,
        suppressedCount: 86,
        contactsAfter: 60_983,
        contactLimit: 100_000,
      };

      state.imports.unshift(job);
      return {
        id: job.id,
        status: 'mapping',
        upload: { url: `/api/v1/audience/imports/${job.id}/upload`, expiresInSeconds: 900 },
      };
    },
  },
];

/** SPA paths the demo smoke test walks for this section. */
export const previewPaths: string[] = [
  '/audience/imports',
  '/audience/imports?job=imp_draft',
  '/audience/imports?job=imp_draft&stage=consent',
  '/audience/imports/imp_3c8v2',
  '/audience/imports/imp_2b6x4',
];
