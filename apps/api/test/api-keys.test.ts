import { describe, expect, it } from 'vitest';
import { AppError, PERMISSIONS, canApiKeyHold } from '@relayd/types';
import type { UserId, WorkspaceId, WorkspaceRole } from '@relayd/types';
import type { WorkspaceScope } from '@relayd/db';
import { hashToken } from '@relayd/utils';
import {
  ApiKeyService,
  MAX_KEY_LIFETIME_DAYS,
  expiryFor,
  type ApiKeyRepositories,
} from '../src/services/api-keys.js';

/**
 * API keys (CLAUDE.md section 11).
 *
 * Three properties, and two of them are refusals:
 *
 *   `billing:write` is never grantable, to any key, by any role.
 *   A key never exceeds the role that minted it.
 *   The key is returned once and never stored in a recoverable form.
 *
 * The third is the one a test can be smug about and still get wrong, so it is
 * checked by hashing the returned key and comparing — not by trusting that a
 * field called `keyHash` contains a hash.
 */

const WORKSPACE = 'ws-1' as WorkspaceId;
const SCOPE = { workspaceId: WORKSPACE } as unknown as WorkspaceScope;
const USER = 'user-1' as UserId;
const NOW = new Date('2026-09-19T12:00:00.000Z');

function service(
  over: { existing?: number; keys?: Partial<ApiKeyRepositories['apiKeys']> } = {},
) {
  const created: {
    id: string;
    name: string;
    keyPrefix: string;
    keyHash: Buffer;
    scopes: readonly string[];
    expiresAt?: Date;
  }[] = [];
  const audits: { action: string; after?: unknown; before?: unknown }[] = [];
  const revoked: string[] = [];

  let ids = 0;

  // Annotated rather than cast, so the fake's parameters and return shapes
  // are checked against the real repository. A bare object literal behind an
  // `as unknown as` gives every parameter `any`, which is how a fake drifts
  // away from the thing it stands in for without a test noticing.
  const keyRepository: Pick<
    ApiKeyRepositories['apiKeys'],
    'create' | 'list' | 'find' | 'revoke' | 'countActive'
  > = {
    async create(_scope, input) {
      created.push(input);
      return {
        id: input.id,
        workspaceId: WORKSPACE,
        name: input.name,
        keyPrefix: input.keyPrefix,
        scopes: [...input.scopes],
        lastUsedAt: null,
        expiresAt: input.expiresAt ?? null,
        revokedAt: null,
        createdBy: input.createdBy ?? null,
        createdAt: NOW,
      };
    },
    async list() {
      return [];
    },
    async find(_scope, keyId) {
      return {
        id: keyId,
        workspaceId: WORKSPACE,
        name: 'CI',
        keyPrefix: 'rk_live_aaaa',
        scopes: ['contact:read'],
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        createdBy: USER,
        createdAt: NOW,
      };
    },
    async revoke(_scope, input) {
      revoked.push(input.keyId);
      return true;
    },
    async countActive() {
      return over.existing ?? 0;
    },
  };

  const repos: ApiKeyRepositories = {
    // The cast is only for the methods the service never calls; the five it
    // does call are type-checked above.
    apiKeys: { ...keyRepository, ...over.keys } as unknown as ApiKeyRepositories['apiKeys'],

    auditLogs: {
      async append(
        _scope: WorkspaceScope,
        entry: { action: string; after?: unknown; before?: unknown },
      ) {
        audits.push(entry);
      },
    } as unknown as ApiKeyRepositories['auditLogs'],
  };

  return {
    service: new ApiKeyService({
      unitOfWork: async (fn) => fn(repos),
      newId: () => `id-${(ids += 1)}`,
      now: () => NOW,
    }),
    created,
    audits,
    revoked,
  };
}

function owner(over: Record<string, unknown> = {}) {
  return {
    name: 'CI',
    scopes: ['contact:read', 'campaign:write'],
    actor: { userId: USER, role: 'owner' as WorkspaceRole },
    ...over,
  };
}

