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
  /**
   * Text encoding. 'auto' reads the byte-order mark and falls back to UTF-8.
   *
   * Excel's "Unicode Text (*.txt)" export is UTF-16LE with a BOM, and it is a
   * common way for a non-technical user to produce a tab-separated file.
   * Decoded as UTF-8 every character arrives with a NUL between its bytes,
   * which does not error — it silently produces unusable contacts.
   */
  encoding?: 'auto' | 'utf-8' | 'utf-16le' | 'utf-16be';
  /**
   * What to do about bytes that are not valid in the chosen encoding.
   *
   * 'throw' by default. A Windows-1252 file decoded as UTF-8 yields U+FFFD
   * wherever an accented letter was, so "José" imports as "Jos<?>" — a
   * corrupted contact with no error attached. Refusing it and saying what is
   * wrong is worth more than importing something nobody asked for.
   */
  onInvalidBytes?: 'throw' | 'replace';
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
 * Byte-order marks, longest first.
 *
 * UTF-32LE begins with the same two bytes as UTF-16LE, so the order matters:
 * tested shortest-first, every UTF-32LE file would be misread as UTF-16LE.
 */
const BYTE_ORDER_MARKS = [
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: 'utf-32be' as const },
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: 'utf-32le' as const },
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' as const },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' as const },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' as const },
];

/** How many leading bytes must be seen before the encoding can be decided. */
const SNIFF_BYTES = 4;

/**
 * Chooses an encoding from the leading bytes.
 *
 * Only a byte-order mark is trusted. Guessing an encoding from content is how
 * a file of English names is read as UTF-8 and a file of Turkish ones is not;
 * without a mark, UTF-8 is assumed and anything invalid in it is reported
 * rather than silently replaced.
 */
export function sniffEncoding(leading: Uint8Array): 'utf-8' | 'utf-16le' | 'utf-16be' | 'utf-32le' | 'utf-32be' {
  for (const mark of BYTE_ORDER_MARKS) {
    if (mark.bytes.every((byte, index) => leading[index] === byte)) return mark.encoding;
  }
  return 'utf-8';
}

/**
 * Decodes a byte stream to text, incrementally.
 *
 * The first chunks are held until there are enough bytes to read a byte-order
 * mark, which is at most four and in practice arrives with the first chunk.
 */
async function* decodeStream(
  source: AsyncIterable<Uint8Array>,
  options: ParseOptions,
): AsyncGenerator<string> {
  const requested = options.encoding ?? 'auto';
  const onInvalid = options.onInvalidBytes ?? 'throw';

  // InstanceType<typeof TextDecoder>, because this package's lib has no DOM
  // and the global is a value here, not a type.
  let decoder: InstanceType<typeof TextDecoder> | null = null;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;

  const start = (leading: Uint8Array): InstanceType<typeof TextDecoder> => {
    const encoding = requested === 'auto' ? sniffEncoding(leading) : requested;

    if (encoding === 'utf-32le' || encoding === 'utf-32be') {
      throw new CsvParseError(
        'This file is UTF-32, which spreadsheets do not produce and this importer does not read. Re-save it as CSV UTF-8.',
        1,
      );
    }

    try {
      // fatal makes an invalid sequence an exception instead of U+FFFD, which
      // is the whole point: a silently corrupted name is worse than a refusal.
      return new TextDecoder(encoding, { fatal: onInvalid === 'throw' });
    } catch {
      throw new CsvParseError(`This file's encoding (${encoding}) is not supported`, 1);
    }
  };

  const decode = (chunk: Uint8Array, stream: boolean): string => {
    try {
      return decoder === null ? '' : decoder.decode(chunk, { stream });
    } catch {
      throw new CsvParseError(
        'This file is not valid UTF-8. Re-save it as CSV UTF-8 — in Excel, "CSV UTF-8 (Comma delimited)".',
        1,
      );
    }
  };

  for await (const chunk of source) {
    if (decoder === null) {
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      if (pendingBytes < SNIFF_BYTES) continue;

      const leading = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const held of pending) {
        leading.set(held, offset);
        offset += held.byteLength;
      }
      pending = [];

      decoder = start(leading);
      const text = decode(leading, true);
      if (text !== '') yield text;
      continue;
    }

    const text = decode(chunk, true);
    if (text !== '') yield text;
  }

  // A file shorter than four bytes never reached the sniff threshold.
  if (decoder === null) {
    const leading = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const held of pending) {
      leading.set(held, offset);
      offset += held.byteLength;
    }
    decoder = start(leading);
    const text = decode(leading, true);
    if (text !== '') yield text;
  }

  const tail = decode(new Uint8Array(0), false);
  if (tail !== '') yield tail;
}

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

  // Decoding is incremental and encoding-aware: a multi-byte character split
  // across two chunks is held until the rest arrives, which a naive per-chunk
  // toString() would corrupt into replacement characters.
  for await (const text of decodeStream(source, options)) {
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

  // The decoder's own tail is flushed inside decodeStream, so anything it
  // held back has already been through the loop above.
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
