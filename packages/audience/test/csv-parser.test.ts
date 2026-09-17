import { describe, expect, it } from 'vitest';
import {
  CsvParseError,
  detectDelimiter,
  normaliseHeader,
  parseDelimited,
} from '../src/import/csv-parser.js';

/** Feeds a string as a byte stream, optionally split into awkward chunks. */
async function* bytes(text: string, chunkSize = 1024): AsyncGenerator<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  for (let i = 0; i < encoded.length; i += chunkSize) {
    yield encoded.subarray(i, i + chunkSize);
  }
}

async function rows(text: string, options = {}, chunkSize = 1024): Promise<string[][]> {
  const out: string[][] = [];
  for await (const row of parseDelimited(bytes(text, chunkSize), options)) {
    out.push(row.cells);
  }
  return out;
}

describe('basic parsing', () => {
  it('parses a simple file', async () => {
    expect(await rows('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a final row with no trailing newline', async () => {
    expect(await rows('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('does not invent a phantom row from a trailing newline', async () => {
    expect(await rows('a,b\n')).toEqual([['a', 'b']]);
  });

  it('preserves empty fields', async () => {
    expect(await rows('a,,c\n')).toEqual([['a', '', 'c']]);
  });

  it('handles an entirely empty file', async () => {
    expect(await rows('')).toEqual([]);
  });

  it('numbers rows from 1, counting the header', async () => {
    const seen: number[] = [];
    for await (const row of parseDelimited(bytes('h\na\nb\n'))) seen.push(row.rowNumber);
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe('line endings', () => {
  it('handles CRLF', async () => {
    expect(await rows('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles bare CR, which old Mac exports still produce', async () => {
    expect(await rows('a,b\r1,2\r')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles mixed endings in one file', async () => {
    expect(await rows('a,b\r\n1,2\n3,4\r')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });
});

describe('BOM', () => {
  it('strips a UTF-8 BOM rather than gluing it to the first header', async () => {
    // Left in place, every column mapping silently misses on the first column.
    const parsed = await rows('﻿email,name\na@example.com,Aisha\n');
    expect(parsed[0]).toEqual(['email', 'name']);
  });

  it('only strips it at the very start', async () => {
    const parsed = await rows('a,b\n﻿c,d\n');
    expect(parsed[1]?.[0]).toBe('﻿c');
  });
});

describe('quoting', () => {
  it('handles a quoted field containing the delimiter', async () => {
    expect(await rows('"Smith, John",x\n')).toEqual([['Smith, John', 'x']]);
  });

  it('handles doubled quotes as one literal quote', async () => {
    expect(await rows('"He said ""hi""",x\n')).toEqual([['He said "hi"', 'x']]);
  });

  it('handles a newline inside a quoted field', async () => {
    expect(await rows('"line1\nline2",x\n')).toEqual([['line1\nline2', 'x']]);
  });

  it('handles a CRLF inside a quoted field', async () => {
    expect(await rows('"line1\r\nline2",x\n')).toEqual([['line1\r\nline2', 'x']]);
  });

  it('handles an empty quoted field', async () => {
    expect(await rows('"",x\n')).toEqual([['', 'x']]);
  });

  it('handles a field that is only quotes', async () => {
    expect(await rows('"""",x\n')).toEqual([['"', 'x']]);
  });

  it('rejects a file that ends inside a quoted field', async () => {
    // Silently returning a truncated field would import half a name.
    await expect(rows('"unterminated\n')).rejects.toBeInstanceOf(CsvParseError);
  });

  it('refuses an unbounded field rather than buffering the rest of the file', async () => {
    const huge = `"${'x'.repeat(200)}`;
    await expect(rows(huge, { maxFieldBytes: 50 })).rejects.toThrow(/unclosed quote/u);
  });
});

describe('chunk boundaries', () => {
  const file = '"Smith, John",Aisha\r\n"multi\nline",Ünïcode\r\n';

  for (const chunkSize of [1, 2, 3, 5, 7, 13]) {
    it(`parses identically when split every ${chunkSize} bytes`, async () => {
      expect(await rows(file, {}, chunkSize)).toEqual([
        ['Smith, John', 'Aisha'],
        ['multi\nline', 'Ünïcode'],
      ]);
    });
  }

  it('does not corrupt a multi-byte character split across chunks', async () => {
    // A naive per-chunk toString() turns this into replacement characters,
    // which shows up as mangled names in exactly the files customers notice.
    const parsed = await rows('name\n日本語のテキスト\n', {}, 1);
    expect(parsed[1]).toEqual(['日本語のテキスト']);
  });

  it('handles an emoji split across a chunk boundary', async () => {
    const parsed = await rows('a\n🔐🔑\n', {}, 1);
    expect(parsed[1]).toEqual(['🔐🔑']);
  });
});

describe('delimiters', () => {
  it('parses tab-separated files', async () => {
    expect(await rows('a\tb\n1\t2\n', { delimiter: '\t' })).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('detects a tab delimiter from the header', () => {
    expect(detectDelimiter('email\tname\tcountry')).toBe('\t');
  });

  it('detects a comma delimiter', () => {
    expect(detectDelimiter('email,name,country')).toBe(',');
  });

  it('ignores delimiters inside quoted headers', () => {
    // "Last, First" must not make a comma beat a real tab delimiter.
    expect(detectDelimiter('"Last, First"\temail\tcountry')).toBe('\t');
  });

  it('defaults to comma when there is nothing to go on', () => {
    expect(detectDelimiter('email')).toBe(',');
  });
});

describe('limits', () => {
  it('refuses a row with absurdly many columns', async () => {
    const wide = Array.from({ length: 20 }, (_, i) => `c${i}`).join(',');
    await expect(rows(`${wide}\n`, { maxColumns: 10 })).rejects.toThrow(/more than 10 columns/u);
  });

  it('reports the row number on failure, so the user can find it', async () => {
    const error = await rows('a\nb\n"unterminated', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CsvParseError);
    expect((error as CsvParseError).rowNumber).toBeGreaterThan(1);
  });
});

describe('memory', () => {
  it('holds one row at a time, not the file', async () => {
    // 200,000 rows through the parser with a bounded working set. If the
    // parser buffered, this would grow linearly and eventually fail.
    const rowCount = 200_000;

    async function* generate(): AsyncGenerator<Uint8Array> {
      const encoder = new TextEncoder();
      yield encoder.encode('email,name\n');
      for (let i = 0; i < rowCount; i += 1) {
        yield encoder.encode(`user${i}@example.com,Name ${i}\n`);
      }
    }

    let seen = 0;
    let widest = 0;
    for await (const row of parseDelimited(generate())) {
      seen += 1;
      widest = Math.max(widest, row.cells.length);
    }

    expect(seen).toBe(rowCount + 1);
    expect(widest).toBe(2);
  }, 60_000);
});

describe('header normalisation', () => {
  it('produces stable keys for messy headers', () => {
    expect(normaliseHeader('  Email Address ')).toBe('email_address');
    expect(normaliseHeader('First-Name')).toBe('firstname');
    expect(normaliseHeader('﻿email')).toBe('email');
  });

  it('maps differently-cased headers to the same key', () => {
    expect(normaliseHeader('EMAIL')).toBe(normaliseHeader('email'));
  });
});
