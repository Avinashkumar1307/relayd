import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { UserId, WorkspaceId } from '@relayd/types';
import { TokenService } from '../src/services/tokens.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const service = (ttl = 900) =>
  new TokenService({
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
    keyId: 'k1',
    accessTokenTtlSeconds: ttl,
  });

const claims = {
  sub: 'user-1' as UserId,
  sid: 'session-1',
  wsIds: ['ws-a' as WorkspaceId, 'ws-b' as WorkspaceId],
  ver: 3,
};

describe('access tokens', () => {
  it('round-trips every claim', async () => {
    const svc = service();
    const verified = await svc.verifyAccessToken(await svc.issueAccessToken(claims));
    expect(verified).toEqual(claims);
  });

  it('carries the key id so keys can be rotated', async () => {
    const token = await service().issueAccessToken(claims);
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString());
    expect(header).toMatchObject({ alg: 'RS256', kid: 'k1' });
  });

  it('rejects a token signed by a different key', async () => {
    const attacker = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const forged = await new TokenService({
      privateKeyPem: attacker.privateKey,
      publicKeyPem: attacker.publicKey,
      keyId: 'k1',
      accessTokenTtlSeconds: 900,
    }).issueAccessToken(claims);

    await expect(service().verifyAccessToken(forged)).rejects.toThrow();
  });

  it('rejects a tampered payload', async () => {
    const token = await service().issueAccessToken(claims);
    const [h, , s] = token.split('.');
    const tampered = Buffer.from(
      JSON.stringify({ ...claims, ver: 999 }),
      'utf8',
    ).toString('base64url');
    await expect(service().verifyAccessToken(`${h}.${tampered}.${s}`)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const svc = service(-1); // already expired at issue
    await expect(svc.verifyAccessToken(await svc.issueAccessToken(claims))).rejects.toThrow();
  });

  it('rejects garbage without leaking which part failed', async () => {
    const svc = service();
    for (const bad of ['', 'not.a.token', 'a.b.c']) {
      await expect(svc.verifyAccessToken(bad)).rejects.toMatchObject({ status: 401 });
    }
  });

  it('uses an asymmetric algorithm, so a verifier cannot mint', async () => {
    const token = await service().issueAccessToken(claims);
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString());
    expect(header.alg).toBe('RS256');
    expect(header.alg).not.toBe('none');
    expect(String(header.alg).startsWith('HS')).toBe(false);
  });
});
