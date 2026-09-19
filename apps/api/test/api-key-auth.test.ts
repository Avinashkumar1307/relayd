// @vitest-environment node
import express, { type Express, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import { hashToken } from '@relayd/utils';
import type { ApiKeyResolution, GlobalApiKeyRepository } from '@relayd/db';
import {
  authenticateApiKey,
  isApiKeyCredential,
  refuseApiKey,
  usableScopes,
} from '../src/middleware/api-key-auth.js';
import { requestContext, requirePermission } from '../src/middleware/authorize.js';
import { errorEnvelope } from '../src/middleware/error-envelope.js';
import { requestId } from '../src/middleware/request-id.js';
import {
  currentActor,
  requireScope,
  requireWorkspaceContext,
  tryGetApiKeyPrincipal,
} from '../src/context.js';

/**
 * API key authentication (docs/03, docs/06; CLAUDE.md section 11).
 *
 * The properties that matter are mostly about what a key is *not*. It is not
 * a session, so it has no role and no membership lookup. It is bound to one
 * workspace, so the header cannot move it. And revocation is read on the row
 * every request, so there is no window in which a revoked key still works —
 * which is the property a cache would quietly remove.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');
const KEY = `rk_live_${'a'.repeat(43)}`;

function resolution(over: Partial<ApiKeyResolution> = {}): ApiKeyResolution {
  return {
    id: 'key-1',
    workspaceId: 'ws-a' as never,
    name: 'CI',
    scopes: ['contact:read', 'campaign:write'],
    revokedAt: null,
    expiresAt: null,
    createdBy: null,
    lastUsedAt: null,
    ...over,
  };
}

function buildApp(
  over: {
    resolve?: (hash: Buffer) => Promise<ApiKeyResolution | null>;
    touch?: (keyId: string, now: Date) => Promise<void>;
    shouldTouch?: (lastUsedAt: Date | null, now: Date) => boolean;
  } = {},
): { app: Express; resolved: Buffer[] } {
  const resolved: Buffer[] = [];

  const apiKeys = {
    async resolve(hash: Buffer) {
      resolved.push(hash);
      return over.resolve === undefined ? resolution() : over.resolve(hash);
    },
  } as unknown as GlobalApiKeyRepository;

  const app = express();
  app.use(express.json());
  app.use(requestId);
  app.use(requestContext);
  app.use(
    authenticateApiKey({
      apiKeys,
      now: () => NOW,
      ...(over.touch === undefined ? {} : { touch: over.touch }),
      ...(over.shouldTouch === undefined ? {} : { shouldTouch: over.shouldTouch }),
    }),
  );

  app.get('/whoami', (_req: Request, res: Response) => {
    res.json({
      data: {
        workspaceId: requireScope().workspaceId,
        key: tryGetApiKeyPrincipal(),
        actor: currentActor(),
        role: requireWorkspaceContext().role,
        permissions: requireWorkspaceContext().permissions,
      },
    });
  });

  // The real permission middleware, which checks a key against its scopes and
  // a user against the role matrix. One middleware for both, so a route
  // cannot be reachable by a key and not by a person, or the reverse.
  app.get('/needs-launch', requirePermission('campaign:launch'), (_req: Request, res: Response) => {
    res.json({ data: { ok: true } });
  });

  app.get('/needs-read', requirePermission('contact:read'), (_req: Request, res: Response) => {
    res.json({ data: { ok: true } });
  });

  app.get('/no-keys', refuseApiKey(), (_req: Request, res: Response) => {
    res.json({ data: { ok: true } });
  });

  app.use(
    errorEnvelope(
      createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    ),
  );

  return { app, resolved };
}

function withKey(app: Express, path: string, key = KEY) {
  return request(app).get(path).set('Authorization', `Bearer ${key}`);
}

describe('recognising the credential', () => {
  it('tells a key from a session token', () => {
    expect(isApiKeyCredential(`Bearer ${KEY}`)).toBe(true);
    expect(isApiKeyCredential('Bearer eyJhbGciOiJSUzI1NiJ9.x.y')).toBe(false);
    expect(isApiKeyCredential(undefined)).toBe(false);
    expect(isApiKeyCredential('Basic abc')).toBe(false);
  });
});

describe('a valid key', () => {
  it('authenticates and establishes its workspace', async () => {
    const { app } = buildApp();

    const res = await withKey(app, '/whoami');

    expect(res.status).toBe(200);
    expect(res.body.data.workspaceId).toBe('ws-a');
    expect(res.body.data.key.keyId).toBe('key-1');
  });

  it('is looked up by the hash of the key, not the key', async () => {
    // The lookup that the sha256 decision bought: one index probe, and
    // nothing resembling the credential goes into the query.
    const { app, resolved } = buildApp();

    await withKey(app, '/whoami');

    expect(resolved[0]?.equals(hashToken(KEY))).toBe(true);
    expect(resolved[0]?.toString('utf8')).not.toContain('rk_live');
  });

  it('is recorded as an api_key actor, not as a user', async () => {
    // The audit log's actor_type exists to draw exactly this line.
    const { app } = buildApp();

    const res = await withKey(app, '/whoami');

    expect(res.body.data.actor).toEqual({ type: 'api_key', id: 'key-1' });
  });

  it('gets the floor role, not a real one', async () => {
    // A key has no role. `viewer` is the floor, so any code that reaches for
    // the role rather than the scopes gets the least it could have — and
    // `requireScopeOrPermission` never consults it at all.
    const { app } = buildApp();

    expect((await withKey(app, '/whoami')).body.data.role).toBe('viewer');
  });

  it('puts its scopes in the workspace context, and nothing else', async () => {
    // Two sources of truth would be one too many: the context permissions and
    // the key's scopes have to be the same list, or a route that checks the
    // wrong one is quietly wrong.
    const { app } = buildApp();

    const body = (await withKey(app, '/whoami')).body.data;

    expect(body.permissions).toEqual(['contact:read', 'campaign:write']);
    expect(body.permissions).toEqual(body.key.scopes);
  });

  it('carries its scopes as its permissions', async () => {
    const { app } = buildApp();

    expect((await withKey(app, '/needs-read')).status).toBe(200);
  });

  it('is refused a scope it does not hold', async () => {
    const { app } = buildApp();

    const res = await withKey(app, '/needs-launch');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('insufficient_permission');
  });
});

describe('what authentication refuses', () => {
  it('a missing header', async () => {
    const { app } = buildApp();

    expect((await request(app).get('/whoami')).status).toBe(401);
  });

  it('a malformed key, without a database round trip', async () => {
    // A scanner spraying garbage should cost a regex, not a hash and an
    // index probe.
    const { app, resolved } = buildApp();

    const res = await withKey(app, '/whoami', 'rk_live_short');

    expect(res.status).toBe(401);
    expect(resolved).toEqual([]);
  });

  it('a key that resolves to nothing', async () => {
    const { app } = buildApp({
      async resolve() {
        return null;
      },
    });

    const res = await withKey(app, '/whoami');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_api_key');
  });

  it('a revoked key, and says so', async () => {
    // Said plainly. The holder learns nothing they could not read on their
    // own dashboard, and "invalid" would send them hunting for a typo.
    const { app } = buildApp({
      async resolve() {
        return resolution({ revokedAt: new Date('2026-09-01T00:00:00.000Z') });
      },
    });

    const res = await withKey(app, '/whoami');

    expect(res.status).toBe(401);
    expect(res.body.error.message).toContain('revoked');
  });

  it('an expired key', async () => {
    const { app } = buildApp({
      async resolve() {
        return resolution({ expiresAt: new Date(NOW.getTime() - 1) });
      },
    });

    expect((await withKey(app, '/whoami')).body.error.message).toContain('expired');
  });

  it('accepts a key expiring in the future', async () => {
    const { app } = buildApp({
      async resolve() {
        return resolution({ expiresAt: new Date(NOW.getTime() + 1_000) });
      },
    });

    expect((await withKey(app, '/whoami')).status).toBe(200);
  });
});

describe('the workspace binding', () => {
  it('comes from the key, with no header at all', async () => {
    const { app } = buildApp();

    expect((await withKey(app, '/whoami')).body.data.workspaceId).toBe('ws-a');
  });

  it('accepts a matching header', async () => {
    const { app } = buildApp();

    const res = await withKey(app, '/whoami').set('X-Workspace-Id', 'ws-a');

    expect(res.status).toBe(200);
  });

  it('refuses a header naming a different workspace', async () => {
    // 400, not 404: the caller holds a valid credential and asked about the
    // wrong workspace, which is a bug in their client rather than something
    // to conceal.
    const { app } = buildApp();

    const res = await withKey(app, '/whoami').set('X-Workspace-Id', 'ws-b');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('different workspace');
  });

  it('ignores an empty header', async () => {
    const { app } = buildApp();

    expect((await withKey(app, '/whoami').set('X-Workspace-Id', '')).status).toBe(200);
  });
});

describe('scopes at authentication time', () => {
  it('drops a scope a key may no longer hold', async () => {
    // The forbidden set can grow. A key minted before a permission was
    // forbidden must stop carrying it the moment it is — checking only at
    // issue would make the rule true for new keys and false for old ones.
    expect(usableScopes(['contact:read', 'billing:write'])).toEqual(['contact:read']);
  });

  it('drops a scope that is no longer a permission at all', async () => {
    // A renamed permission must not keep working under its old name.
    expect(usableScopes(['contact:read', 'contact:teleport'])).toEqual(['contact:read']);
  });

  it('refuses a request whose only scope was dropped', async () => {
    const { app } = buildApp({
      async resolve() {
        return resolution({ scopes: ['billing:write'] });
      },
    });

    expect((await withKey(app, '/needs-read')).status).toBe(403);
  });
});

describe('recording that a key was used', () => {
  it('writes at most once per staleness window', async () => {
    // Writing on every request turns the busiest read path in the system
    // into a write path.
    const touch = vi.fn(async () => undefined);
    const { app } = buildApp({ touch, shouldTouch: () => false });

    await withKey(app, '/whoami');

    expect(touch).not.toHaveBeenCalled();
  });

  it('writes when it is stale', async () => {
    const touch = vi.fn(async () => undefined);
    const { app } = buildApp({ touch, shouldTouch: () => true });

    await withKey(app, '/whoami');

    expect(touch).toHaveBeenCalledWith('key-1', NOW);
  });

  it('does not fail the request when the write fails', async () => {
    const { app } = buildApp({
      touch: async () => {
        throw new Error('database down');
      },
      shouldTouch: () => true,
    });

    expect((await withKey(app, '/whoami')).status).toBe(200);
  });
});

describe('routes a key may never reach', () => {
  it('are refused whatever the scopes say', async () => {
    // The stronger statement than a scope check: there is no scope list to
    // get wrong. A key that could mint another key makes revocation a game
    // of whack-a-mole.
    const { app } = buildApp();

    const res = await withKey(app, '/no-keys');

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('cannot be used with an API key');
  });
});
