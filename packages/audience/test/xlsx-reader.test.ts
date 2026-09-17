import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  XlsxError,
  columnIndex,
  excelSerialToIso,
  hasZipMagic,
  readXlsxRows,
} from '../src/import/xlsx-reader.js';
import { importRows, type ImportSink, type NormalisedContact } from '../src/import/pipeline.js';
import { writeXlsx, type XlsxSpec } from './helpers/xlsx-fixture.js';
import { buildZip } from './helpers/zip.js';

const dir = mkdtempSync(join(tmpdir(), 'relayd-xlsx-'));
let counter = 0;

function fixture(spec: XlsxSpec): string {
  counter += 1;
  return writeXlsx(join(dir, `book-${counter}.xlsx`), spec);
}

async function readAll(path: string, options = {}): Promise<string[][]> {
  const rows: string[][] = [];
  for await (const row of readXlsxRows(path, options)) rows.push(row.cells);
  return rows;
}

describe('file type', () => {
  it('recognises the zip signature', () => {
    expect(hasZipMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(true);
    expect(hasZipMagic(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe(false);
  });

  it('refuses a CSV that has been renamed .xlsx', async () => {
    // docs/06: the type is verified by magic bytes, never by extension. An
    // extension is chosen by whoever uploaded the file.
    counter += 1;
    const path = join(dir, `fake-${counter}.xlsx`);
    writeFileSync(path, 'email,name\na@example.com,Aisha\n');

    await expect(readAll(path)).rejects.toMatchObject({ code: 'bad_magic' });
  });
});

describe('reading a worksheet', () => {
  it('reads shared strings into cells', async () => {
    const path = fixture({
      sharedStrings: ['email', 'first_name', 'a@example.com', 'Aisha'],
      sheet: {
        rows: [
          [
            { type: 's', value: '0' },
            { type: 's', value: '1' },
          ],
          [
            { type: 's', value: '2' },
            { type: 's', value: '3' },
          ],
        ],
      },
    });

    expect(await readAll(path)).toEqual([
      ['email', 'first_name'],
      ['a@example.com', 'Aisha'],
    ]);
  });

  it('places sparse cells in the right columns', async () => {
    // A row with values only in A and D omits B and C entirely. Appending in
    // document order would move the fourth value into the second column and
    // every mapped field after it would be wrong.
    const path = fixture({
      sheet: {
        rows: [
          [
            { ref: 'A1', type: 'inlineStr', value: 'email' },
            { ref: 'D1', type: 'inlineStr', value: 'country' },
          ],
          [
            { ref: 'A2', type: 'inlineStr', value: 'a@example.com' },
            { ref: 'D2', type: 'inlineStr', value: 'AE' },
          ],
        ],
      },
    });

    expect(await readAll(path)).toEqual([
      ['email', '', '', 'country'],
      ['a@example.com', '', '', 'AE'],
    ]);
  });

  it('reads inline strings', async () => {
    const path = fixture({
      sheet: { rows: [[{ type: 'inlineStr', value: 'Smith, John' }]] },
    });
    expect(await readAll(path)).toEqual([['Smith, John']]);
  });

  it('decodes XML entities rather than importing them literally', async () => {
    const path = fixture({
      sheet: { rows: [[{ type: 'inlineStr', value: 'Ben & Jerry <ltd>' }]] },
    });
    expect(await readAll(path)).toEqual([['Ben & Jerry <ltd>']]);
  });

  it('reads booleans as words, not as 1 and 0', async () => {
    const path = fixture({
      sheet: {
        rows: [
          [
            { type: 'b', value: '1' },
            { type: 'b', value: '0' },
          ],
        ],
      },
    });
    expect(await readAll(path)).toEqual([['TRUE', 'FALSE']]);
  });

  it('handles a sheet stored at a non-default path', async () => {
    const path = fixture({
      sheetPath: 'xl/worksheets/data.xml',
      sheet: { rows: [[{ type: 'inlineStr', value: 'ok' }]] },
    });
    expect(await readAll(path)).toEqual([['ok']]);
  });

  it('numbers rows from 1', async () => {
    const path = fixture({
      sheet: {
        rows: [
          [{ type: 'inlineStr', value: 'h' }],
          [{ type: 'inlineStr', value: 'a' }],
        ],
      },
    });

    const numbers: number[] = [];
    for await (const row of readXlsxRows(path)) numbers.push(row.rowNumber);
    expect(numbers).toEqual([1, 2]);
  });
});

describe('formulas', () => {
  it('uses the cached result and never evaluates the formula', async () => {
    // docs/06 requires formula evaluation disabled. Excel caches what it last
    // displayed in <v>, which is what the user means by the cell's value.
    const path = fixture({
      sheet: {
        rows: [[{ type: 'str', formula: 'CONCATENATE(A1,"@example.com")', value: 'a@example.com' }]],
      },
    });

    expect(await readAll(path)).toEqual([['a@example.com']]);
  });

  it('yields nothing rather than computing a formula with no cached value', async () => {
    const path = fixture({
      sheet: {
        rows: [
          [
            { ref: 'A1', formula: '1+1' },
            { ref: 'B1', type: 'inlineStr', value: 'after' },
          ],
        ],
      },
    });

    // The empty cell still holds its column, so "after" stays in B.
    expect(await readAll(path)).toEqual([['', 'after']]);
  });

  it('keeps a formula-shaped text value as text for the pipeline to flag', async () => {
    // A cell whose *value* is the string "=cmd|calc" is an injection attempt,
    // not a formula. It imports, flagged, and the export path neutralises it.
    const path = fixture({
      sheet: { rows: [[{ type: 'inlineStr', value: '=cmd|"/c calc"!A1' }]] },
    });
    expect(await readAll(path)).toEqual([['=cmd|"/c calc"!A1']]);
  });
});

describe('dates', () => {
  it('converts a built-in date format to an ISO date', async () => {
    // Serial 45000 is 2023-03-15. Left as a number it is valid, unhelpful, and
    // indistinguishable from a real number until a customer notices.
    const path = fixture({
      styleFormats: [14],
      sheet: { rows: [[{ style: 0, value: '45000' }]] },
    });
    expect(await readAll(path)).toEqual([['2023-03-15']]);
  });

  it('converts a custom date format', async () => {
    const path = fixture({
      styleFormats: ['yyyy-mm-dd'],
      sheet: { rows: [[{ style: 0, value: '45000' }]] },
    });
    expect(await readAll(path)).toEqual([['2023-03-15']]);
  });

  it('leaves a plain number alone', async () => {
    const path = fixture({
      styleFormats: [0],
      sheet: { rows: [[{ style: 0, value: '45000' }]] },
    });
    expect(await readAll(path)).toEqual([['45000']]);
  });

  it('does not mistake a quoted letter in a currency format for a date', async () => {
    // `"d"#,##0` is dollars, not days.
    const path = fixture({
      styleFormats: ['"d"#,##0'],
      sheet: { rows: [[{ style: 0, value: '45000' }]] },
    });
    expect(await readAll(path)).toEqual([['45000']]);
  });

  it('honours the 1904 date system some Mac files still use', async () => {
    const path = fixture({
      date1904: true,
      styleFormats: [14],
      sheet: { rows: [[{ style: 0, value: '45000' }]] },
    });
    // The two systems are exactly 1462 days apart: four years, one of them a
    // leap year, plus the day Excel's 1900 calendar invents.
    expect(await readAll(path)).toEqual([['2027-03-16']]);
  });

  it('corrects for the 1900 leap-year bug', () => {
    // Excel believes 1900-02-29 existed. Serial 59 is 1900-02-28 in both.
    expect(excelSerialToIso(59, false)).toBe('1900-02-28');
    expect(excelSerialToIso(61, false)).toBe('1900-03-01');
  });

  it('keeps the time when the serial has a fraction', () => {
    expect(excelSerialToIso(45000.5, false)).toBe('2023-03-15 12:00:00');
  });
});

describe('column references', () => {
  it('converts letters to indexes', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('B2')).toBe(1);
    expect(columnIndex('Z9')).toBe(25);
    expect(columnIndex('AA1')).toBe(26);
    expect(columnIndex('AB1')).toBe(27);
    expect(columnIndex('BA1')).toBe(52);
  });
});

describe('the guards docs/06 requires', () => {
  it('refuses an archive whose entries expand suspiciously well', async () => {
    // 200 KB of one repeated byte compresses to a few hundred, which no real
    // spreadsheet does. This is the zip-bomb shape.
    const path = fixture({
      sheet: { rows: [[{ type: 'inlineStr', value: 'ok' }]] },
      extraEntries: [{ name: 'xl/padding.xml', content: 'a'.repeat(200_000) }],
    });

    await expect(readAll(path)).rejects.toMatchObject({ code: 'zip_bomb' });
  });

  it('refuses an archive larger than the uncompressed cap, from the directory alone', async () => {
    const path = fixture({ sheet: { rows: [[{ type: 'inlineStr', value: 'ok' }]] } });

    // Asserting the message, not just the code: both layers of the size guard
    // report 'too_large', and a test that accepts either cannot tell you the
    // cheap one still works. This wording only comes from the central-directory
    // check, which runs before a byte is decompressed.
    await expect(readAll(path, { maxUncompressedBytes: 64 })).rejects.toThrow(
      /beyond what an import can hold/u,
    );
  });

  it('rejects an archive that merely claims to be enormous', async () => {
    // Five bytes of content declaring three gigabytes. Nothing is inflated to
    // find this out: the central directory is read first precisely so a bomb
    // is refused before it costs anything.
    const path = fixture({
      sheet: { rows: [[{ type: 'inlineStr', value: 'ok' }]] },
      extraEntries: [
        // Capped at what a 32-bit zip field can hold; anything larger needs
        // Zip64, which yauzl reads into the same uncompressedSize.
        { name: 'xl/lie.xml', content: 'small', declaredUncompressedSize: 3_000_000_000 },
      ],
    });

    const error = await readAll(path).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(XlsxError);
    // The total-size check is applied before the ratio check, so this is
    // 'too_large' rather than 'zip_bomb'. Either would be a correct refusal;
    // pinning which one means the ordering cannot drift unnoticed.
    expect((error as XlsxError).code).toBe('too_large');
    expect((error as XlsxError).message).toMatch(/beyond what an import can hold/u);
  });

  it('fails closed when the central directory understates a size', async () => {
    // Either guard may catch this; what matters is that it does not proceed.
    counter += 1;
    const path = join(dir, `liar-${counter}.xlsx`);
    writeFileSync(
      path,
      buildZip([
        { name: 'xl/workbook.xml', content: '<workbook/>' },
        {
          name: 'xl/worksheets/sheet1.xml',
          content: `<worksheet><sheetData>${'<row><c t="inlineStr"><is><t>x</t></is></c></row>'.repeat(
            500,
          )}</sheetData></worksheet>`,
          declaredUncompressedSize: 10,
        },
      ]),
    );

    await expect(readAll(path)).rejects.toThrow();
  });

  it('stops a read that outlasts its budget', async () => {
    const path = fixture({
      sheet: {
        rows: Array.from({ length: 200 }, (_, i) => [
          { type: 'inlineStr' as const, value: `u${i}@example.com` },
        ]),
      },
    });

    // A clock that jumps past the deadline on its second reading.
    let calls = 0;
    const now = (): number => {
      calls += 1;
      return calls > 2 ? 10_000_000 : 0;
    };

    await expect(readAll(path, { timeoutMs: 1000, now })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('refuses a DOCTYPE outright', async () => {
    // A spreadsheet has no reason to carry one, and it is the doorway to
    // every entity-expansion attack.
    const path = fixture({
      sheet: { rows: [] },
      rawSheetXml:
        '<?xml version="1.0"?><!DOCTYPE worksheet [<!ENTITY xxe "boom">]><worksheet><sheetData><row><c t="inlineStr"><is><t>&xxe;</t></is></c></row></sheetData></worksheet>',
    });

    await expect(readAll(path)).rejects.toMatchObject({ code: 'doctype' });
  });

  it('refuses malformed XML rather than importing half a file', async () => {
    const path = fixture({
      sheet: { rows: [] },
      rawSheetXml: '<worksheet><sheetData><row><c><v>1</v></row></sheetData>',
    });

    await expect(readAll(path)).rejects.toMatchObject({ code: 'bad_xml' });
  });

  it('refuses an absurdly wide row', async () => {
    const path = fixture({
      sheet: {
        rows: [Array.from({ length: 30 }, (_, i) => ({ type: 'inlineStr' as const, value: `c${i}` }))],
      },
    });

    await expect(readAll(path, { maxColumns: 10 })).rejects.toMatchObject({ code: 'too_wide' });
  });
});

describe('through the import pipeline', () => {
  it('imports an xlsx exactly as it would the same data as CSV', async () => {
    const path = fixture({
      sharedStrings: ['email', 'first_name', 'a@example.com', 'Aisha', 'b@example.com', 'Bo'],
      sheet: {
        rows: [
          [
            { type: 's', value: '0' },
            { type: 's', value: '1' },
          ],
          [
            { type: 's', value: '2' },
            { type: 's', value: '3' },
          ],
          [
            { type: 's', value: '4' },
            { type: 's', value: '5' },
          ],
        ],
      },
    });

    const written: NormalisedContact[] = [];
    const sink: ImportSink = {
      async writeBatch(batch) {
        written.push(...batch);
        return { created: batch.length, updated: 0, skipped: 0 };
      },
    };

    const summary = await importRows(readXlsxRows(path), sink, {
      mapping: { email: 'email', first_name: 'firstName' },
    });

    expect(summary.totalRows).toBe(2);
    expect(summary.created).toBe(2);
    expect(written.map((c) => c.email)).toEqual(['a@example.com', 'b@example.com']);
    expect(written[0]?.firstName).toBe('Aisha');
  });
});
