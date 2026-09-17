import { describe, expect, it, vi } from 'vitest';
import {
  CredentialCache,
  MAX_CACHE_MS,
  credentialPath,
  parseCredentials,
  workspacePrefix,
  type CredentialAudit,
  type SecretReader,
} from '../src/secrets.js';

/**
 * Credential storage (INVARIANTS R21, review finding F21).
 */

const SES_SECRET = JSON.stringify({
  type: 'ses',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'SECRET-CANARY-9f3a',
  region: 'eu-west-1',
});

function harness(options: { raw?: string | null; ttlMs?: number } = {}) {
  let clock = 1_000_000;
  const reads: string[] = [];
  const audited: { workspaceId: string; connectionId: string; credentialVersion: number }[] = [];

  const reader: SecretReader = {
    async read(path) {
      reads.push(path);
      return options.raw === undefined ? SES_SECRET : options.raw;
    },
  };

  const audit: CredentialAudit = {
    async recordFetch(input) {
      audited.push({
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        credentialVersion: input.credentialVersion,
      });
    },
  };

  const cache = new CredentialCache({
    env: 'production',
    reader,
    audit,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    now: () => clock,
  });

  return {
    cache,
    reads,
    audited,
    advance(ms: number) {
      clock += ms;
    },
  };
}

const REQUEST = { workspaceId: 'ws-1', connectionId: 'conn-1', credentialVersion: 1 };

