import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { AppError } from '@relayd/types';
import type { SecretWriter } from '@relayd/email-providers';
import type { FileStorage } from './services/audience.js';

/**
 * Stand-ins for the infrastructure a deployment has and a laptop does not.
 *
 * Each one is honest about what it is. Where a local equivalent exists and is
 * safe, it does the real thing against the filesystem; where it does not, it
 * refuses with a typed error naming what is missing, rather than returning
 * something plausible. A stub that succeeds quietly is how a flow gets
 * "tested" locally and fails the first time it meets production.
 */

/**
 * Provider credentials on disk, outside the database.
 *
 * CLAUDE.md is unambiguous that a plaintext provider secret never goes in the
 * database, and that rule does not relax because this is a laptop: the
 * database is the thing that gets dumped, shared and restored into a
 * colleague's environment. Secrets Manager is the real implementation; this
 * writes the same paths under a git-ignored directory so the code above it is
 * identical either way.
 *
 * Nothing here is encrypted. It is for development credentials against a
 * provider sandbox, and the directory is git-ignored precisely because the
 * next question after "where did it go" must not be "is it in the repository".
 */
export class LocalSecretStore implements SecretWriter {
  constructor(private readonly root: string) {}

  /**
   * Secret paths look like `relayd/dev/ws/<id>/conn/<id>`, so they map onto
   * directories — but a path is caller-supplied, and `..` in one would write
   * outside the root. Resolving and then checking containment is the only
   * check that holds; string matching on the input does not.
   */
  #fileFor(path: string): string {
    const target = resolve(join(this.root, `${path}.secret`));
    const root = resolve(this.root);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new AppError('validation_failed', 'secret path escapes the store', 400);
    }
    return target;
  }

  async write(path: string, value: string): Promise<void> {
    const file = this.#fileFor(path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, value, { encoding: 'utf8', mode: 0o600 });
  }

  async destroy(path: string): Promise<void> {
    await rm(this.#fileFor(path), { force: true });
  }
}

/**
 * Object storage that says it is absent instead of pretending.
 *
 * The only thing the audience service asks of storage is a pre-signed URL the
 * browser uploads a CSV to directly. That needs S3, or something speaking its
 * protocol; there is no honest local substitute, because returning a URL that
 * accepts an upload nobody will ever read is worse than refusing.
 *
 * Everything else in the audience domain — contacts, lists, tags, segments,
 * suppressions — touches no storage at all, which is why the domain is
 * mounted with this rather than held back: one flow reports that it is
 * unavailable and the rest work.
 */
export class UnavailableFileStorage implements FileStorage {
  async createUploadUrl(): Promise<never> {
    throw new AppError(
      'service_unavailable',
      'File upload needs object storage, which this deployment has no credentials for. Imports are unavailable here; every other audience operation works.',
      503,
    );
  }
}
