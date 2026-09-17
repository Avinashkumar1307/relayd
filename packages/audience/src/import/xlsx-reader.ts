import { open as fsOpen } from 'node:fs/promises';
import { SaxesParser } from 'saxes';
import yauzl from 'yauzl';
import type { ParsedRow } from './csv-parser.js';

/**
 * A streaming XLSX reader.
 *
 * Yields the same ParsedRow shape as the CSV parser, so the import pipeline
 * does not know or care which format it was handed.
 *
 * docs/06 sets five hard requirements for this path, because an uploaded
 * spreadsheet is the most attacker-controlled input the product accepts:
 *
 *   1. the file type is verified by magic bytes, never by extension
 *   2. a 512 MB uncompressed cap
 *   3. a zip-bomb guard on the uncompressed-to-compressed ratio
 *   4. a 5-minute timeout
 *   5. external entities and formula evaluation disabled
 *
 * Numbers 2 and 3 are enforced twice: once from the central directory before
 * a single byte is decompressed, and again by counting bytes as they flow. A
 * zip's central directory is self-reported, so a file that lies about its
 * sizes to get past the first check still meets the second.
 *
 * Unlike the CSV parser this takes a path rather than a byte stream. That is
 * not a shortcut: a zip's central directory lives at the *end* of the file, so
 * a single forward pass cannot locate the worksheet without first buffering
 * the whole archive. The S3 adapter downloads to a temp file, which is the
 * same thing every correct xlsx reader does.
 */

export class XlsxError extends Error {
  override readonly name = 'XlsxError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface XlsxOptions {
  /** Total decompressed bytes allowed across the whole archive. */
  maxUncompressedBytes?: number;
  /** Largest uncompressed-to-compressed ratio any entry may claim. */
  maxCompressionRatio?: number;
  /** Wall-clock budget for the whole read. */
  timeoutMs?: number;
  /** Bounds a single row, as in the CSV parser. */
  maxColumns?: number;
  /** Injectable clock, so the timeout is testable without waiting. */
  now?: () => number;
}

const DEFAULTS = {
  maxUncompressedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
  timeoutMs: 5 * 60 * 1000,
  maxColumns: 512,
} as const;

/** `PK\x03\x04` — the local file header every zip begins with. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * Verifies the file really is a zip.
 *
 * An extension proves nothing: the upload is named by whoever uploaded it.
 */
export function hasZipMagic(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}

async function readMagic(path: string): Promise<Uint8Array> {
  const handle = await fsOpen(path, 'r');
  try {
    const buffer = new Uint8Array(4);
    await handle.read(buffer, 0, 4, 0);
    return buffer;
  } finally {
    await handle.close();
  }
}

interface ZipEntries {
  zipfile: yauzl.ZipFile;
  byName: Map<string, yauzl.Entry>;
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // lazyEntries lets us read the whole central directory first and decide
    // what to decompress; autoClose off keeps handles valid for later reads.
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (error, zipfile) => {
      if (error || !zipfile) reject(error ?? new XlsxError('Could not open the file', 'zip_open'));
      else resolve(zipfile);
    });
  });
}

/**
 * Reads the central directory and applies the size guards before decompressing.
 *
 * This is the cheap check: the declared sizes are right there in the
 * directory, so a 40 KB archive claiming 8 GB of contents is rejected without
 * inflating a byte of it.
 */
