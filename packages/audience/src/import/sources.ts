import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { ImportFileSource } from './consumer.js';

/**
 * Import sources.
 *
 * The S3 implementation lives with the rest of the AWS wiring and arrives with
 * the bucket, in the same way `FileStorage` in the API is an injected port
 * with no implementation yet. What matters here is that the consumer is
 * written against the port, so the S3 adapter is a swap rather than a rewrite.
 */

/**
 * Reads imports from a directory.
 *
 * Used in development and in tests. The key is resolved inside `root` and
 * checked afterwards: an object key arrives from the database, but it was
 * originally derived from a filename a customer chose, and `../../etc/passwd`
 * is a filename.
 */
export function localFileSource(root: string): ImportFileSource {
  const base = resolve(root);

  const resolveKey = (key: string): string => {
    if (isAbsolute(key)) {
      throw new Error('An import key must be relative');
    }

    const target = resolve(base, normalize(key));
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error('An import key must stay inside the import directory');
    }

    return target;
  };

  return {
    async openStream(key) {
      return createReadStream(resolveKey(key)) as AsyncIterable<Uint8Array>;
    },

    async downloadToFile(key) {
      // Already local: hand back the path and clean up nothing. Deleting the
      // caller's own file would be a surprising thing for a read to do.
      return { path: resolveKey(key), cleanup: async (): Promise<void> => undefined };
    },
  };
}

/**
 * Wraps a source that can only stream, giving it `downloadToFile` by spooling
 * to a temp file.
 *
 * This is how the S3 adapter will satisfy the xlsx half of the port: object
 * stores stream, and a zip has to be seekable, so somebody has to spool. Doing
 * it here means each adapter implements one method.
 */
export function spoolingSource(
  streamer: Pick<ImportFileSource, 'openStream'>,
  options: { prefix?: string } = {},
): ImportFileSource {
  return {
    openStream: (key) => streamer.openStream(key),

    async downloadToFile(key) {
      const directory = await mkdtemp(join(tmpdir(), options.prefix ?? 'relayd-import-'));
      const path = join(directory, 'upload.bin');

      // Streamed to disk, not buffered: the whole point of spooling is that
      // the file is too big to hold, and a 512 MB upload collected into an
      // array of chunks is the same memory the cap exists to prevent.
      const source = await streamer.openStream(key);
      await streamPipeline(Readable.from(source), createWriteStream(path));

      return {
        path,
        cleanup: async (): Promise<void> => {
          await rm(directory, { recursive: true, force: true });
        },
      };
    },
  };
}
