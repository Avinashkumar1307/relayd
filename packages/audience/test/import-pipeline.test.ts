import { describe, expect, it, vi } from 'vitest';
import {
  isPlausibleEmail,
  runImport,
  type ImportSink,
  type NormalisedContact,
  type RowFailure,
} from '../src/import/pipeline.js';

async function* bytes(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

/** Records everything written, so assertions can look at the whole run. */
function recordingSink() {
  const written: NormalisedContact[] = [];
  const batches: number[] = [];

  const sink: ImportSink = {
    async writeBatch(rows) {
      written.push(...rows);
      batches.push(rows.length);
      return { created: rows.length, updated: 0, skipped: 0 };
    },
  };

  return { sink, written, batches };
}

const MAPPING = { email: 'email', first_name: 'firstName', country: 'country' };

describe('happy path', () => {
  it('imports rows and reports what happened', async () => {
    const { sink, written } = recordingSink();

    const summary = await runImport(
      bytes('email,first_name,country\na@example.com,Aisha,AE\nb@example.com,Bo,GB\n'),
      sink,
      { mapping: MAPPING },
    );

    expect(summary.totalRows).toBe(2);
    expect(summary.created).toBe(2);
    expect(written[0]).toMatchObject({
      email: 'a@example.com',
      firstName: 'Aisha',
      attributes: { country: 'AE' },
    });
  });

  it('lowercases addresses so the unique index sees one contact', async () => {
    const { sink, written } = recordingSink();
    await runImport(bytes('email\nAISHA@Example.COM\n'), sink, { mapping: { email: 'email' } });
    expect(written[0]?.email).toBe('aisha@example.com');
  });

  it('matches headers regardless of case, spacing or BOM', async () => {
    const { sink, written } = recordingSink();
    await runImport(bytes('﻿  Email Address ,First-Name\na@example.com,Aisha\n'), sink, {
      mapping: { 'email address': 'email', firstname: 'firstName' },
    });

    expect(written[0]).toMatchObject({ email: 'a@example.com', firstName: 'Aisha' });
  });

  it('ignores columns that are not mapped', async () => {
    const { sink, written } = recordingSink();
    await runImport(bytes('email,secret\na@example.com,do-not-import\n'), sink, {
      mapping: { email: 'email' },
    });

    expect(written[0]?.attributes).toEqual({});
  });
});

describe('validation', () => {
  it('fails a row with no address without abandoning the file', async () => {
    const { sink, written } = recordingSink();
    const failures: RowFailure[] = [];

    const summary = await runImport(
      bytes('email\na@example.com\n\nb@example.com\n'),
      sink,
      { mapping: { email: 'email' } },
      { onFailures: (f) => void failures.push(...f) },
    );

    expect(summary.failed).toBe(1);
    expect(summary.created).toBe(2);
    expect(written).toHaveLength(2);
    expect(failures[0]?.errorCode).toBe('email_missing');
  });

  it('fails an address that is not plausibly one', async () => {
    const failures: RowFailure[] = [];
    const { sink } = recordingSink();

    await runImport(
      bytes('email\nnot-an-email\n'),
      sink,
      { mapping: { email: 'email' } },
      { onFailures: (f) => void failures.push(...f) },
    );

    expect(failures[0]?.errorCode).toBe('email_invalid');
    // The offending value is kept, so the user can find it in their file.
    expect(failures[0]?.rawValue).toBe('not-an-email');
  });

  it('accepts the addresses real audiences contain', () => {
    for (const email of [
      'a@example.com',
      'first.last@example.co.uk',
      'user+tag@example.com',
      'ünïcode@example.com',
      "o'brien@example.com",
    ]) {
      expect(isPlausibleEmail(email), email).toBe(true);
    }
  });

  it('rejects what is plainly not an address', () => {
    for (const value of ['', 'nope', 'a@b', 'a b@example.com', 'a@@example.com', 'a,b@example.com']) {
      expect(isPlausibleEmail(value), value).toBe(false);
    }
  });

  it('stops only when the file itself is unusable', async () => {
    // No email column means every row would fail identically; reporting
    // 500,000 copies of the same error helps nobody.
    const { sink } = recordingSink();
    await expect(
      runImport(bytes('name,country\nAisha,AE\n'), sink, { mapping: { name: 'firstName' } }),
    ).rejects.toThrow(/nothing to import/u);
  });
});

describe('deduplication within the file', () => {
  it('keeps the first occurrence and skips later ones', async () => {
    // First wins, deliberately: last-wins makes the outcome depend on row
    // order in a file the user never sorted.
    const { sink, written } = recordingSink();
    const failures: RowFailure[] = [];

    const summary = await runImport(
      bytes('email,first_name\na@example.com,First\na@example.com,Second\n'),
      sink,
      { mapping: MAPPING },
      { onFailures: (f) => void failures.push(...f) },
    );

    expect(summary.duplicatesInFile).toBe(1);
    expect(written).toHaveLength(1);
    expect(written[0]?.firstName).toBe('First');
    expect(failures[0]?.errorCode).toBe('duplicate_in_file');
  });

  it('treats differently-cased addresses as the same contact', async () => {
    const { sink, written } = recordingSink();
    const summary = await runImport(
      bytes('email\na@example.com\nA@EXAMPLE.COM\n'),
      sink,
      { mapping: { email: 'email' } },
    );

    expect(summary.duplicatesInFile).toBe(1);
    expect(written).toHaveLength(1);
  });

  it('abandons tracking rather than exhausting the worker, and says so', async () => {
    const { sink } = recordingSink();
    const rowsText = ['email', ...Array.from({ length: 10 }, (_, i) => `u${i}@example.com`)].join(
      '\n',
    );

    const summary = await runImport(bytes(`${rowsText}\n`), sink, {
      mapping: { email: 'email' },
      maxTrackedEmails: 3,
    });

    expect(summary.duplicateTrackingTruncated).toBe(true);
    // Everything still imported; the database unique index remains the
    // backstop, duplicates simply cost more.
    expect(summary.created).toBe(10);
  });
});

describe('formula flagging', () => {
  it('flags a formula-shaped value but still imports the row', async () => {
    // docs/06: stored as-is but flagged, never evaluated. The export path
    // neutralises the same value on the way out.
    const { sink, written } = recordingSink();

    await runImport(bytes('email,first_name\na@example.com,=cmd|calc\n'), sink, {
      mapping: MAPPING,
    });

    expect(written[0]?.flagged).toBe(true);
    expect(written[0]?.firstName).toBe('=cmd|calc');
  });

  it('does not flag an ordinary row', async () => {
    const { sink, written } = recordingSink();
    await runImport(bytes('email,first_name\na@example.com,Aisha\n'), sink, { mapping: MAPPING });
    expect(written[0]?.flagged).toBe(false);
  });
});

describe('batching and memory', () => {
  it('writes in batches of the requested size', async () => {
    const { sink, batches } = recordingSink();
    const rowsText = [
      'email',
      ...Array.from({ length: 250 }, (_, i) => `u${i}@example.com`),
    ].join('\n');

    await runImport(bytes(`${rowsText}\n`), sink, {
      mapping: { email: 'email' },
      batchSize: 100,
    });

    expect(batches).toEqual([100, 100, 50]);
  });

  it('reports progress as batches complete, not only at the end', async () => {
    const { sink } = recordingSink();
    const onProgress = vi.fn();
    const rowsText = ['email', ...Array.from({ length: 30 }, (_, i) => `u${i}@example.com`)].join(
      '\n',
    );

    await runImport(
      bytes(`${rowsText}\n`),
      sink,
      { mapping: { email: 'email' }, batchSize: 10 },
      { onProgress },
    );

    expect(onProgress).toHaveBeenCalledTimes(3);
  });

  it('never holds more than one batch, whatever the file size', async () => {
    // 100,000 rows with a batch of 500: the sink sees 200 batches and the
    // pipeline holds at most 500 contacts at once.
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
      yield encoder.encode('email\n');
      for (let i = 0; i < 100_000; i += 1) {
        yield encoder.encode(`u${i}@example.com\n`);
      }
    }

    const summary = await runImport(generate(), sink, {
      mapping: { email: 'email' },
      batchSize: 500,
    });

    expect(total).toBe(100_000);
    expect(largestBatch).toBe(500);
    expect(summary.created).toBe(100_000);
  }, 120_000);
});

describe('failure reporting', () => {
  it('reports failures in batches rather than one call per bad row', async () => {
    const { sink } = recordingSink();
    const calls: number[] = [];

    await runImport(
      bytes(['email', ...Array.from({ length: 25 }, () => 'bad')].join('\n')),
      sink,
      { mapping: { email: 'email' }, batchSize: 10 },
      { onFailures: (f) => void calls.push(f.length) },
    );

    expect(calls.reduce((a, b) => a + b, 0)).toBe(25);
    expect(calls.length).toBeGreaterThan(1);
  });
});