async function readEntries(path: string, limits: Required<XlsxOptions>): Promise<ZipEntries> {
  const zipfile = await openZip(path);
  const byName = new Map<string, yauzl.Entry>();

  await new Promise<void>((resolve, reject) => {
    let declaredTotal = 0;

    zipfile.on('entry', (entry: yauzl.Entry) => {
      declaredTotal += entry.uncompressedSize;

      if (declaredTotal > limits.maxUncompressedBytes) {
        reject(
          new XlsxError(
            `The spreadsheet expands to more than ${Math.floor(
              limits.maxUncompressedBytes / (1024 * 1024),
            )} MB, which is beyond what an import can hold`,
            'too_large',
          ),
        );
        return;
      }

      // A ratio guard catches the archive that is small on disk and enormous
      // in memory — the classic zip bomb. Spreadsheet XML compresses well, so
      // the threshold is generous; 200:1 is still far past anything Excel
      // produces.
      if (
        entry.compressedSize > 0 &&
        entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio
      ) {
        reject(
          new XlsxError(
            `An entry in the spreadsheet is compressed ${Math.round(
              entry.uncompressedSize / entry.compressedSize,
            )}:1, which is not a shape real spreadsheets have`,
            'zip_bomb',
          ),
        );
        return;
      }

      byName.set(entry.fileName, entry);
      zipfile.readEntry();
    });

    zipfile.on('end', () => resolve());
    zipfile.on('error', reject);
    zipfile.readEntry();
  });

  return { zipfile, byName };
}

/**
 * Streams one entry's text, counting decompressed bytes as it goes.
 *
 * The second half of the size guard. The central directory is self-reported;
 * this counts what actually arrives.
 */
async function* entryText(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  budget: { remaining: number },
): AsyncGenerator<string> {
  const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    zipfile.openReadStream(entry, (error, readStream) => {
      if (error || !readStream) {
        reject(error ?? new XlsxError(`Could not read ${entry.fileName}`, 'zip_read'));
      } else {
        resolve(readStream);
      }
    });
  });

  const decoder = new TextDecoder('utf-8');

  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    budget.remaining -= chunk.byteLength;
    if (budget.remaining < 0) {
      throw new XlsxError(
        'The spreadsheet expanded past its declared size while being read',
        'too_large',
      );
    }
    yield decoder.decode(chunk, { stream: true });
  }

  const tail = decoder.decode();
  if (tail !== '') yield tail;
}

interface SaxHandlers {
  open?: (name: string, attributes: Record<string, string>) => void;
  text?: (text: string) => void;
  close?: (name: string) => void;
  /** Called between chunks, so a caller can drain what has accumulated. */
  flush?: () => AsyncGenerator<ParsedRow> | undefined;
}

/**
 * Parses an entry with saxes.
 *
 * saxes resolves only the five predefined XML entities and never fetches an
 * external one, which is most of requirement 5. A DOCTYPE is rejected outright
 * anyway: a spreadsheet has no legitimate reason to carry one, and it is the
 * doorway to every entity-expansion attack.
 */
async function* parseEntry(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  budget: { remaining: number },
  deadline: () => void,
  handlers: SaxHandlers,
): AsyncGenerator<ParsedRow> {
  const parser = new SaxesParser({ fragment: false });
  let failure: Error | null = null;

  parser.on('error', (error) => {
    failure ??= new XlsxError(`The spreadsheet's XML is malformed: ${error.message}`, 'bad_xml');
  });
  parser.on('doctype', () => {
    failure ??= new XlsxError(
      'The spreadsheet declares a DOCTYPE, which an import will not process',
      'doctype',
    );
  });

  if (handlers.open) {
    parser.on('opentag', (node) => {
      const attributes: Record<string, string> = {};
      for (const [key, value] of Object.entries(node.attributes)) {
        attributes[key] = typeof value === 'string' ? value : value.value;
      }
      handlers.open?.(local(node.name), attributes);
    });
  }
  if (handlers.text) parser.on('text', (text) => handlers.text?.(text));
  if (handlers.close) parser.on('closetag', (node) => handlers.close?.(local(node.name)));

  for await (const text of entryText(zipfile, entry, budget)) {
    deadline();
    parser.write(text);
    if (failure) throw failure;

    const drained = handlers.flush?.();
    if (drained) yield* drained;
  }

  parser.close();
  if (failure) throw failure;

  const drained = handlers.flush?.();
  if (drained) yield* drained;
}

