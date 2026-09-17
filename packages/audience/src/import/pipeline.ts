import { looksLikeFormula } from '../export/csv.js';
import { normaliseHeader, parseDelimited, CsvParseError } from './csv-parser.js';
import type { ParseOptions, ParsedRow } from './csv-parser.js';

/**
 * The import pipeline: bytes in, batches of normalised contacts out.
 *
 * Everything that touches the database is behind ImportSink, so the pipeline
 * itself is testable without one and the COPY-and-merge strategy can change
 * without rewriting parsing, validation or deduplication.
 *
 * Memory is bounded by batchSize, not by file size. Nothing here accumulates
 * per row except the seen-email set, which is discussed below.
 */

export interface NormalisedContact {
  rowNumber: number;
  email: string;
  firstName?: string;
  lastName?: string;
  attributes: Record<string, string>;
  /** True when a cell would be treated as a formula by a spreadsheet. */
  flagged: boolean;
}

export interface RowFailure {
  rowNumber: number;
  columnName?: string;
  errorCode: string;
  message: string;
  rawValue?: string;
}

export interface BatchResult {
  created: number;
  updated: number;
  /** Already present and not updated, or otherwise deliberately not written. */
  skipped: number;
}

export interface ImportSink {
  /**
   * Writes one batch. Implementations COPY into a staging table and merge;
   * the pipeline neither knows nor cares.
   */
  writeBatch(rows: readonly NormalisedContact[]): Promise<BatchResult>;
}

export interface ImportOptions {
  /** Source column (normalised) to contact field. */
  mapping: Record<string, 'email' | 'firstName' | 'lastName' | string>;
  batchSize?: number;
  delimiter?: string;
  parse?: ParseOptions;
  /**
   * Bounds the in-file duplicate check.
   *
   * Deduplication needs to remember every address seen so far, which is the
   * one thing in this pipeline that grows with the file. At 500,000 rows a
   * Set of addresses is roughly 30-50 MB — acceptable, and far cheaper than
   * a round trip per row. Beyond this bound the check is disabled rather than
   * allowed to exhaust the worker, and the database unique index still
   * catches duplicates; they simply cost more.
   */
  maxTrackedEmails?: number;
}

export interface ImportSummary {
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  duplicatesInFile: number;
  /** True when the in-file duplicate check was abandoned, see above. */
  duplicateTrackingTruncated: boolean;
}

export interface ImportCallbacks {
  onFailures?: (failures: readonly RowFailure[]) => Promise<void> | void;
  onProgress?: (summary: ImportSummary) => Promise<void> | void;
}

const DEFAULT_BATCH = 1_000;
const DEFAULT_MAX_TRACKED = 2_000_000;

/**
 * RFC 5322 is not worth implementing here.
 *
 * This checks the shape that actually matters — one @, something either side,
 * a dot in the domain, no whitespace — and lets the provider reject the rest.
 * docs/03 makes the MX check advisory for the same reason: a rejected valid
 * address is a lost customer contact, while an accepted invalid one costs one
 * bounce.
 */
const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/u;

export function isPlausibleEmail(value: string): boolean {
  return value.length <= 320 && EMAIL_SHAPE.test(value);
}

/**
 * Runs an import from a byte stream.
 *
 * Failures are reported in batches through onFailures rather than thrown, so
 * one malformed row does not abandon 499,999 good ones. Only a failure that
 * makes the rest of the file meaningless — an unclosed quote, a missing email
 * column — stops the run.
 */
export async function runImport(
  source: AsyncIterable<Uint8Array>,
  sink: ImportSink,
  options: ImportOptions,
  callbacks: ImportCallbacks = {},
): Promise<ImportSummary> {
  const parseOptions: ParseOptions = {
    ...options.parse,
    ...(options.delimiter === undefined ? {} : { delimiter: options.delimiter }),
  };

  return importRows(parseDelimited(source, parseOptions), sink, options, callbacks);
}

/**
 * The same import, from rows that have already been parsed.
 *
 * XLSX cannot be read as a byte stream — a zip's central directory is at the
 * end of the file — so the spreadsheet reader yields rows directly and enters
 * here. Everything after parsing is identical for both formats, which is the
 * point: a customer who uploads the same data as .csv and as .xlsx gets the
 * same contacts, the same duplicates and the same errors.
 */
