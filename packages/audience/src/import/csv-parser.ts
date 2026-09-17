/**
 * A streaming delimited-text parser.
 *
 * Written rather than taken from a dependency because the requirements are
 * specific and small: it must hold at most one row in memory regardless of
 * file size (BUILD-PLAN: "flat memory on 500k rows"), it must survive the
 * encodings real spreadsheets produce, and it must never silently drop a row
 * it could not understand — a row lost in an import is a contact who never
 * hears from the customer again, with no error to explain why.
 *
 * Implements RFC 4180 plus the deviations every real file contains:
 *   - a UTF-8 BOM, which Excel writes by default
 *   - CRLF, LF and bare CR line endings, sometimes in the same file
 *   - quoted fields containing delimiters, newlines and doubled quotes
 *   - a final row with no trailing newline
 */

export interface ParseOptions {
  /** Comma for CSV, tab for TSV. */
  delimiter?: string;
  /**
   * Refuses a field longer than this, rather than growing without bound.
   * An unterminated quote in a 100 MB file would otherwise buffer the whole
   * remainder as one field.
   */
  maxFieldBytes?: number;
  /** Refuses a row with more columns than this. */
  maxColumns?: number;
}

export interface ParsedRow {
  /** 1-based, counting the header, so it matches what the user sees. */
  rowNumber: number;
  cells: string[];
}

export class CsvParseError extends Error {
  override readonly name = 'CsvParseError';
  constructor(
    message: string,
    readonly rowNumber: number,
  ) {
    super(message);
  }
}

const DEFAULTS = {
  delimiter: ',',
  maxFieldBytes: 1024 * 64,
  maxColumns: 512,
} as const;

/**
 * Parses a byte stream into rows.
 *
 * Decoding is incremental: a multi-byte character split across two chunks is
 * held until the rest arrives, which a naive per-chunk toString() would
 * corrupt into replacement characters. That shows up in production as mangled
 * names in exactly the files customers care most about.
 */
export async function* parseDelimited(
  source: AsyncIterable<Uint8Array>,
  options: ParseOptions = {},
): AsyncGenerator<ParsedRow> {
  const delimiter = options.delimiter ?? DEFAULTS.delimiter;
  const maxFieldBytes = options.maxFieldBytes ?? DEFAULTS.maxFieldBytes;
  const maxColumns = options.maxColumns ?? DEFAULTS.maxColumns;

  const decoder = new TextDecoder('utf-8');

  let field = '';
  let cells: string[] = [];
  let rowNumber = 0;

  let inQuotes = false;
  /** Set after a quote inside a quoted field, to distinguish "" from a close. */
  let quotePending = false;
  /** Suppresses the LF of a CRLF pair. */
  let skipLineFeed = false;
  let atStart = true;
  let sawAnyContent = false;

  const endField = (): void => {
    if (cells.length >= maxColumns) {
      throw new CsvParseError(`Row has more than ${maxColumns} columns`, rowNumber + 1);
    }
    cells.push(field);
    field = '';
  };

  const endRow = (): ParsedRow => {
    endField();
    rowNumber += 1;
    const row = { rowNumber, cells };
    cells = [];
    return row;
  };

  for await (const chunk of source) {
    // stream: true holds a partial multi-byte sequence until its continuation
    // arrives in the next chunk.
    const text = decoder.decode(chunk, { stream: true });

    for (const character of text) {
      if (atStart) {
        atStart = false;
        // Excel writes a BOM by default; left in place it becomes part of the
        // first header name and every column mapping silently misses.
        if (character === '\uFEFF') continue;
      }

      if (skipLineFeed) {
        skipLineFeed = false;
        if (character === '\n') continue;
      }

      sawAnyContent = true;

      if (quotePending) {
        quotePending = false;
        if (character === '"') {
          // A doubled quote inside a quoted field is one literal quote.
          field += '"';
          continue;
        }
        inQuotes = false;
        // Fall through: this character closes the field or the row.
      }

      if (inQuotes) {
        if (character === '"') {
          quotePending = true;
          continue;
        }
        field += character;
        if (field.length > maxFieldBytes) {
          throw new CsvParseError(
            `A field exceeded ${maxFieldBytes} characters, which usually means an unclosed quote`,
            rowNumber + 1,
          );
        }
        continue;
      }

      if (character === '"' && field === '') {
        inQuotes = true;
        continue;
      }

      if (character === delimiter) {
        endField();
        continue;
      }

      if (character === '\r') {
        skipLineFeed = true;
        yield endRow();
        continue;
      }

      if (character === '\n') {
        yield endRow();
        continue;
      }

      field += character;
      if (field.length > maxFieldBytes) {
        throw new CsvParseError(
          `A field exceeded ${maxFieldBytes} characters`,
          rowNumber + 1,
        );
      }
    }
  }

  // Flush any character held back by the incremental decoder.
  const tail = decoder.decode();
  for (const character of tail) {
    if (character !== '\r' && character !== '\n') field += character;
  }

  if (inQuotes && !quotePending) {
    throw new CsvParseError('File ended inside a quoted field', rowNumber + 1);
  }

  // A final row with no trailing newline is still a row. Only emit it if the
  // file had content, so a trailing newline does not produce a phantom row.
  if (sawAnyContent && (field !== '' || cells.length > 0)) {
    yield endRow();
  }
}

/**
 * Detects the delimiter from a header line.
 *
 * Counts candidates outside quotes, because a comma inside a quoted header
 * ("Last, First") would otherwise win against a real tab delimiter.
 */
export function detectDelimiter(headerLine: string): string {
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestCount = 0;

  for (const candidate of candidates) {
    let count = 0;
    let quoted = false;

    for (const character of headerLine) {
      if (character === '"') quoted = !quoted;
      else if (character === candidate && !quoted) count += 1;
    }

    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }

  return best;
}

/** Normalises a header cell into a stable key for column mapping. */
export function normaliseHeader(header: string): string {
  return header
    .replace(/^\uFEFF/u, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, '_')
    .replace(/[^a-z0-9_]/gu, '');
}