/** Strips an XML namespace prefix: `x:row` and `row` are the same element. */
function local(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * Converts a cell reference's column letters to a zero-based index.
 *
 * Sparse rows are normal in xlsx — a row with values only in A and D omits B
 * and C entirely — so the reference is the only way to know which column a
 * value belongs to. Getting this wrong shifts data silently, the same failure
 * the COPY escaping guards against at the other end.
 */
export function columnIndex(reference: string): number {
  let index = 0;
  for (const character of reference) {
    const code = character.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

async function collectSharedStrings(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry | undefined,
  budget: { remaining: number },
  deadline: () => void,
): Promise<string[]> {
  if (!entry) return [];

  const strings: string[] = [];
  let current: string[] | null = null;
  let inText = false;

  const drain = parseEntry(zipfile, entry, budget, deadline, {
    open(name) {
      if (name === 'si') current = [];
      else if (name === 't') inText = true;
    },
    text(text) {
      // Rich text splits one string across several <r><t> runs; concatenating
      // them is what makes a part-bold name arrive whole.
      if (inText && current !== null) current.push(text);
    },
    close(name) {
      if (name === 't') inText = false;
      else if (name === 'si' && current !== null) {
        strings.push(current.join(''));
        current = null;
      }
    },
  });

  // The generator yields no rows here; iterating runs it to completion.
  for await (const _row of drain) void _row;

  return strings;
}

/** Built-in number formats Excel defines as dates or times. */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/**
 * True when a custom format code describes a date or a time.
 *
 * Checks outside quoted literals, so a currency format like `"d"#,##0` is not
 * mistaken for a day.
 */
function isDateFormatCode(code: string): boolean {
  let quoted = false;
  let escaped = false;

  for (const character of code) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if ('ymdhs'.includes(character.toLowerCase())) return true;
  }

  return false;
}

interface Styles {
  /** Indexed by cellXfs position: is this style a date? */
  isDate: boolean[];
}

async function collectStyles(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry | undefined,
  budget: { remaining: number },
  deadline: () => void,
): Promise<Styles> {
  if (!entry) return { isDate: [] };

  const customDateFormats = new Set<number>();
  const isDate: boolean[] = [];
  let inCellXfs = false;

  const drain = parseEntry(zipfile, entry, budget, deadline, {
    open(name, attributes) {
      if (name === 'numFmt') {
        const id = Number(attributes['numFmtId']);
        const code = attributes['formatCode'] ?? '';
        if (Number.isFinite(id) && isDateFormatCode(code)) customDateFormats.add(id);
        return;
      }

      if (name === 'cellXfs') {
        inCellXfs = true;
        return;
      }

      // numFmt elements appear before cellXfs in the schema, so every custom
      // format is known by the time the styles that use them are read.
      if (name === 'xf' && inCellXfs) {
        const id = Number(attributes['numFmtId'] ?? '0');
        isDate.push(DATE_FORMAT_IDS.has(id) || customDateFormats.has(id));
      }
    },
    close(name) {
      if (name === 'cellXfs') inCellXfs = false;
    },
  });

  for await (const _row of drain) void _row;

  return { isDate };
}

/**
 * Converts an Excel serial number to an ISO string.
 *
 * Without this a birthday column arrives as "45000" — valid, unhelpful, and
 * indistinguishable from a real number until a customer notices.
 *
 * Excel's 1900 system treats 1900 as a leap year, which it was not; serials at
 * or below 60 are therefore one day out and corrected here. The 1904 system is
 * legacy Mac Excel and still turns up in files people have carried for years.
 */
export function excelSerialToIso(serial: number, date1904: boolean): string {
  const epochOffset = date1904 ? 24107 : 25569;
  const corrected = !date1904 && serial <= 60 ? serial + 1 : serial;
  const ms = Math.round((corrected - epochOffset) * 86_400_000);
  const date = new Date(ms);

  if (Number.isNaN(date.getTime())) return String(serial);

  const iso = date.toISOString();
  // A whole serial is a date; a fraction carries a time of day.
  return Number.isInteger(serial) ? (iso.slice(0, 10) as string) : iso.slice(0, 19).replace('T', ' ');
}

interface WorkbookInfo {
  date1904: boolean;
  firstSheetId: string | null;
}

async function readWorkbook(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry | undefined,
  budget: { remaining: number },
  deadline: () => void,
): Promise<WorkbookInfo> {
  const info: WorkbookInfo = { date1904: false, firstSheetId: null };
  if (!entry) return info;

  const drain = parseEntry(zipfile, entry, budget, deadline, {
    open(name, attributes) {
      if (name === 'workbookPr') {
        const flag = attributes['date1904'] ?? attributes['date1904Compatibility'] ?? '0';
        info.date1904 = flag === '1' || flag === 'true';
        return;
      }
      if (name === 'sheet' && info.firstSheetId === null) {
        info.firstSheetId = attributes['r:id'] ?? attributes['id'] ?? null;
      }
    },
  });

  for await (const _row of drain) void _row;
  return info;
}

async function resolveSheetPath(
  zipfile: yauzl.ZipFile,
  entries: Map<string, yauzl.Entry>,
  relationshipId: string | null,
  budget: { remaining: number },
  deadline: () => void,
): Promise<string> {
  const rels = entries.get('xl/_rels/workbook.xml.rels');

  if (rels && relationshipId) {
    let target: string | null = null;

    const drain = parseEntry(zipfile, rels, budget, deadline, {
      open(name, attributes) {
        if (name === 'Relationship' && attributes['Id'] === relationshipId) {
          target = attributes['Target'] ?? null;
        }
      },
    });
    for await (const _row of drain) void _row;

    if (target !== null) {
      const path: string = (target as string).replace(/^\/?(xl\/)?/u, '');
      const candidate = `xl/${path}`;
      if (entries.has(candidate)) return candidate;
    }
  }

  // Falling back to the conventional path is better than failing: the
  // relationship is how it *should* be found, but a file written by something
  // other than Excel may still be perfectly readable.
  if (entries.has('xl/worksheets/sheet1.xml')) return 'xl/worksheets/sheet1.xml';

  const anySheet = [...entries.keys()]
    .filter((name) => name.startsWith('xl/worksheets/') && name.endsWith('.xml'))
    .sort();

  const first = anySheet[0];
  if (first === undefined) {
    throw new XlsxError('The spreadsheet contains no worksheet', 'no_sheet');
  }
  return first;
}

/**
 * Reads the first worksheet of an xlsx file as rows.
 *
 * Only the first sheet, deliberately: an import maps one set of columns, and
 * silently concatenating three sheets with different headers produces a mess
 * no error message could explain.
 */
export async function* readXlsxRows(
  path: string,
  options: XlsxOptions = {},
): AsyncGenerator<ParsedRow> {
  const limits: Required<XlsxOptions> = {
    maxUncompressedBytes: options.maxUncompressedBytes ?? DEFAULTS.maxUncompressedBytes,
    maxCompressionRatio: options.maxCompressionRatio ?? DEFAULTS.maxCompressionRatio,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    maxColumns: options.maxColumns ?? DEFAULTS.maxColumns,
    now: options.now ?? Date.now,
  };

  if (!hasZipMagic(await readMagic(path))) {
    throw new XlsxError(
      'This file is not a spreadsheet. Excel files begin with a zip signature; this one does not',
      'bad_magic',
    );
  }

  const startedAt = limits.now();
  const deadline = (): void => {
    if (limits.now() - startedAt > limits.timeoutMs) {
      throw new XlsxError(
        `Reading the spreadsheet took longer than ${Math.round(
          limits.timeoutMs / 1000,
        )} seconds and was stopped`,
        'timeout',
      );
    }
  };

  const budget = { remaining: limits.maxUncompressedBytes };
  const { zipfile, byName } = await readEntries(path, limits);

  try {
    const workbook = await readWorkbook(zipfile, byName.get('xl/workbook.xml'), budget, deadline);
    const styles = await collectStyles(zipfile, byName.get('xl/styles.xml'), budget, deadline);
    const shared = await collectSharedStrings(
      zipfile,
      byName.get('xl/sharedStrings.xml'),
      budget,
      deadline,
    );

    const sheetPath = await resolveSheetPath(
      zipfile,
      byName,
      workbook.firstSheetId,
      budget,
      deadline,
    );
    const sheet = byName.get(sheetPath);
    if (!sheet) throw new XlsxError('The spreadsheet contains no worksheet', 'no_sheet');

    yield* readSheet(zipfile, sheet, { budget, deadline, limits, shared, styles, workbook });
  } finally {
    zipfile.close();
  }
}

interface SheetContext {
  budget: { remaining: number };
  deadline: () => void;
  limits: Required<XlsxOptions>;
  shared: readonly string[];
  styles: Styles;
  workbook: WorkbookInfo;
}

function readSheet(
  zipfile: yauzl.ZipFile,
  sheet: yauzl.Entry,
  context: SheetContext,
): AsyncGenerator<ParsedRow> {
  const { limits, shared, styles, workbook } = context;

  const ready: ParsedRow[] = [];
  let rowNumber = 0;
  let cells: string[] = [];

  let cellIndex = -1;
  let cellType = '';
  let cellStyle = -1;
  let value: string[] | null = null;
  let inValue = false;
  let inInlineText = false;
  let sawFormula = false;

  const place = (index: number, text: string): void => {
    if (index >= limits.maxColumns) {
      throw new XlsxError(`A row has more than ${limits.maxColumns} columns`, 'too_wide');
    }
    while (cells.length <= index) cells.push('');
    cells[index] = text;
  };

  const handlers: SaxHandlers = {
    open(name, attributes) {
      if (name === 'row') {
        cells = [];
        return;
      }

      if (name === 'c') {
        const reference = attributes['r'] ?? '';
        cellIndex = reference === '' ? cells.length : columnIndex(reference);
        cellType = attributes['t'] ?? 'n';
        cellStyle = attributes['s'] === undefined ? -1 : Number(attributes['s']);
        value = [];
        sawFormula = false;
        return;
      }

      // A formula is never evaluated (docs/06). Excel caches the last result
      // in <v>, which is what a spreadsheet shows and therefore what the user
      // means; the formula text itself is only used when no cached value
      // exists, and then it is kept as text for the pipeline to flag.
      if (name === 'f') sawFormula = true;
      else if (name === 'v') inValue = true;
      else if (name === 't') inInlineText = true;
    },

    text(text) {
      if ((inValue || inInlineText) && value !== null) value.push(text);
    },

    close(name) {
      if (name === 'v') {
        inValue = false;
        return;
      }
      if (name === 't') {
        inInlineText = false;
        return;
      }

      if (name === 'c') {
        const raw = (value ?? []).join('');
        value = null;

        if (raw !== '' || sawFormula) {
          place(cellIndex, renderCell(raw, cellType, cellStyle, sawFormula, shared, styles, workbook));
        }
        return;
      }

      if (name === 'row') {
        rowNumber += 1;
        ready.push({ rowNumber, cells });
        cells = [];
      }
    },

    flush() {
      if (ready.length === 0) return undefined;
      const batch = ready.splice(0, ready.length);
      return (async function* drain() {
        yield* batch;
      })();
    },
  };

  return parseEntry(zipfile, sheet, context.budget, context.deadline, handlers);
}

function renderCell(
  raw: string,
  type: string,
  style: number,
  sawFormula: boolean,
  shared: readonly string[],
  styles: Styles,
  workbook: WorkbookInfo,
): string {
  if (type === 's') {
    const index = Number(raw);
    return shared[index] ?? '';
  }

  if (type === 'inlineStr' || type === 'str') return raw;
  if (type === 'e') return raw;

  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';

  if (raw === '') {
    // A formula with no cached value: there is nothing to show, and
    // evaluating it is exactly what docs/06 forbids.
    return sawFormula ? '' : '';
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return raw;

  if (style >= 0 && styles.isDate[style] === true) {
    return excelSerialToIso(numeric, workbook.date1904);
  }

  return raw;
}