describe('billing:write is never grantable', () => {
  it('is refused even to an owner', async () => {
    // The owner holds it. A key never does. That is the whole rule: a leaked
    // key must be able to spend the plan and never to change what is paid.
    const { service: s } = service();

    await expect(
      s.issue(SCOPE, owner({ scopes: ['contact:read', 'billing:write'] })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('names the offending scope', async () => {
    const { service: s } = service();

    const error = (await s
      .issue(SCOPE, owner({ scopes: ['billing:write'] }))
      .catch((caught: unknown) => caught)) as AppError;

    expect(error.details?.[0]?.path).toBe('billing:write');
  });

  it('issues nothing at all rather than a weaker key', async () => {
    // Silently dropping the scope means the integrator discovers the
    // difference at runtime, in production, against whichever endpoint they
    // called first.
    const { service: s, created } = service();

    await s.issue(SCOPE, owner({ scopes: ['contact:read', 'billing:write'] })).catch(() => null);

    expect(created).toEqual([]);
  });

  it('agrees with the permission matrix about which scopes those are', () => {
    // Pinned to the matrix rather than restated, so adding a forbidden
    // permission there does not leave this file quietly out of date.
    for (const permission of PERMISSIONS) {
      if (canApiKeyHold(permission)) continue;
      expect(permission).toBe('billing:write');
    }
  });
});

describe('a key never exceeds the role that minted it', () => {
  it('refuses a scope the minting role does not hold', async () => {
    // An editor cannot launch campaigns, so an editor's key cannot either.
    // Otherwise the key is a privilege-escalation primitive.
    const { service: s } = service();

    await expect(
      s.issue(
        SCOPE,
        owner({ scopes: ['campaign:launch'], actor: { userId: USER, role: 'editor' } }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('allows what the role does hold', async () => {
    const { service: s, created } = service();

    await s.issue(
      SCOPE,
      owner({ scopes: ['campaign:write'], actor: { userId: USER, role: 'editor' } }),
    );

    expect(created[0]?.scopes).toEqual(['campaign:write']);
  });

  it('reports what a role may grant', () => {
    const { service: s } = service();

    const editor = s.grantableScopes('editor');

    expect(editor).toContain('campaign:write');
    expect(editor).not.toContain('campaign:launch');
    expect(editor).not.toContain('billing:write');
  });

  it('never offers billing:write to an owner either', () => {
    const { service: s } = service();

    expect(s.grantableScopes('owner')).not.toContain('billing:write');
  });
});

describe('the key itself', () => {
  it('is returned once', async () => {
    const { service: s } = service();

    const issued = await s.issue(SCOPE, owner());

    expect(issued.key.startsWith('rk_live_')).toBe(true);
    expect(issued.key.length).toBeGreaterThan(40);
  });

  it('is stored only as a hash of itself', async () => {
    // Hashed and compared rather than trusted: a field called `keyHash` that
    // happened to hold the key would pass any check that only looked at the
    // name.
    const { service: s, created } = service();

    const issued = await s.issue(SCOPE, owner());

    expect(created[0]?.keyHash.equals(hashToken(issued.key))).toBe(true);
  });

  it('never appears anywhere in the stored row', async () => {
    const { service: s, created } = service();

    const issued = await s.issue(SCOPE, owner());
    const serialised = JSON.stringify(created[0]);

    expect(serialised).not.toContain(issued.key);
    expect(serialised).not.toContain(issued.key.slice('rk_live_'.length));
  });

  it('never appears in the audit trail', async () => {
    // An audit log carrying the credential is a second place it leaks from.
    const { service: s, audits } = service();

    const issued = await s.issue(SCOPE, owner());

    expect(JSON.stringify(audits)).not.toContain(issued.key.slice('rk_live_'.length));
  });

  it('is not returned by the row the API echoes', async () => {
    const { service: s } = service();

    const issued = await s.issue(SCOPE, owner());

    expect(JSON.stringify(issued.row)).not.toContain(issued.key.slice('rk_live_'.length));
  });

  it('stores a prefix short enough to be worth displaying', async () => {
    const { service: s, created } = service();

    const issued = await s.issue(SCOPE, owner());

    expect(created[0]?.keyPrefix.length).toBeLessThan(issued.key.length);
    expect(issued.key.startsWith(created[0]?.keyPrefix ?? '')).toBe(true);
  });
});

describe('expiry', () => {
  it('defaults to the maximum rather than to never', async () => {
    // A key with no expiry is one nobody revokes because nobody remembers it
    // exists.
    expect(expiryFor(NOW, undefined)?.getTime()).toBe(
      NOW.getTime() + MAX_KEY_LIFETIME_DAYS * 86_400_000,
    );
  });

  it('caps a longer request', async () => {
    expect(expiryFor(NOW, 10_000)?.getTime()).toBe(
      NOW.getTime() + MAX_KEY_LIFETIME_DAYS * 86_400_000,
    );
  });

  it('honours a shorter one', async () => {
    expect(expiryFor(NOW, 30)?.getTime()).toBe(NOW.getTime() + 30 * 86_400_000);
  });

  it('is a year', () => {
    expect(MAX_KEY_LIFETIME_DAYS).toBe(365);
  });
});

describe('what issuing refuses', () => {
  it('a key with no scopes', async () => {
    // It would authenticate and do nothing, which reads as a broken key
    // rather than a deliberate one.
    const { service: s } = service();

    await expect(s.issue(SCOPE, owner({ scopes: [] }))).rejects.toMatchObject({ status: 400 });
  });

  it('a key whose scopes are all unrecognised', async () => {
    const { service: s } = service();

    await expect(
      s.issue(SCOPE, owner({ scopes: ['contact:teleport'] })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('one more key than the workspace may hold', async () => {
    const { service: s } = service({ existing: 25 });

    await expect(s.issue(SCOPE, owner())).rejects.toMatchObject({ status: 402 });
  });

  it('deduplicates a repeated scope', async () => {
    const { service: s, created } = service();

    await s.issue(SCOPE, owner({ scopes: ['contact:read', 'contact:read'] }));

    expect(created[0]?.scopes).toEqual(['contact:read']);
  });
});

describe('revoking', () => {
  it('records who did it', async () => {
    const { service: s, audits, revoked } = service();

    const result = await s.revoke(SCOPE, { keyId: 'key-1', actor: { userId: USER } });

    expect(result).toEqual({ revoked: true });
    expect(revoked).toEqual(['key-1']);
    expect(audits.some((entry) => entry.action === 'api_key.revoked')).toBe(true);
  });

  it('is not an error the second time', async () => {
    // Somebody revoking twice is somebody unsure the first one worked, and
    // the answer they need is "it is revoked".
    const { service: s, audits } = service({
      keys: {
        async revoke() {
          return false;
        },
      },
    });

    expect(await s.revoke(SCOPE, { keyId: 'key-1', actor: { userId: USER } })).toEqual({
      revoked: false,
    });
    expect(audits.filter((entry) => entry.action === 'api_key.revoked')).toEqual([]);
  });

  it('404s a key from another workspace', async () => {
    const { service: s } = service({
      keys: {
        async find() {
          return null;
        },
      },
    });

    await expect(
      s.revoke(SCOPE, { keyId: 'key-elsewhere', actor: { userId: USER } }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('the audit trail', () => {
  it('records the issue with its scopes', async () => {
    const { service: s, audits } = service();

    await s.issue(SCOPE, owner());

    const entry = audits.find((row) => row.action === 'api_key.issued');
    expect(entry?.after).toMatchObject({ name: 'CI', scopes: ['contact:read', 'campaign:write'] });
  });
});
