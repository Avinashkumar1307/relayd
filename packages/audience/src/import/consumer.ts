import { parseDelimited } from './csv-parser.js';
import { importRows } from './pipeline.js';
import { readXlsxRows } from './xlsx-reader.js';
import type { ParsedRow } from './csv-parser.js';
import type { ImportCallbacks, ImportSink, ImportSummary, RowFailure } from './pipeline.js';
import type { XlsxOptions } from './xlsx-reader.js';

/**
 * The contact-import consumer.
 *
 * Written as a plain function rather than a BullMQ processor because the queue
 * itself is declared in Phase 5, with the explicit settings CLAUDE.md section 9
 * demands. Registering it there is three lines; everything that can be wrong
 * about an import is in here, where it can be tested without Redis.
 */

export type ImportFileType = 'csv' | 'tsv' | 'xlsx';

/**
 * Where the uploaded file comes from.
 *
 * Two methods rather than one because the formats genuinely differ. A
 * delimited file is read forwards and never needs to exist locally. An xlsx is
 * a zip, and a zip's central directory is at the end, so it has to land on
 * disk first. Production fulfils both from S3; local development from the
 * filesystem.
 */
export interface ImportFileSource {
  openStream(key: string): Promise<AsyncIterable<Uint8Array>>;
  downloadToFile(key: string): Promise<{ path: string; cleanup: () => Promise<void> }>;
}

/**
 * The job's own row, already bound to a workspace scope by the caller.
 *
 * Bound rather than scope-taking on purpose: the worker opens one scoped
 * transaction and hands this in, so nothing in this package ever holds a
 * WorkspaceScope or could forget to pass one.
 */
export interface ImportJobStore {
  /** A guarded transition. False means another attempt owns this job. */
  transition(
    from: readonly string[],
    to: string,
    fields?: { totalRows?: number; startedAt?: Date; completedAt?: Date },
  ): Promise<boolean>;
  addProgress(delta: {
    processed?: number;
    created?: number;
    updated?: number;
    skipped?: number;
    failed?: number;
  }): Promise<void>;
  recordRowErrors(errors: readonly RowFailure[]): Promise<number>;
}

export interface ContactImportJob {
  /** Object key of the uploaded file. */
  key: string;
  fileType: ImportFileType;
  /** Source column (normalised) to contact field. */
  mapping: Record<string, string>;
  updateExisting: boolean;
  batchSize?: number;
  maxTrackedEmails?: number;
  xlsx?: XlsxOptions;
}

export interface ContactImportDeps {
  source: ImportFileSource;
  sink: ImportSink;
  jobs: ImportJobStore;
  now?: () => Date;
}

export type ImportOutcome =
  | { status: 'completed'; summary: ImportSummary }
  | { status: 'failed'; summary: ImportSummary; error: Error }
  | { status: 'skipped'; reason: 'not_claimable' };

/** States from which an import may legitimately start processing. */
const CLAIMABLE = ['pending', 'mapping', 'validating'] as const;

/**
 * Runs one import job.
 *
 * The claim is the durable idempotency guard (CLAUDE.md section 9): a guarded
 * UPDATE that moves the job into `processing` only from a state that has not
 * started. A redelivered job finds zero rows updated and exits cleanly rather
 * than importing the same file twice. BullMQ's own job id is a dedupe
 * optimisation and is never relied on for this.
 */
export async function runContactImport(
  job: ContactImportJob,
  deps: ContactImportDeps,
): Promise<ImportOutcome> {
  const now = deps.now ?? ((): Date => new Date());

  const claimed = await deps.jobs.transition([...CLAIMABLE], 'processing', { startedAt: now() });
  if (!claimed) return { status: 'skipped', reason: 'not_claimable' };

  let cleanup: (() => Promise<void>) | null = null;

  // Progress is reported as deltas because two batches completing out of
  // order must not lose one another's counts. The summary is cumulative, so
  // the difference since the last report is what gets sent.
  const reported = { processed: 0, created: 0, updated: 0, skipped: 0, failed: 0 };

  const callbacks: ImportCallbacks = {
    onProgress: async (summary) => {
      const delta = {
        processed: summary.totalRows - reported.processed,
        created: summary.created - reported.created,
        updated: summary.updated - reported.updated,
        skipped: summary.skipped - reported.skipped,
        failed: summary.failed - reported.failed,
      };

      reported.processed = summary.totalRows;
      reported.created = summary.created;
      reported.updated = summary.updated;
      reported.skipped = summary.skipped;
      reported.failed = summary.failed;

      await deps.jobs.addProgress(delta);
    },
    onFailures: async (failures) => {
      // Bounded inside the repository: a file where every row is malformed
      // must not become a half-million-row error table.
      await deps.jobs.recordRowErrors(failures);
    },
  };

  let summary: ImportSummary = {
    totalRows: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    duplicatesInFile: 0,
    duplicateTrackingTruncated: false,
  };

  try {
    let rows: AsyncIterable<ParsedRow>;

    if (job.fileType === 'xlsx') {
      const downloaded = await deps.source.downloadToFile(job.key);
      cleanup = downloaded.cleanup;
      rows = readXlsxRows(downloaded.path, job.xlsx ?? {});
    } else {
      const stream = await deps.source.openStream(job.key);
      rows = parseDelimited(stream, { delimiter: job.fileType === 'tsv' ? '\t' : ',' });
    }

    summary = await importRows(
      rows,
      deps.sink,
      {
        mapping: job.mapping,
        ...(job.batchSize === undefined ? {} : { batchSize: job.batchSize }),
        ...(job.maxTrackedEmails === undefined
          ? {}
          : { maxTrackedEmails: job.maxTrackedEmails }),
      },
      callbacks,
    );

    // A final flush: the last partial batch reports through onProgress, but
    // rows that failed after it do not.
    await flushRemainder(deps, summary, reported);

    await deps.jobs.transition(['processing'], 'completed', {
      totalRows: summary.totalRows,
      completedAt: now(),
    });

    return { status: 'completed', summary };
  } catch (error) {
    // The counters written so far are kept deliberately. A file that failed
    // at row 400,000 really did import the first 399,999, and hiding that
    // makes the retry look like a duplicate import to the customer.
    await flushRemainder(deps, summary, reported).catch(() => undefined);

    await deps.jobs.transition(['processing'], 'failed', {
      totalRows: summary.totalRows,
      completedAt: now(),
    });

    return {
      status: 'failed',
      summary,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    if (cleanup) await cleanup().catch(() => undefined);
  }
}

async function flushRemainder(
  deps: ContactImportDeps,
  summary: ImportSummary,
  reported: { processed: number; created: number; updated: number; skipped: number; failed: number },
): Promise<void> {
  const delta = {
    processed: summary.totalRows - reported.processed,
    created: summary.created - reported.created,
    updated: summary.updated - reported.updated,
    skipped: summary.skipped - reported.skipped,
    failed: summary.failed - reported.failed,
  };

  if (Object.values(delta).every((value) => value === 0)) return;

  reported.processed = summary.totalRows;
  reported.created = summary.created;
  reported.updated = summary.updated;
  reported.skipped = summary.skipped;
  reported.failed = summary.failed;

  await deps.jobs.addProgress(delta);
}
