import { describe, expect, it } from 'vitest';
import type { UserId } from '@relayd/types';
import type { WorkspaceScope } from '@relayd/db';
import {
  MAX_ENDPOINTS,
  OutboundWebhookService,
  assertDeliverableUrl,
  isPrivateHost,
  normaliseEvents,
  type OutboundWebhookRepositories,
} from '../src/services/outbound-webhooks.js';

/**
 * Outbound webhook endpoints.
 *
 * Two things here are security rather than plumbing, and both are tested from
 * the attacker's side:
 *
 *   A webhook URL is a URL we fetch from inside our network on a customer's
 *   instruction. That is SSRF by definition, and refusing at subscribe time
 *   is a message the customer can act on rather than a support ticket.
 *
 *   The signing secret is shown once and stored as an ARN. There is nothing
 *   to reveal later, even to us.
 */

const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const USER = 'user-1' as UserId;
const NOW = new Date('2026-09-19T12:00:00.000Z');

function service(over: { existing?: number; find?: unknown } = {}) {
  const created: { id: string; url: string; secretRef: string; events: readonly string[] }[] = [];
  const audits: { action: string; after?: unknown; before?: unknown }[] = [];
  const rotated: { endpointId: string; secretRef: string }[] = [];
  const stored: { endpointId: string }[] = [];
  const deliveryLimits: number[] = [];
  let ids = 0;

  const endpoint = {
    id: 'ep-1',
    workspaceId: 'ws-1',
    url: 'https://example.test/hooks',
    secretRef: 'arn:secret:old',
    previousSecretRef: null,
    secretRotatedAt: null,
    events: ['campaign.launched'],
    status: 'active' as const,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    disabledAt: null,
    disabledReason: null,
    description: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  const repos: OutboundWebhookRepositories = {
    webhooks: {
      async list() {
        return Array.from({ length: over.existing ?? 0 }, () => endpoint);
      },
      async find() {
        return over.find === undefined ? endpoint : over.find;
      },
      async create(_scope: unknown, input: typeof created[number]) {
        created.push(input);
        return { ...endpoint, ...input };
      },
      async update(_scope: unknown, input: Record<string, unknown>) {
        return { ...endpoint, ...input };
      },
      async rotateSecret(_scope: unknown, input: { endpointId: string; secretRef: string }) {
        rotated.push(input);
        return {
          ...endpoint,
          secretRef: input.secretRef,
          previousSecretRef: endpoint.secretRef,
          secretRotatedAt: NOW,
        };
      },
      async recordHealth() {
        /* nothing */
      },
      async remove() {
        return true;
      },
      async listDeliveries(_scope: unknown, input: { limit: number }) {
        deliveryLimits.push(input.limit);
        return [];
      },
    } as unknown as OutboundWebhookRepositories['webhooks'],

    auditLogs: {
      async append(_scope: unknown, entry: { action: string }) {
        audits.push(entry);
      },
    } as unknown as OutboundWebhookRepositories['auditLogs'],
  };

  return {
    service: new OutboundWebhookService({
      unitOfWork: async (fn) => fn(repos),
      newId: () => `id-${(ids += 1)}`,
      now: () => NOW,
      async storeSecret(input) {
        stored.push({ endpointId: input.endpointId });
        return { ref: `arn:secret:${input.endpointId}`, secret: `whsec_${input.endpointId}` };
      },
    }),
    created,
    audits,
    rotated,
    stored,
    deliveryLimits,
  };
}

describe('the URL check', () => {
  it('accepts a public https URL', () => {
    expect(() => assertDeliverableUrl('https://hooks.example.com/relayd')).not.toThrow();
  });

  it('refuses http', () => {
    // A signed payload over plaintext is a signed payload anybody on the path
    // can read. The signature proves origin; it does not hide content.
    expect(() => assertDeliverableUrl('http://hooks.example.com/relayd')).toThrow();
  });

  it('refuses localhost', () => {
    for (const url of ['https://localhost/x', 'https://app.localhost/x', 'https://127.0.0.1/x']) {
      expect(() => assertDeliverableUrl(url), url).toThrow();
    }
  });

  it('refuses the cloud metadata address', () => {
    // The address every SSRF write-up opens with, because it hands out
    // instance credentials to anything that asks.
    expect(() => assertDeliverableUrl('https://169.254.169.254/latest/meta-data/')).toThrow();
  });

  it('refuses the private ranges', () => {
    for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1']) {
      expect(() => assertDeliverableUrl(`https://${host}/x`), host).toThrow();
    }
  });

  it('allows a public address that merely looks close to a private one', () => {
    // 172.32 is public; 11.x is public. An over-broad check refuses a
    // customer's real endpoint and is discovered by them, not by us.
    for (const host of ['172.32.0.1', '11.0.0.1', '192.169.1.1']) {
      expect(() => assertDeliverableUrl(`https://${host}/x`), host).not.toThrow();
    }
  });

  it('refuses IPv6 loopback and unique-local', () => {
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('fd00::1')).toBe(true);
    expect(isPrivateHost('fc00::1')).toBe(true);
  });

  it('refuses internal suffixes', () => {
    expect(isPrivateHost('db.internal')).toBe(true);
    expect(isPrivateHost('printer.local')).toBe(true);
  });

  it('refuses credentials in the URL', () => {
    // They end up in logs, in the delivery record, and in the customer's
    // screenshot when they ask for help.
    expect(() => assertDeliverableUrl('https://user:pass@hooks.example.com/x')).toThrow();
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => assertDeliverableUrl('not a url')).toThrow();
  });

  it('is case-insensitive about the host', () => {
    expect(isPrivateHost('LOCALHOST')).toBe(true);
  });
});

