import type { ProviderCredentials } from './port.js';

/**
 * Provider credential storage (INVARIANTS R21, review finding F21).
 *
 * Four rules, all of them load-bearing:
 *
 *   The path is `relayd/{env}/ws/{workspaceId}/conn/{connectionId}`. It is a
 *   path rather than an opaque name so the IAM policy can grant
 *   `GetSecretValue` by resource prefix. F21: one task role with a wildcard
 *   means any RCE or SSRF in any worker yields every customer's SES keys.
 *
 *   Decrypted material is cached in memory for at most five minutes and never
 *   written to disk. The cache is keyed by connection *and* credential
 *   version, so bumping the version on rotation makes the old entry
 *   unreachable rather than merely stale.
 *
 *   Every fetch emits an audit row. A credential read that nobody can see
 *   afterwards is a credential read nobody can investigate.
 *
 *   The API task role can write but not read; only the worker role reads. That
 *   is IAM, not code, but `SecretStore` is split into a writer and a reader so
 *   the code cannot quietly assume otherwise.
 */

export const MAX_CACHE_MS = 5 * 60 * 1000;

/**
 * Builds the Secrets Manager path for a connection.
 *
 * Every segment is validated rather than trusted. A workspace id is a uuid
 * from our own database, but this function is the last thing between a value
 * and an IAM path — and a path segment containing `../` or a wildcard is how
 * a prefix-scoped policy stops scoping anything.
 */
export function credentialPath(input: {
  env: string;
  workspaceId: string;
  connectionId: string;
}): string {
  const env = requireSegment(input.env, 'env');
  const workspaceId = requireSegment(input.workspaceId, 'workspaceId');
  const connectionId = requireSegment(input.connectionId, 'connectionId');

  return `relayd/${env}/ws/${workspaceId}/conn/${connectionId}`;
}

/** The prefix an IAM policy grants a worker for one workspace. */
export function workspacePrefix(input: { env: string; workspaceId: string }): string {
  return `relayd/${requireSegment(input.env, 'env')}/ws/${requireSegment(
    input.workspaceId,
    'workspaceId',
  )}/conn/*`;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

function requireSegment(value: string, name: string): string {
  if (!SEGMENT.test(value)) {
    // Deliberately does not echo the value: it is about to be refused, and
    // an invalid segment is exactly the kind of thing that turns out to be
    // attacker-influenced.
    throw new Error(`Invalid ${name} for a secret path`);
  }
  return value;
}

export interface SecretReader {
  /** Returns the raw secret string, or null when there is none. */
  read(path: string): Promise<string | null>;
}

export interface SecretWriter {
  write(path: string, value: string): Promise<void>;
  destroy(path: string): Promise<void>;
}

export interface CredentialAudit {
  /** Called on every fetch that reaches the store, never on a cache hit. */
  recordFetch(input: {
    workspaceId: string;
    connectionId: string;
    credentialVersion: number;
    at: Date;
  }): Promise<void>;
}

export interface CredentialCacheOptions {
  env: string;
  reader: SecretReader;
  audit: CredentialAudit;
  /** Never above MAX_CACHE_MS; a longer request is clamped, not honoured. */
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  credentials: ProviderCredentials;
  expiresAt: number;
}

export interface CredentialRequest {
  workspaceId: string;
  connectionId: string;
  /** Bumped on rotation. Part of the cache key, so a bump evicts by itself. */
  credentialVersion: number;
}

/**
 * Reads provider credentials, with a bounded in-memory cache.
 *
 * Nothing here writes to disk, and the cache holds decrypted material — so it
 * is deliberately small, short-lived, and clearable.
 */
export class CredentialCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: CredentialCacheOptions) {
    // Clamped, not trusted. A caller asking for an hour gets five minutes.
    this.ttlMs = Math.min(Math.max(options.ttlMs ?? MAX_CACHE_MS, 0), MAX_CACHE_MS);
    this.now = options.now ?? Date.now;
  }

  async get(request: CredentialRequest): Promise<ProviderCredentials | null> {
    const key = cacheKey(request);
    const cached = this.entries.get(key);

    if (cached !== undefined && cached.expiresAt > this.now()) {
      return cached.credentials;
    }

    // Expired entries are dropped before the fetch, so a failed fetch cannot
    // leave stale material reachable.
    this.entries.delete(key);

    const path = credentialPath({
      env: this.options.env,
      workspaceId: request.workspaceId,
      connectionId: request.connectionId,
    });

    const raw = await this.options.reader.read(path);

    // Audited on every fetch that reaches the store, including one that found
    // nothing — an attempt to read a secret is the interesting event, not
    // whether it succeeded.
    await this.options.audit.recordFetch({
      workspaceId: request.workspaceId,
      connectionId: request.connectionId,
      credentialVersion: request.credentialVersion,
      at: new Date(this.now()),
    });

    if (raw === null) return null;

    const credentials = parseCredentials(raw);
    if (credentials === null) return null;

    this.entries.set(key, { credentials, expiresAt: this.now() + this.ttlMs });
    return credentials;
  }

  /** Drops one connection's material, whatever its version. */
  evict(input: { workspaceId: string; connectionId: string }): void {
    const prefix = `${input.workspaceId}/${input.connectionId}/`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Drops everything. Called on shutdown and when a workspace is suspended. */
  clear(): void {
    this.entries.clear();
  }

  /** For tests and for a health endpoint that reports cache pressure. */
  size(): number {
    return this.entries.size;
  }
}

function cacheKey(request: CredentialRequest): string {
  return `${request.workspaceId}/${request.connectionId}/${request.credentialVersion}`;
}

/**
 * Parses stored credential JSON into a discriminated union.
 *
 * Returns null rather than throwing on anything unrecognised: a malformed
 * secret is a connection that cannot send, not a worker that crashes. It also
 * never echoes the material into an error, which is the whole point of R22.
 */
export function parseCredentials(raw: string): ProviderCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const type = record['type'];

  const str = (key: string): string | null => {
    const value = record[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };

  switch (type) {
    case 'ses': {
      const accessKeyId = str('accessKeyId');
      const secretAccessKey = str('secretAccessKey');
      const region = str('region');
      return accessKeyId && secretAccessKey && region
        ? { type: 'ses', accessKeyId, secretAccessKey, region }
        : null;
    }
    case 'sendgrid':
    case 'brevo': {
      const apiKey = str('apiKey');
      return apiKey ? { type, apiKey } : null;
    }
    case 'mailgun': {
      const apiKey = str('apiKey');
      const domain = str('domain');
      const region = record['region'];
      return apiKey && domain && (region === 'us' || region === 'eu')
        ? { type: 'mailgun', apiKey, domain, region }
        : null;
    }
    case 'smtp': {
      const host = str('host');
      const user = str('user');
      const pass = str('pass');
      const port = record['port'];
      return host && user && pass && typeof port === 'number' && Number.isInteger(port)
        ? { type: 'smtp', host, port, secure: record['secure'] === true, user, pass }
        : null;
    }
    case 'google': {
      const refreshToken = str('refreshToken');
      const clientId = str('clientId');
      const clientSecret = str('clientSecret');
      return refreshToken && clientId && clientSecret
        ? { type: 'google', refreshToken, clientId, clientSecret }
        : null;
    }
    default:
      return null;
  }
}
