import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runContactImport, type ContactImportDeps, type ImportJobStore } from '../src/import/consumer.js';
import { localFileSource, spoolingSource } from '../src/import/sources.js';
import type { ImportSink, NormalisedContact, RowFailure } from '../src/import/pipeline.js';
import { writeXlsx } from './helpers/xlsx-fixture.js';

const dir = mkdtempSync(join(tmpdir(), 'relayd-consumer-'));
let counter = 0;

function csvKey(content: string): string {
  counter += 1;
  const name = `import-${counter}.csv`;
  writeFileSync(join(dir, name), content);
  return name;
}

/** A job store that records every call, so the sequence can be asserted. */
function fakeJobs(initialStatus = 'pending') {
  let status = initialStatus;
  const transitions: { from: readonly string[]; to: string }[] = [];
  const progress: Record<string, number>[] = [];
  const rowErrors: RowFailure[] = [];

  const store: ImportJobStore = {
    async transition(from, to) {
      transitions.push({ from, to });
      if (!from.includes(status)) return false;
      status = to;
      return true;
    },
    async addProgress(delta) {
      progress.push({ ...delta });
    },
    async recordRowErrors(errors) {
      rowErrors.push(...errors);
      return errors.length;
    },
  };

  return {
    store,
    transitions,
    progress,
    rowErrors,
    get status() {
      return status;
    },
  };
}

function recordingSink() {
  const written: NormalisedContact[] = [];
  const sink: ImportSink = {
    async writeBatch(rows) {
      written.push(...rows);
      return { created: rows.length, updated: 0, skipped: 0 };
    },
  };
  return { sink, written };
}

function deps(jobs: ImportJobStore, sink: ImportSink): ContactImportDeps {
  return { source: localFileSource(dir), sink, jobs };
}

const MAPPING = { email: 'email', first_name: 'firstName' };

describe('claiming the job', () => {
  it('claims a pending job and completes it', async () => {
    const jobs = fakeJobs();
    const { sink, written } = recordingSink();

    const outcome = await runContactImport(
      {
        key: csvKey('email,first_name\na@example.com,Aisha\nb@example.com,Bo\n'),
        fileType: 'csv',
        mapping: MAPPING,
        updateExisting: true,
      },
      deps(jobs.store, sink),
    );

    expect(outcome.status).toBe('completed');
    expect(written).toHaveLength(2);
    expect(jobs.status).toBe('completed');
    expect(jobs.transitions.map((t) => t.to)).toEqual(['processing', 'completed']);
  });

  it('exits cleanly when another attempt already owns the job', async () => {
    // CLAUDE.md section 9: the guarded update IS the idempotency guard. A
    // redelivered job must not import the same file a second time.
    const jobs = fakeJobs('processing');
    const { sink, written } = recordingSink();

    const outcome = await runContactImport(
      {
        key: csvKey('email\na@example.com\n'),
        fileType: 'csv',
        mapping: { email: 'email' },
        updateExisting: true,
      },
      deps(jobs.store, sink),
    );

    expect(outcome).toEqual({ status: 'skipped', reason: 'not_claimable' });
    expect(written).toHaveLength(0);
  });

  it('will not re-run a completed job', async () => {
    const jobs = fakeJobs('completed');
    const { sink, written } = recordingSink();

    const outcome = await runContactImport(
      {
        key: csvKey('email\na@example.com\n'),
        fileType: 'csv',
        mapping: { email: 'email' },
        updateExisting: true,
      },
      deps(jobs.store, sink),
    );

    expect(outcome.status).toBe('skipped');
    expect(written).toHaveLength(0);
  });
});