describe('the event subscription', () => {
  it('keeps only event types we emit', () => {
    expect(normaliseEvents(['campaign.launched', 'not.a.thing'])).toEqual(['campaign.launched']);
  });

  it('deduplicates', () => {
    expect(normaliseEvents(['email.sent', 'email.sent'])).toEqual(['email.sent']);
  });

  it('collapses a wildcard', () => {
    // Storing both makes the UI show a list that contradicts itself.
    expect(normaliseEvents(['*', 'email.sent'])).toEqual(['*']);
  });

  it('refuses a subscription to nothing', () => {
    expect(() => normaliseEvents([])).toThrow();
    expect(() => normaliseEvents(['not.a.thing'])).toThrow();
  });
});

describe('creating an endpoint', () => {
  it('returns the secret once', async () => {
    const { service: s } = service();

    const result = await s.create(SCOPE, {
      url: 'https://hooks.example.com/relayd',
      events: ['campaign.launched'],
      actor: { userId: USER },
    });

    expect(result.secretShownOnce).toMatch(/^whsec_/u);
  });

  it('stores an ARN rather than the secret', async () => {
    // The same rule provider credentials follow: the database stores a
    // pointer, so a database dump yields nothing usable.
    const { service: s, created } = service();

    const result = await s.create(SCOPE, {
      url: 'https://hooks.example.com/relayd',
      events: ['campaign.launched'],
      actor: { userId: USER },
    });

    expect(created[0]?.secretRef).toMatch(/^arn:/u);
    expect(created[0]?.secretRef).not.toContain(result.secretShownOnce);
  });

  it('never returns the ARN to the caller', async () => {
    // It is not a secret, and it is also not the caller's business: it names
    // a path in our account.
    const { service: s } = service();

    const result = await s.create(SCOPE, {
      url: 'https://hooks.example.com/relayd',
      events: ['campaign.launched'],
      actor: { userId: USER },
    });

    expect(JSON.stringify(result.endpoint)).not.toContain('arn:');
  });

  it('keeps the secret out of the audit trail', async () => {
    const { service: s, audits } = service();

    const result = await s.create(SCOPE, {
      url: 'https://hooks.example.com/relayd',
      events: ['campaign.launched'],
      actor: { userId: USER },
    });

    const serialised = JSON.stringify(audits);
    expect(serialised).not.toContain(result.secretShownOnce);
    expect(serialised).not.toContain('arn:');
  });

  it('refuses an SSRF URL before it stores anything', async () => {
    const { service: s, stored, created } = service();

    await expect(
      s.create(SCOPE, {
        url: 'https://169.254.169.254/x',
        events: ['campaign.launched'],
        actor: { userId: USER },
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(stored).toEqual([]);
    expect(created).toEqual([]);
  });

  it('caps how many a workspace may have', async () => {
    const { service: s } = service({ existing: MAX_ENDPOINTS });

    await expect(
      s.create(SCOPE, {
        url: 'https://hooks.example.com/relayd',
        events: ['*'],
        actor: { userId: USER },
      }),
    ).rejects.toMatchObject({ status: 402 });
  });
});

describe('rotating the secret', () => {
  it('returns the new one once and keeps the old one as previous', async () => {
    // The overlap is what makes rotation something a customer will do: an
    // integrator who has not redeployed keeps verifying.
    const { service: s, rotated } = service();

    const result = await s.rotateSecret(SCOPE, {
      endpointId: 'ep-1',
      actor: { userId: USER },
    });

    expect(result.secretShownOnce).toMatch(/^whsec_/u);
    expect(rotated[0]?.secretRef).toMatch(/^arn:/u);
    expect(result.endpoint.secretRotatedAt).toEqual(NOW);
  });

  it('404s an endpoint from another workspace', async () => {
    const { service: s } = service({ find: null });

    await expect(
      s.rotateSecret(SCOPE, { endpointId: 'ep-elsewhere', actor: { userId: USER } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('records the rotation without recording the secret', async () => {
    const { service: s, audits } = service();

    const result = await s.rotateSecret(SCOPE, { endpointId: 'ep-1', actor: { userId: USER } });

    const entry = audits.find((row) => row.action === 'webhook_endpoint.secret_rotated');
    expect(entry).toBeDefined();
    expect(JSON.stringify(audits)).not.toContain(result.secretShownOnce);
  });
});

describe('updating an endpoint', () => {
  it('checks a new URL the same way', async () => {
    const { service: s } = service();

    await expect(
      s.update(SCOPE, {
        endpointId: 'ep-1',
        url: 'http://10.0.0.1/x',
        actor: { userId: USER },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('404s an endpoint from another workspace', async () => {
    const { service: s } = service({ find: null });

    await expect(
      s.update(SCOPE, { endpointId: 'ep-x', status: 'paused', actor: { userId: USER } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('records what changed', async () => {
    const { service: s, audits } = service();

    await s.update(SCOPE, { endpointId: 'ep-1', status: 'paused', actor: { userId: USER } });

    const entry = audits.find((row) => row.action === 'webhook_endpoint.updated');
    expect(entry?.before).toMatchObject({ status: 'active' });
    expect(entry?.after).toMatchObject({ status: 'paused' });
  });
});

describe('the delivery log', () => {
  it('404s an endpoint from another workspace', async () => {
    const { service: s } = service({ find: null });

    await expect(
      s.deliveries(SCOPE, { endpointId: 'ep-x' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('bounds the page', async () => {
    // A customer asking for a hundred thousand delivery rows is a customer
    // who gets a hundred, and a query that reads a partition rather than all
    // of them.
    const { service: s, deliveryLimits } = service();

    await s.deliveries(SCOPE, { endpointId: 'ep-1', limit: 100_000 });
    await s.deliveries(SCOPE, { endpointId: 'ep-1', limit: 0 });
    await s.deliveries(SCOPE, { endpointId: 'ep-1' });

    expect(deliveryLimits).toEqual([100, 1, 50]);
  });
});