describe('the path scheme', () => {
  it('is the one INVARIANTS R21 specifies', () => {
    expect(credentialPath({ env: 'production', workspaceId: 'ws-1', connectionId: 'conn-1' })).toBe(
      'relayd/production/ws/ws-1/conn/conn-1',
    );
  });

  it('produces a prefix an IAM policy can scope to one workspace', () => {
    // F21: one task role with a wildcard means any RCE in any worker yields
    // every customer's credentials.
    expect(workspacePrefix({ env: 'staging', workspaceId: 'ws-1' })).toBe(
      'relayd/staging/ws/ws-1/conn/*',
    );
  });

  it('refuses a segment that would break out of the prefix', () => {
    // A prefix-scoped policy stops scoping anything the moment a segment can
    // contain a slash or a wildcard.
    for (const bad of ['../other', 'ws-1/conn', '*', 'ws 1', '', 'a'.repeat(100), '/leading']) {
      expect(() =>
        credentialPath({ env: 'production', workspaceId: bad, connectionId: 'c' }),
      ).toThrow(/Invalid workspaceId/u);
    }
  });

  it('does not echo the offending value into the error', () => {
    // An invalid segment is exactly the kind of thing that turns out to be
    // attacker-influenced.
    try {
      credentialPath({ env: 'production', workspaceId: '../SECRET-CANARY-9f3a', connectionId: 'c' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('SECRET-CANARY-9f3a');
    }
  });
});

describe('the cache', () => {
  it('reads once and serves the rest from memory', async () => {
    const { cache, reads } = harness();

    await cache.get(REQUEST);
    await cache.get(REQUEST);
    await cache.get(REQUEST);

    expect(reads).toEqual(['relayd/production/ws/ws-1/conn/conn-1']);
  });

  it('expires after five minutes', async () => {
    const { cache, reads, advance } = harness();

    await cache.get(REQUEST);
    advance(MAX_CACHE_MS - 1);
    await cache.get(REQUEST);
    expect(reads).toHaveLength(1);

    advance(2);
    await cache.get(REQUEST);
    expect(reads).toHaveLength(2);
  });

  it('clamps a longer requested TTL rather than honouring it', async () => {
    // R21 is a maximum, not a default.
    const { cache, reads, advance } = harness({ ttlMs: 60 * 60 * 1000 });

    await cache.get(REQUEST);
    advance(MAX_CACHE_MS + 1);
    await cache.get(REQUEST);

    expect(reads).toHaveLength(2);
  });

  it('honours a shorter requested TTL', async () => {
    const { cache, reads, advance } = harness({ ttlMs: 1000 });

    await cache.get(REQUEST);
    advance(1001);
    await cache.get(REQUEST);

    expect(reads).toHaveLength(2);
  });

  it('treats a bumped credential version as a different secret', async () => {
    // Rotation bumps the version, which makes the old entry unreachable
    // rather than merely stale — so a rotated credential takes effect on the
    // next send, not five minutes later.
    const { cache, reads } = harness();

    await cache.get(REQUEST);
    await cache.get({ ...REQUEST, credentialVersion: 2 });

    expect(reads).toHaveLength(2);
  });

  it('evicts one connection without disturbing the others', async () => {
    const { cache, reads } = harness();

    await cache.get(REQUEST);
    await cache.get({ ...REQUEST, connectionId: 'conn-2' });
    expect(cache.size()).toBe(2);

    cache.evict({ workspaceId: 'ws-1', connectionId: 'conn-1' });
    expect(cache.size()).toBe(1);

    await cache.get(REQUEST);
    expect(reads).toHaveLength(3);
  });

  it('clears everything on demand', async () => {
    const { cache } = harness();

    await cache.get(REQUEST);
    await cache.get({ ...REQUEST, connectionId: 'conn-2' });
    cache.clear();

    expect(cache.size()).toBe(0);
  });

  it('caches nothing when the secret is missing', async () => {
    const { cache, reads } = harness({ raw: null });

    expect(await cache.get(REQUEST)).toBeNull();
    await cache.get(REQUEST);

    // No negative caching: a secret that has just been written must be
    // readable immediately, not after the TTL.
    expect(reads).toHaveLength(2);
  });

  it('caches nothing when the secret will not parse', async () => {
    const { cache, reads } = harness({ raw: '{ not json' });

    expect(await cache.get(REQUEST)).toBeNull();
    await cache.get(REQUEST);
    expect(reads).toHaveLength(2);
  });

  it('does not leave stale material reachable when a fetch fails', async () => {
    let fail = false;
    const reader: SecretReader = {
      async read() {
        if (fail) throw new Error('Secrets Manager is unavailable');
        return SES_SECRET;
      },
    };

    let clock = 0;
    const cache = new CredentialCache({
      env: 'production',
      reader,
      audit: { async recordFetch() {} },
      now: () => clock,
    });

    await cache.get(REQUEST);
    clock += MAX_CACHE_MS + 1;
    fail = true;

    await expect(cache.get(REQUEST)).rejects.toThrow(/unavailable/u);
    // The expired entry was dropped before the fetch was attempted, so a
    // failing fetch cannot resurrect it.
    expect(cache.size()).toBe(0);
  });
});

describe('the audit trail', () => {
  it('records every fetch that reaches the store', async () => {
    const { cache, audited } = harness();

    await cache.get(REQUEST);
    await cache.get({ ...REQUEST, credentialVersion: 2 });

    expect(audited).toEqual([
      { workspaceId: 'ws-1', connectionId: 'conn-1', credentialVersion: 1 },
      { workspaceId: 'ws-1', connectionId: 'conn-1', credentialVersion: 2 },
    ]);
  });

  it('records nothing for a cache hit', async () => {
    // A row per send would make the audit log useless at campaign volume.
    const { cache, audited } = harness();

    await cache.get(REQUEST);
    await cache.get(REQUEST);
    await cache.get(REQUEST);

    expect(audited).toHaveLength(1);
  });

  it('records a fetch that found nothing', async () => {
    // An attempt to read a secret is the interesting event, not whether it
    // succeeded.
    const { cache, audited } = harness({ raw: null });

    await cache.get(REQUEST);
    expect(audited).toHaveLength(1);
  });

  it('records before the credential is returned, not after', async () => {
    // If the audit write fails, nothing gets the credential.
    const order: string[] = [];
    const cache = new CredentialCache({
      env: 'production',
      reader: {
        async read() {
          order.push('read');
          return SES_SECRET;
        },
      },
      audit: {
        async recordFetch() {
          order.push('audit');
          throw new Error('audit store down');
        },
      },
    });

    await expect(cache.get(REQUEST)).rejects.toThrow(/audit store down/u);
    expect(order).toEqual(['read', 'audit']);
  });
});

describe('parsing stored credentials', () => {
  it('reads each provider shape', () => {
    expect(parseCredentials(SES_SECRET)).toEqual({
      type: 'ses',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'SECRET-CANARY-9f3a',
      region: 'eu-west-1',
    });

    expect(parseCredentials(JSON.stringify({ type: 'sendgrid', apiKey: 'k' }))).toEqual({
      type: 'sendgrid',
      apiKey: 'k',
    });

    expect(
      parseCredentials(
        JSON.stringify({ type: 'smtp', host: 'h', port: 587, secure: true, user: 'u', pass: 'p' }),
      ),
    ).toEqual({ type: 'smtp', host: 'h', port: 587, secure: true, user: 'u', pass: 'p' });
  });

  it('refuses a shape with a field missing rather than half-building one', () => {
    // A half-built credential fails at the provider with an error nobody can
    // trace back to a malformed secret.
    expect(parseCredentials(JSON.stringify({ type: 'ses', accessKeyId: 'a' }))).toBeNull();
    expect(parseCredentials(JSON.stringify({ type: 'sendgrid', apiKey: '' }))).toBeNull();
    expect(
      parseCredentials(JSON.stringify({ type: 'smtp', host: 'h', port: 'not a number' })),
    ).toBeNull();
    expect(parseCredentials(JSON.stringify({ type: 'mailgun', apiKey: 'k', domain: 'd', region: 'uk' }))).toBeNull();
  });

  it('refuses an unknown provider type', () => {
    expect(parseCredentials(JSON.stringify({ type: 'carrier-pigeon', apiKey: 'k' }))).toBeNull();
  });

  it('returns null rather than throwing on rubbish', () => {
    expect(parseCredentials('not json')).toBeNull();
    expect(parseCredentials('null')).toBeNull();
    expect(parseCredentials('[]')).toBeNull();
  });

  it('never echoes the material when it refuses', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseCredentials(JSON.stringify({ type: 'nope', secret: 'SECRET-CANARY-9f3a' }))).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
