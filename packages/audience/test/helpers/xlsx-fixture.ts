import { writeFileSync } from 'node:fs';
import { buildZip, type ZipFileEntry } from './zip.js';

/**
 * Builds a real xlsx file for tests.
 *
 * Every part the reader looks at is written here explicitly rather than
 * produced by a spreadsheet library, so a test can express exactly the shape
 * it wants to prove: a sparse row, an inline string, a cached formula result,
 * a date style, a sheet reached through a non-standard relationship.
 */

export interface CellSpec {
  /** Cell reference such as "B2". Omit to place it after the previous cell. */
  ref?: string;
  /** s = shared string index, inlineStr, str, b, e, n (default). */
  type?: 's' | 'inlineStr' | 'str' | 'b' | 'e' | 'n';
  value?: string;
  /** Style index into the cellXfs list. */
  style?: number;
  /** Formula text; the reader must never evaluate it. */
  formula?: string;
}

export interface SheetSpec {
  rows: CellSpec[][];
}

export interface XlsxSpec {
  sheet: SheetSpec;
  sharedStrings?: string[];
  /** Format codes for cellXfs entries, by index. */
  styleFormats?: (number | string)[];
  date1904?: boolean;
  /** Writes the sheet at a non-default path, reached via the relationship. */
  sheetPath?: string;
  extraEntries?: ZipFileEntry[];
  /** Replaces the whole sheet XML, for malformed-input tests. */
  rawSheetXml?: string;
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function columnLetters(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function sheetXml(sheet: SheetSpec): string {
  const rows = sheet.rows
    .map((cells, rowIndex) => {
      const rendered = cells
        .map((cell, cellIndex) => {
          const ref = cell.ref ?? `${columnLetters(cellIndex)}${rowIndex + 1}`;
          const attributes = [`r="${ref}"`];
          if (cell.type !== undefined && cell.type !== 'n') attributes.push(`t="${cell.type}"`);
          if (cell.style !== undefined) attributes.push(`s="${cell.style}"`);

          const formula =
            cell.formula === undefined ? '' : `<f>${escapeXml(cell.formula)}</f>`;

          if (cell.value === undefined) return `<c ${attributes.join(' ')}>${formula}</c>`;

          const body =
            cell.type === 'inlineStr'
              ? `<is><t>${escapeXml(cell.value)}</t></is>`
              : `<v>${escapeXml(cell.value)}</v>`;

          return `<c ${attributes.join(' ')}>${formula}${body}</c>`;
        })
        .join('');

      return `<row r="${rowIndex + 1}">${rendered}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
}

function sharedStringsXml(strings: readonly string[]): string {
  const items = strings.map((text) => `<si><t>${escapeXml(text)}</t></si>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`;
}

function stylesXml(formats: readonly (number | string)[]): string {
  const custom: string[] = [];
  const xfs: string[] = [];
  let nextCustomId = 164;

  for (const format of formats) {
    if (typeof format === 'number') {
      xfs.push(`<xf numFmtId="${format}" xfId="0"/>`);
      continue;
    }
    const id = nextCustomId;
    nextCustomId += 1;
    custom.push(`<numFmt numFmtId="${id}" formatCode="${escapeXml(format)}"/>`);
    xfs.push(`<xf numFmtId="${id}" xfId="0"/>`);
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="${custom.length}">${custom.join('')}</numFmts><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs></styleSheet>`;
}

export function buildXlsx(spec: XlsxSpec): Buffer {
  const sheetPath = spec.sheetPath ?? 'xl/worksheets/sheet1.xml';
  const relativeSheet = sheetPath.replace(/^xl\//u, '');

  const entries: ZipFileEntry[] = [
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${
        spec.date1904 === true ? '<workbookPr date1904="1"/>' : ''
      }<sheets><sheet name="Contacts" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${relativeSheet}"/></Relationships>`,
    },
    {
      name: sheetPath,
      content: spec.rawSheetXml ?? sheetXml(spec.sheet),
    },
  ];

  if (spec.sharedStrings !== undefined) {
    entries.push({ name: 'xl/sharedStrings.xml', content: sharedStringsXml(spec.sharedStrings) });
  }
  if (spec.styleFormats !== undefined) {
    entries.push({ name: 'xl/styles.xml', content: stylesXml(spec.styleFormats) });
  }
  entries.push(...(spec.extraEntries ?? []));

  return buildZip(entries);
}

export function writeXlsx(path: string, spec: XlsxSpec): string {
  writeFileSync(path, buildXlsx(spec));
  return path;
}