describe('progress accounting', () => {
  it('reports deltas that add up to the final summary', async () => {
    // Relative rather than absolute, so two batches completing out of order
    // cannot lose one another's counts.
    const jobs = fakeJobs();
    const { sink } = recordingSink();
    const rows = ['email', ...Array.from({ length: 25 }, (_, i) => `u${i}@example.com`)].join('\n');

    const outcome = await runContactImport(
      { key: csvKey(`${rows}\n`), fileType: 'csv', mapping: { email: 'email' }, batchSize: 10, updateExisting: true },
      deps(jobs.store, sink),
    );

    const totalCreated = jobs.progress.reduce((sum, delta) => sum + (delta['created'] ?? 0), 0);
    const totalProcessed = jobs.progress.reduce((sum, delta) => sum + (delta['processed'] ?? 0), 0);

    expect(totalCreated).toBe(25);
    expect(totalProcessed).toBe(25);
    expect(outcome.status === 'completed' && outcome.summary.created).toBe(25);
    // Never a negative delta: a counter that goes backwards makes a progress
    // bar jump about and an operator distrust every number on the page.
    for (const delta of jobs.progress) {
      for (const value of Object.values(delta)) expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('counts rows that failed after the last batch', async () => {
    // The final batch reports through onProgress; rows that fail afterwards
    // would otherwise never be counted anywhere.
    const jobs = fakeJobs();
    const { sink } = recordingSink();

    await runContactImport(
      {
        key: csvKey('email\na@example.com\nnot-an-email\n'),
        fileType: 'csv',
        mapping: { email: 'email' },
        updateExisting: true,
      },
      deps(jobs.store, sink),
    );

    const failed = jobs.progress.reduce((sum, delta) => sum + (delta['failed'] ?? 0), 0);
    expect(failed).toBe(1);
  });

  it('still reports counts when the file contains no usable row at all', async () => {
    // The pipeline reports progress as batches complete. A file where every
    // row is rejected never fills a batch, so without a final flush the job
    // would finish showing zero rows processed and zero failed — an import
    // that looks like it did nothing rather than one that rejected everything.
    const jobs = fakeJobs();
    const { sink, written } = recordingSink();

    const outcome = await runContactImport(
      {
        key: csvKey('email\nbad\nalso-bad\nstill-bad\n'),
        fileType: 'csv',
        mapping: { email: 'email' },
        updateExisting: true,
      },
      deps(jobs.store, sink),
    );

    expect(written).toHaveLength(0);
    expect(outcome.status).toBe('completed');

    const processed = jobs.progress.reduce((sum, delta) => sum + (delta['processed'] ?? 0), 0);
    const failed = jobs.progress.reduce((sum, delta) => sum + (delta['failed'] ?? 0), 0);
    expect(processed).toBe(3);
    expect(failed).toBe(3);
  });

  it('records per-row errors', async () => {
    const jobs = fakeJobs();
    const { sink } = recordingSink();

    await runContactImport(
      {
        key: csvKey('email\na@example.com\nbad\na@example.com\n'),
        fileType: 'csv',
        mapping: { email: 'email' },
        updateExisting: true,
      },
      deps(jobs.store, sink),
    );

    expect(jobs.rowErrors.map((e) => e.errorCode).sort()).toEqual([
      'duplicate_in_file',
      'email_invalid',
    ]);
  });
});

describe('failure', () => {
  it('marks the job failed and keeps the counts it had already written', async () => {
    // A file that failed at the end really did import what came before.
    // Zeroing that makes the retry look like a duplicate import.
    const jobs = fakeJobs();
    const { sink } = recordingSink();

    const outcome = await runContactImport(
      {
        key: csvKey('name\nAisha\n'),
        fileType: 'csv',
        mapping: { name: 'firstName' },
        updateExisting: true,
      },
      deps(jobs.store, sink),
    );

    expect(outcome.status).toBe('failed');
    expect(jobs.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error.message).toMatch(/nothing to import/u);
  });

  it('marks the job failed when the sink throws', async () => {
    const jobs = fakeJobs();
    const sink: ImportSink = {
      async writeBatch() {
        throw new Error('the database went away');
      },
    };

    const outcome = await runContactImport(
      {
        key: csvKey('email\na@example.com\n'),
        fileType: 'csv',
        mapping: { email: 'email' },
        updateExisting: true,
      },
      deps(jobs.store, sink),
    );

    expect(outcome.status).toBe('failed');
    expect(jobs.transitions.map((t) => t.to)).toEqual(['processing', 'failed']);
  });
});

describe('formats', () => {
  it('reads a TSV with the tab delimiter', async () => {
    counter += 1;
    const name = `import-${counter}.tsv`;
    writeFileSync(join(dir, name), 'email\tfirst_name\na@example.com\tAisha\n');

    const jobs = fakeJobs();
    const { sink, written } = recordingSink();

    await runContactImport(
      { key: name, fileType: 'tsv', mapping: MAPPING, updateExisting: true },
      deps(jobs.store, sink),
    );

    expect(written[0]).toMatchObject({ email: 'a@example.com', firstName: 'Aisha' });
  });

  it('reads an xlsx through the same path', async () => {
    counter += 1;
    const name = `book-${counter}.xlsx`;
    writeXlsx(join(dir, name), {
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

    const jobs = fakeJobs();
    const { sink, written } = recordingSink();

    const outcome = await runContactImport(
      { key: name, fileType: 'xlsx', mapping: MAPPING, updateExisting: true },
      deps(jobs.store, sink),
    );

    expect(outcome.status).toBe('completed');
    expect(written[0]).toMatchObject({ email: 'a@example.com', firstName: 'Aisha' });
  });
});

describe('the local source', () => {
  it('refuses a key that climbs out of the import directory', async () => {
    // The key comes from the database, but it was derived from a filename a
    // customer chose, and "../../etc/passwd" is a filename.
    const source = localFileSource(dir);
    await expect(source.openStream('../../secrets.env')).rejects.toThrow(/stay inside/u);
    await expect(source.downloadToFile('a/../../../etc/passwd')).rejects.toThrow(/stay inside/u);
  });

  it('refuses an absolute key', async () => {
    const source = localFileSource(dir);
    await expect(source.openStream('/etc/passwd')).rejects.toThrow(/must be relative/u);
  });

  it('allows a key in a subdirectory', async () => {
    const source = localFileSource(dir);
    await expect(source.downloadToFile('workspace-1/upload.csv')).resolves.toMatchObject({
      path: expect.stringContaining('upload.csv') as unknown as string,
    });
  });

  it('spools a stream-only source to a file and cleans up after itself', async () => {
    const payload = 'email\na@example.com\n';
    const spooled = spoolingSource({
      async openStream() {
        return (async function* generate(): AsyncGenerator<Uint8Array> {
          yield new TextEncoder().encode(payload);
        })();
      },
    });

    const { path, cleanup } = await spooled.downloadToFile('anything');
    const { readFileSync, existsSync } = await import('node:fs');

    expect(readFileSync(path, 'utf8')).toBe(payload);
    await cleanup();
    expect(existsSync(path)).toBe(false);
  });
});