export async function importRows(
  rows: AsyncIterable<ParsedRow>,
  sink: ImportSink,
  options: ImportOptions,
  callbacks: ImportCallbacks = {},
): Promise<ImportSummary> {
  const batchSize = Math.min(Math.max(options.batchSize ?? DEFAULT_BATCH, 1), 5_000);
  const maxTracked = options.maxTrackedEmails ?? DEFAULT_MAX_TRACKED;

  const summary: ImportSummary = {
    totalRows: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    duplicatesInFile: 0,
    duplicateTrackingTruncated: false,
  };

  let header: string[] | null = null;
  let emailIndex = -1;
  const fieldByIndex = new Map<number, string>();

  const seenEmails = new Set<string>();
  let batch: NormalisedContact[] = [];
  let failures: RowFailure[] = [];

  const flushFailures = async (): Promise<void> => {
    if (failures.length === 0) return;
    await callbacks.onFailures?.(failures);
    failures = [];
  };

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    const result = await sink.writeBatch(batch);
    summary.created += result.created;
    summary.updated += result.updated;
    summary.skipped += result.skipped;
    batch = [];
    await callbacks.onProgress?.({ ...summary });
  };

  for await (const row of rows) {
    if (header === null) {
      header = row.cells.map(normaliseHeader);

      for (const [sourceColumn, field] of Object.entries(options.mapping)) {
        const index = header.indexOf(normaliseHeader(sourceColumn));
        if (index === -1) continue;
        if (field === 'email') emailIndex = index;
        else fieldByIndex.set(index, field);
      }

      if (emailIndex === -1) {
        // Fatal: without an address there is nothing to import, and
        // continuing would report 500,000 identical row failures.
        throw new CsvParseError(
          'No column is mapped to the email field, so there is nothing to import',
          1,
        );
      }
      continue;
    }

    summary.totalRows += 1;

    const rawEmail = (row.cells[emailIndex] ?? '').trim();
    const email = rawEmail.toLowerCase();

    if (email === '') {
      summary.failed += 1;
      failures.push({
        rowNumber: row.rowNumber,
        columnName: 'email',
        errorCode: 'email_missing',
        message: 'This row has no email address',
      });
    } else if (!isPlausibleEmail(email)) {
      summary.failed += 1;
      failures.push({
        rowNumber: row.rowNumber,
        columnName: 'email',
        errorCode: 'email_invalid',
        message: 'This does not look like an email address',
        rawValue: rawEmail.slice(0, 200),
      });
    } else if (seenEmails.has(email)) {
      // Earlier wins. The alternative — last wins — means the outcome of an
      // import depends on row order in a file the user did not sort.
      summary.duplicatesInFile += 1;
      summary.skipped += 1;
      failures.push({
        rowNumber: row.rowNumber,
        columnName: 'email',
        errorCode: 'duplicate_in_file',
        message: 'This address appears earlier in the file; the first row was used',
        rawValue: rawEmail.slice(0, 200),
      });
    } else {
      if (seenEmails.size < maxTracked) seenEmails.add(email);
      else summary.duplicateTrackingTruncated = true;

      const contact = normaliseRow(row.rowNumber, row.cells, email, fieldByIndex);
      batch.push(contact);

      if (batch.length >= batchSize) await flushBatch();
    }

    if (failures.length >= batchSize) await flushFailures();
  }

  await flushBatch();
  await flushFailures();

  return summary;
}

function normaliseRow(
  rowNumber: number,
  cells: readonly string[],
  email: string,
  fieldByIndex: ReadonlyMap<number, string>,
): NormalisedContact {
  const attributes: Record<string, string> = {};
  let firstName: string | undefined;
  let lastName: string | undefined;
  let flagged = false;

  for (const [index, field] of fieldByIndex) {
    const value = (cells[index] ?? '').trim();
    if (value === '') continue;

    // docs/06: formula-shaped values on import are "stored as-is but flagged,
    // never evaluated". Flagging here is what lets the UI warn, and the
    // export path neutralises the same values on the way out.
    if (looksLikeFormula(value)) flagged = true;

    if (field === 'firstName') firstName = value;
    else if (field === 'lastName') lastName = value;
    else attributes[field] = value;
  }

  return {
    rowNumber,
    email,
    attributes,
    flagged,
    ...(firstName === undefined ? {} : { firstName }),
    ...(lastName === undefined ? {} : { lastName }),
  };
}
