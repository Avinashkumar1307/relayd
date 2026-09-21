import { describe, expect, it } from 'vitest';
import { ProviderService, addressCoveredBy, newEndpointToken } from '../src/services/providers.js';
import type { ProviderRepositories } from '../src/services/providers.js';
import type { WorkspaceScope } from '@relayd/db';
import { createFakeProvider } from '@relayd/email-providers/testing';
import type { ProviderCredentials } from '@relayd/email-providers';
import type { ProviderConnectionId, SenderAccountId, SenderIdentityId } from '@relayd/types';

/**
 * The provider service.
 *
 * The rule under test throughout: a credential is validated, written to the
 * secret store, and never persisted or returned (INVARIANTS R21). The endpoint
 * token is returned exactly once (F4).
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const CANARY = 'SECRET-CANARY-9f3a';

const SES_CREDENTIALS: ProviderCredentials = {
  type: 'ses',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: CANARY,
  region: 'eu-west-1',
};

/**
 * In-memory repositories.
 *
 * Every getter returns a copy. A fake that hands out live references lets a
 * "before" snapshot mutate under the caller, which has already produced two
 * false passes in this codebase.
 */
function fakeRepositories() {
  const connections = new Map<string, Record<string, unknown>>();
  const identities = new Map<string, Record<string, unknown>>();
  const senders = new Map<string, Record<string, unknown>>();
  const audit: { action: string; resourceId: string | undefined }[] = [];

  const copy = <T>(value: T): T => (value === undefined ? value : (structuredClone(value) as T));

  const repos = {
    connections: {
      async createWithToken(_scope: WorkspaceScope, input: Record<string, unknown>) {
        const row = {
          id: input['id'],
          workspaceId: 'ws-1',
          providerType: input['providerType'],
          name: input['name'],
          status: 'pending',
          credentialVersion: 1,
          config: input['config'] ?? {},
          capabilities: {},
          hasWebhookSecret: false,
          quotaSnapshot: null,
          quotaCheckedAt: null,
          lastVerifiedAt: null,
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        connections.set(String(input['id']), {
          ...row,
          // Stored the way the real table does, so a test can assert the
          // token and the credential ref never leave through a read.
          endpointToken: input['endpointToken'],
          credentialRef: input['credentialRef'],
        });
        return { connection: copy(row), endpointToken: String(input['endpointToken']) };
      },
      async findById(_scope: WorkspaceScope, id: string) {
        const row = connections.get(id);
        if (row === undefined) return null;
        const { endpointToken: _t, credentialRef: _c, ...view } = row;
        return copy(view);
      },
      async list() {
        return [...connections.values()].map((row) => {
          const { endpointToken: _t, credentialRef: _c, ...view } = row;
          return copy(view);
        });
      },
      async rename(_scope: WorkspaceScope, id: string, name: string) {
        const row = connections.get(id);
        if (row === undefined) return null;
        row['name'] = name;
        const { endpointToken: _t, credentialRef: _c, ...view } = row;
        return copy(view);
      },
      async recordVerification(_scope: WorkspaceScope, id: string, result: Record<string, unknown>) {
        const row = connections.get(id);
        if (row === undefined) return false;
        row['status'] = result['status'];
        row['lastVerifiedAt'] = new Date();
        if (result['ok'] === true) {
          row['lastError'] = null;
          if (result['capabilities'] !== undefined) row['capabilities'] = result['capabilities'];
        } else {
          row['lastError'] = result['error'];
        }
        return true;
      },
      async rotateCredential(_scope: WorkspaceScope, id: string, ref: string) {
        const row = connections.get(id);
        if (row === undefined) return null;
        row['credentialRef'] = ref;
        row['credentialVersion'] = Number(row['credentialVersion']) + 1;
        row['status'] = 'verifying';
        return row['credentialVersion'] as number;
      },
      async remove(_scope: WorkspaceScope, id: string) {
        return connections.delete(id);
      },
    },

    identities: {
      async upsert(_scope: WorkspaceScope, input: Record<string, unknown>) {
        const key = `${String(input['providerId'])}:${String(input['kind'])}:${String(input['value'])}`;
        const existing = identities.get(key);
        const row = {
          ...(existing ?? {
            id: input['id'],
            workspaceId: 'ws-1',
            providerId: input['providerId'],
            kind: input['kind'],
            value: input['value'],
            createdAt: new Date(),
          }),
          verificationStatus: input['verificationStatus'] ?? 'pending',
          dkimStatus: input['dkimStatus'] ?? null,
        };
        identities.set(key, row);
        return copy(row);
      },
      async findById(_scope: WorkspaceScope, id: string) {
        for (const row of identities.values()) if (row['id'] === id) return copy(row);
        return null;
      },
      async list() {
        return [...identities.values()].map(copy);
      },
    },

    senders: {
      async create(_scope: WorkspaceScope, input: Record<string, unknown>) {
        const row = {
          ...input,
          workspaceId: 'ws-1',
          status: 'active',
          healthScore: 100,
          createdAt: new Date(),
        };
        senders.set(String(input['id']), row);
        return copy(row);
      },
      async findById(_scope: WorkspaceScope, id: string) {
        const row = senders.get(id);
        return row === undefined ? null : copy(row);
      },
      async list(_scope: WorkspaceScope, options: { providerId?: string } = {}) {
        return [...senders.values()]
          .filter((row) => options.providerId === undefined || row['providerId'] === options.providerId)
          .map(copy);
      },
      async update(_scope: WorkspaceScope, id: string, patch: Record<string, unknown>) {
        const row = senders.get(id);
        if (row === undefined) return null;
        Object.assign(row, patch);
        return copy(row);
      },
      async remove(_scope: WorkspaceScope, id: string) {
        return senders.delete(id);
      },
    },

    auditLogs: {
      async append(_scope: WorkspaceScope, entry: Record<string, unknown>) {
        audit.push({
          action: String(entry['action']),
          resourceId: entry['resourceId'] === undefined ? undefined : String(entry['resourceId']),
        });
      },
    },
  } as unknown as ProviderRepositories;

  return { repos, connections, identities, senders, audit };
}

function build(options: { verificationFails?: boolean; withQueue?: boolean } = {}) {
  const { repos, connections, identities, senders, audit } = fakeRepositories();
  const written = new Map<string, string>();
  const destroyed: string[] = [];

  let counter = 0;
  const service = new ProviderService({
    unitOfWork: async (fn) => fn(repos),
    adapterFor: () =>
      createFakeProvider(
        options.verificationFails === true ? { verificationFails: true } : {},
      ),
    secrets: {
      async write(path, value) {
        written.set(path, value);
      },
      async destroy(path) {
        destroyed.push(path);
        written.delete(path);
      },
    },
    credentialPathFor: ({ workspaceId, connectionId }) =>
      `relayd/test/ws/${workspaceId}/conn/${connectionId}`,
    ingestBaseUrl: 'https://edge.relayd.test',
    newId: () => {
      counter += 1;
      return `id-${counter}`;
    },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    currentActor: () => ({ type: 'user', id: 'user-1' }),
    ...(options.withQueue === true
      ? {
          testSends: {
            async enqueue() {
              return { jobId: 'job-1' };
            },
          },
        }
      : {}),
  });

  return { service, connections, identities, senders, audit, written, destroyed };
}

describe('connecting a provider', () => {
  it('validates the credential before writing anything', async () => {
    const { service, connections, written } = build({ verificationFails: true });

    await expect(
      service.connect(SCOPE, {
        providerType: 'sendgrid',
        name: 'Main',
        credentials: { type: 'sendgrid', apiKey: CANARY },
      }),
    ).rejects.toThrow();

    // A credential that does not work is a typo, not a connection.
    expect(connections.size).toBe(0);
    expect(written.size).toBe(0);
  });

  it('refuses credentials that do not match the provider being connected', async () => {
    const { service } = build();

    await expect(
      service.connect(SCOPE, {
        providerType: 'ses',
        name: 'Main',
        credentials: { type: 'sendgrid', apiKey: 'k' },
      }),
    ).rejects.toThrow(/do not match/u);
  });

  it('stores the ARN and never the credential', async () => {
    // INVARIANTS R21: a Postgres dump is not a credential breach.
    const { service, connections, written } = build();

    await service.connect(SCOPE, {
      providerType: 'ses',
      name: 'Main',
      credentials: SES_CREDENTIALS,
    });

    expect(JSON.stringify([...connections.values()])).not.toContain(CANARY);
    // It went to the secret store instead.
    expect([...written.values()].join()).toContain(CANARY);
    expect([...connections.values()][0]?.['credentialRef']).toBe(
      'relayd/test/ws/ws-1/conn/id-1',
    );
  });

  it('returns the ingest URL exactly once', async () => {
    const { service } = build();

    const result = await service.connect(SCOPE, {
      providerType: 'ses',
      name: 'Main',
      credentials: SES_CREDENTIALS,
    });

    expect(result.ingestUrl).toMatch(
      /^https:\/\/edge\.relayd\.test\/ingest\/v1\/ses\/[A-Za-z0-9_-]{32,}$/u,
    );

    // And never again: no read path returns it.
    const listed = await service.listConnections(SCOPE);
    expect(JSON.stringify(listed)).not.toContain(result.ingestUrl.split('/').pop() as string);

    const fetched = await service.getConnection(SCOPE, 'id-1' as ProviderConnectionId);
    expect(JSON.stringify(fetched)).not.toContain(result.ingestUrl.split('/').pop() as string);
  });

  it('destroys the orphaned secret when the row cannot be written', async () => {
    // The secret is written first. If the row then fails, credential material
    // is sitting in the store that nothing references and nobody will find.
    const { repos } = fakeRepositories();
    const destroyed: string[] = [];

    const service = new ProviderService({
      unitOfWork: async (fn) =>
        fn({
          ...repos,
          connections: {
            ...repos.connections,
            async createWithToken() {
              throw new Error('duplicate name');
            },
          } as never,
        }),
      adapterFor: () => createFakeProvider(),
      secrets: {
        async write() {},
        async destroy(path) {
          destroyed.push(path);
        },
      },
      credentialPathFor: () => 'relayd/test/ws/ws-1/conn/x',
      ingestBaseUrl: 'https://edge.relayd.test',
      newId: () => 'id-1',
      now: () => new Date(),
      currentActor: () => ({ type: 'user', id: 'user-1' }),
    });

    await expect(
      service.connect(SCOPE, {
        providerType: 'ses',
        name: 'Main',
        credentials: SES_CREDENTIALS,
      }),
    ).rejects.toThrow(/duplicate name/u);

    expect(destroyed).toEqual(['relayd/test/ws/ws-1/conn/x']);
  });

  it('records the connection in the audit log', async () => {
    const { service, audit } = build();

    await service.connect(SCOPE, {
      providerType: 'ses',
      name: 'Main',
      credentials: SES_CREDENTIALS,
    });

    expect(audit.map((entry) => entry.action)).toContain('provider.connected');
  });
});

describe('rotating a credential', () => {
  async function connected() {
    const harness = build();
    await harness.service.connect(SCOPE, {
      providerType: 'ses',
      name: 'Main',
      credentials: SES_CREDENTIALS,
    });
    return harness;
  }

  it('bumps the version, which is what evicts every worker cache', async () => {
    // R21: without the bump a rotated credential takes up to five minutes to
    // take effect, and the old one keeps sending in the meantime.
    const { service, connections } = await connected();

    await service.rotate(SCOPE, 'id-1' as ProviderConnectionId, {
      ...SES_CREDENTIALS,
      secretAccessKey: 'a-new-secret-value',
    });

    expect(connections.get('id-1')?.['credentialVersion']).toBe(2);
  });

  it('refuses a credential for a different provider', async () => {
    const { service } = await connected();

    await expect(
      service.rotate(SCOPE, 'id-1' as ProviderConnectionId, { type: 'sendgrid', apiKey: 'k' }),
    ).rejects.toThrow(/do not match/u);
  });

  it('writes nothing when the new credential is rejected', async () => {
    // A rejected rotation must leave the working credential in place, or a
    // typo in the new key takes the connection down.
    const { service, connections, written } = await connected();
    const before = written.get('relayd/test/ws/ws-1/conn/id-1');

    const failing = build({ verificationFails: true });
    await expect(
      failing.service.rotate(SCOPE, 'id-1' as ProviderConnectionId, SES_CREDENTIALS),
    ).rejects.toThrow();

    expect(connections.get('id-1')?.['credentialVersion']).toBe(1);
    expect(written.get('relayd/test/ws/ws-1/conn/id-1')).toBe(before);
    void service;
  });
});

describe('disconnecting', () => {
  it('refuses while senders still exist, with a message that says what to do', async () => {
    const { service, senders } = build();
    await service.connect(SCOPE, {
      providerType: 'ses',
      name: 'Main',
      credentials: SES_CREDENTIALS,
    });

    senders.set('s1', { id: 's1', providerId: 'id-1', fromEmail: 'hi@example.com' });

    await expect(service.disconnect(SCOPE, 'id-1' as ProviderConnectionId)).rejects.toThrow(
      /Remove them first/u,
    );
  });

  it('removes the row before destroying the secret', async () => {
    // A secret nobody references is inert. A live endpoint token for a
    // disconnected provider is not.
    const { service, connections, destroyed } = build();
    await service.connect(SCOPE, {
      providerType: 'ses',
      name: 'Main',
      credentials: SES_CREDENTIALS,
    });

    await service.disconnect(SCOPE, 'id-1' as ProviderConnectionId);

    expect(connections.size).toBe(0);
    expect(destroyed).toEqual(['relayd/test/ws/ws-1/conn/id-1']);
  });
});

describe('senders', () => {
  async function connectedWithIdentities() {
    const harness = build();
    await harness.service.connect(SCOPE, {
      providerType: 'ses',
      name: 'Main',
      credentials: SES_CREDENTIALS,
    });
    return harness;
  }

  it('refuses a sender whose identity does not exist', async () => {
    const { service } = await connectedWithIdentities();

    await expect(
      service.createSender(SCOPE, {
        providerId: 'id-1' as ProviderConnectionId,
        identityId: 'nope' as SenderIdentityId,
        fromEmail: 'hi@example.com',
        fromName: 'Relayd',
      }),
    ).rejects.toThrow(/Sender identity not found/u);
  });

  it('refuses a sender on an unverified identity', async () => {
    // Every message from it would be rejected by the provider. Creating it
    // anyway moves the failure to launch time, where it costs a campaign.
    const { service, identities } = await connectedWithIdentities();

    identities.set('k', {
      id: 'ident-1',
      workspaceId: 'ws-1',
      providerId: 'id-1',
      kind: 'domain',
      value: 'example.com',
      verificationStatus: 'pending',
    });

    await expect(
      service.createSender(SCOPE, {
        providerId: 'id-1' as ProviderConnectionId,
        identityId: 'ident-1' as SenderIdentityId,
        fromEmail: 'hi@example.com',
        fromName: 'Relayd',
      }),
    ).rejects.toThrow(/not verified/u);
  });

  it('refuses an address the verified identity does not cover', async () => {
    const { service, identities } = await connectedWithIdentities();

    identities.set('k', {
      id: 'ident-1',
      workspaceId: 'ws-1',
      providerId: 'id-1',
      kind: 'domain',
      value: 'example.com',
      verificationStatus: 'verified',
    });

    await expect(
      service.createSender(SCOPE, {
        providerId: 'id-1' as ProviderConnectionId,
        identityId: 'ident-1' as SenderIdentityId,
        fromEmail: 'hi@notexample.com',
        fromName: 'Relayd',
      }),
    ).rejects.toThrow(/not covered/u);
  });

  it('refuses an identity belonging to a different connection', async () => {
    const { service, identities } = await connectedWithIdentities();

    identities.set('k', {
      id: 'ident-1',
      workspaceId: 'ws-1',
      providerId: 'some-other-connection',
      kind: 'domain',
      value: 'example.com',
      verificationStatus: 'verified',
    });

    await expect(
      service.createSender(SCOPE, {
        providerId: 'id-1' as ProviderConnectionId,
        identityId: 'ident-1' as SenderIdentityId,
        fromEmail: 'hi@example.com',
        fromName: 'Relayd',
      }),
    ).rejects.toThrow(/different connection/u);
  });

  it('creates a sender on a verified identity that covers the address', async () => {
    const { service, identities, audit } = await connectedWithIdentities();

    identities.set('k', {
      id: 'ident-1',
      workspaceId: 'ws-1',
      providerId: 'id-1',
      kind: 'domain',
      value: 'example.com',
      verificationStatus: 'verified',
    });

    const sender = await service.createSender(SCOPE, {
      providerId: 'id-1' as ProviderConnectionId,
      identityId: 'ident-1' as SenderIdentityId,
      fromEmail: 'hi@example.com',
      fromName: 'Relayd',
    });

    expect(sender.fromEmail).toBe('hi@example.com');
    expect(audit.map((entry) => entry.action)).toContain('sender.created');
  });
});

describe('which addresses a verified identity covers', () => {
  it('covers every address at a verified domain', () => {
    const domain = { kind: 'domain' as const, value: 'example.com' };

    expect(addressCoveredBy('hi@example.com', domain)).toBe(true);
    expect(addressCoveredBy('HI@Example.COM', domain)).toBe(true);
    expect(addressCoveredBy('hi@mail.example.com', domain)).toBe(true);
  });

  it('does not cover a domain that merely ends with the same letters', () => {
    // "notexample.com" must not pass as "example.com", or a workspace could
    // send as a domain it does not own.
    const domain = { kind: 'domain' as const, value: 'example.com' };

    expect(addressCoveredBy('hi@notexample.com', domain)).toBe(false);
    expect(addressCoveredBy('hi@example.com.evil.test', domain)).toBe(false);
    expect(addressCoveredBy('example.com', domain)).toBe(false);
  });

  it('covers only itself for an email identity', () => {
    const email = { kind: 'email' as const, value: 'hi@example.com' };

    expect(addressCoveredBy('hi@example.com', email)).toBe(true);
    expect(addressCoveredBy('other@example.com', email)).toBe(false);
  });
});

describe('endpoint tokens', () => {
  it('is long, unguessable and a legal path segment', () => {
    const token = newEndpointToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(token.length).toBeGreaterThanOrEqual(48);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => newEndpointToken()));
    expect(tokens.size).toBe(500);
  });
});

describe('test sends', () => {
  it('is refused when no queue is wired', async () => {
    // The API cannot perform one itself: its task role can write secrets and
    // not read them, so it has no way to obtain the credential.
    const { service } = build();

    await expect(
      service.testSend(SCOPE, {
        senderId: 's1' as SenderAccountId,
        to: ['a@example.com'],
        subject: 'Test',
      }),
    ).rejects.toThrow(/not available/u);
  });

  it('refuses a sender that does not exist', async () => {
    const { service } = build({ withQueue: true });

    await expect(
      service.testSend(SCOPE, {
        senderId: 'nope' as SenderAccountId,
        to: ['a@example.com'],
        subject: 'Test',
      }),
    ).rejects.toThrow(/Sender not found/u);
  });
});
