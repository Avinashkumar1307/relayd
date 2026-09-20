import { describe, expect, it } from 'vitest';
import { AppError } from '@relayd/types';
import type { SenderIdentityRow } from '@relayd/db';
import type { WorkspaceScope } from '@relayd/db';
import type { SenderAccountId } from '@relayd/types';
import { ProviderService } from '../src/services/providers.js';
import type { ProviderRepositories } from '../src/services/providers.js';
import { DNS_RECHECK_MINUTES, normaliseStatus, senderDnsView } from '../src/services/sender-dns.js';

/**
 * The sender DNS drawer (E2b).
 *
 * The rule under test throughout: **this endpoint reports and never
 * invents.** It has no resolver and no provider client, and the one way it
 * could mislead a customer is by printing a record value or a "found" line
 * that nobody ever looked up. A customer who publishes a DKIM record with a
 * selector we guessed has published a record that can never verify.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');
const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const SENDER = 'snd-1' as SenderAccountId;

function identity(over: Partial<SenderIdentityRow> = {}): SenderIdentityRow {
  return {
    id: 'idn-1',
    workspaceId: 'ws-1',
    providerId: 'conn-1',
    kind: 'domain',
    value: 'northwind.travel',
    verificationStatus: 'verified',
    dkimStatus: null,
    spfStatus: null,
    dmarcStatus: null,
    dnsRecords: null,
    verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    lastCheckedAt: new Date('2026-09-19T11:52:00.000Z'),
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...over,
  } as unknown as SenderIdentityRow;
}

describe('the drawer never invents a record', () => {
  it('leaves the value empty and says nothing was checked when the provider told us nothing', () => {
    const view = senderDnsView({ senderId: 'snd-1', identity: identity(), now: NOW });

    for (const record of view.records) {
      expect(record.value).toBe('');
    }

    expect(view.records.map((record) => record.kind)).toEqual(['SPF', 'DKIM', 'DMARC']);
  });

  it('leaves the DKIM host blank rather than guessing a selector', () => {
    // A DKIM host carries a provider-chosen selector — rl1._domainkey,
    // s1._domainkey. Printing a made-up one would have the customer publish
    // a record at an address the provider will never look at.
    const view = senderDnsView({ senderId: 'snd-1', identity: identity(), now: NOW });

    const dkim = view.records.find((record) => record.kind === 'DKIM');
    expect(dkim?.host).toBe('');
  });

  it('derives the SPF and DMARC hosts, which are fixed by the standards', () => {
    const view = senderDnsView({ senderId: 'snd-1', identity: identity(), now: NOW });

    expect(view.records.find((record) => record.kind === 'SPF')?.host).toBe('northwind.travel');
    expect(view.records.find((record) => record.kind === 'DMARC')?.host).toBe(
      '_dmarc.northwind.travel',
    );
  });

  it('takes the domain from the address when the identity is a single mailbox', () => {
    const view = senderDnsView({
      senderId: 'snd-1',
      identity: identity({ kind: 'email', value: 'Hello@Northwind.Travel' }),
      now: NOW,
    });

    expect(view.records.find((record) => record.kind === 'SPF')?.host).toBe('northwind.travel');
  });

  it('prints what the provider actually reported when it did report something', () => {
    const view = senderDnsView({
      senderId: 'snd-1',
      identity: identity({
        dnsRecords: {
          DKIM: {
            type: 'TXT',
            host: 'rl1._domainkey.northwind.travel',
            value: 'v=DKIM1; k=rsa; p=MIIB…',
            found: 'Not found at rl1._domainkey.northwind.travel',
            status: 'failed',
          },
        },
      }),
      now: NOW,
    });

    const dkim = view.records.find((record) => record.kind === 'DKIM');
    expect(dkim?.host).toBe('rl1._domainkey.northwind.travel');
    expect(dkim?.found).toBe('Not found at rl1._domainkey.northwind.travel');
    expect(dkim?.status).toBe('failed');
  });
});

describe('provider vocabulary folds onto three states', () => {
  it.each([
    ['Success', 'verified'],
    ['valid', 'verified'],
    ['active', 'verified'],
    ['Pending', 'pending'],
    ['TemporaryFailure', 'failed'],
    ['not found', 'failed'],
  ])('reads %s as %s', (raw, expected) => {
    expect(normaliseStatus(raw)).toBe(expected);
  });

  it('reports nothing rather than a state for an empty or missing value', () => {
    expect(normaliseStatus('')).toBeNull();
    expect(normaliseStatus(null)).toBeNull();
    expect(normaliseStatus(undefined)).toBeNull();
  });

  it('does not report a failure nobody observed', () => {
    // An identity that is merely pending has no per-record evidence. Marking
    // its records `failed` would send a customer looking for a DNS problem
    // that has not been diagnosed.
    const view = senderDnsView({
      senderId: 'snd-1',
      identity: identity({ verificationStatus: 'pending' }),
      now: NOW,
    });

    expect(view.records.every((record) => record.status === 'pending')).toBe(true);
  });
});

describe('the problem strip and the countdown', () => {
  it('says nothing when all three records verified', () => {
    const view = senderDnsView({ senderId: 'snd-1', identity: identity(), now: NOW });
    expect(view.problem).toBeNull();
  });

  it('names the failing records, and prefers a failure over a pending one', () => {
    const view = senderDnsView({
      senderId: 'snd-1',
      identity: identity({ dkimStatus: 'Failed', spfStatus: 'Pending', dmarcStatus: 'Success' }),
      now: NOW,
    });

    expect(view.problem?.title).toContain('DKIM');
    expect(view.problem?.title).not.toContain('SPF');
  });

  it('counts down to the next check rather than going negative', () => {
    // lastCheckedAt is eight minutes ago in the fixture, so seven remain.
    const view = senderDnsView({ senderId: 'snd-1', identity: identity(), now: NOW });
    expect(view.nextCheckInMinutes).toBe(7);

    const stale = senderDnsView({
      senderId: 'snd-1',
      identity: identity({ lastCheckedAt: new Date('2026-09-01T00:00:00.000Z') }),
      now: NOW,
    });
    expect(stale.nextCheckInMinutes).toBe(0);
  });

  it('falls back to the full interval when the last check is in the future', () => {
    // Clock skew between two containers is enough to produce this, and a
    // negative countdown renders as "next check in -3 minutes".
    const view = senderDnsView({
      senderId: 'snd-1',
      identity: identity({ lastCheckedAt: new Date('2026-09-20T00:00:00.000Z') }),
      now: NOW,
    });

    expect(view.nextCheckInMinutes).toBe(DNS_RECHECK_MINUTES);
  });
});

// --------------------------------------------------------------- the service

function fakeRepositories(over: { sender?: unknown; identity?: unknown } = {}) {
  const audit: string[] = [];

  const repos = {
    connections: {
      async findById() {
        return {
          id: 'conn-1',
          providerType: 'ses',
          status: 'active',
          capabilities: { supportsWebhooks: true },
        };
      },
    },
    identities: {
      async findById() {
        return over.identity === undefined ? identity() : over.identity;
      },
    },
    senders: {
      async findById() {
        return over.sender === undefined
          ? { id: 'snd-1', providerId: 'conn-1', identityId: 'idn-1' }
          : over.sender;
      },
    },
    auditLogs: {
      async append(_scope: WorkspaceScope, entry: { action: string }) {
        audit.push(entry.action);
      },
    },
  } as unknown as ProviderRepositories;

  return { repos, audit };
}

function service(
  over: {
    sender?: unknown;
    identity?: unknown;
    dnsChecks?: unknown;
    ingestTests?: unknown;
    connection?: unknown;
  } = {},
) {
  const { repos, audit } = fakeRepositories(over);

  if (over.connection !== undefined) {
    (repos as unknown as { connections: { findById: () => unknown } }).connections.findById =
      () => over.connection;
  }

  const enqueued: unknown[] = [];

  return {
    audit,
    enqueued,
    service: new ProviderService({
      unitOfWork: (fn) => fn(repos),
      adapterFor: () => null,
      secrets: { async write() {}, async destroy() {} } as never,
      credentialPathFor: () => 'path',
      ingestBaseUrl: 'https://ingest.relayd.test',
      newId: () => 'new-id',
      now: () => NOW,
      currentActor: () => ({ type: 'user', id: 'usr-1' }) as never,
      ...(over.dnsChecks === undefined
        ? {}
        : {
            dnsChecks: {
              async enqueue(input: unknown) {
                enqueued.push(input);
                return { jobId: 'job-1' };
              },
            },
          }),
      ...(over.ingestTests === undefined
        ? {}
        : {
            ingestTests: {
              async enqueue(input: unknown) {
                enqueued.push(input);
                return { jobId: 'job-2' };
              },
            },
          }),
    }),
  };
}

describe('GET /senders/:id/dns', () => {
  it('answers with the drawer for a sender in this workspace', async () => {
    const view = await service().service.senderDns(SCOPE, SENDER);

    expect(view.senderId).toBe('snd-1');
    expect(view.records).toHaveLength(3);
  });

  it('is 404 for a sender that is not this workspace’s', async () => {
    // Not 403. A non-member must not be able to tell "no such sender" from
    // "somebody else's sender" (CLAUDE.md section 11).
    await expect(service({ sender: null }).service.senderDns(SCOPE, SENDER)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('is 404 rather than a crash when the identity has gone', async () => {
    await expect(
      service({ identity: null }).service.senderDns(SCOPE, SENDER),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('POST /senders/:id/dns/check', () => {
  it('queues the check and answers with the state as it stands', async () => {
    const world = service({ dnsChecks: true });

    const view = await world.service.checkSenderDns(SCOPE, SENDER);

    expect(world.enqueued).toEqual([
      { workspaceId: 'ws-1', providerConnectionId: 'conn-1', senderIdentityId: 'idn-1' },
    ]);
    // Not a bare acknowledgement: the browser writes this straight into the
    // drawer's cache, and `nextCheckInMinutes` says when it will move.
    expect(view.records).toHaveLength(3);
  });

  it('is 503, not a silent success, when nothing can run the check', async () => {
    await expect(service().service.checkSenderDns(SCOPE, SENDER)).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe('POST /providers/:id/ingest/test', () => {
  it('queues a drill and audits it', async () => {
    const world = service({ ingestTests: true });

    const result = await world.service.sendIngestTestEvent(SCOPE, 'conn-1' as never);

    expect(result).toEqual({ sent: true });
    expect(world.enqueued).toEqual([{ workspaceId: 'ws-1', providerConnectionId: 'conn-1' }]);
    // An operator reading provider_webhook_events later has to be able to
    // tell a drill from a real event.
    expect(world.audit).toContain('provider.ingest_tested');
  });

  it('refuses for a provider that has no inbound webhooks', async () => {
    // D4. A spinner that never resolves would teach an SMTP customer the
    // wrong thing about why their bounces are missing.
    const world = service({
      ingestTests: true,
      connection: {
        id: 'conn-1',
        providerType: 'smtp',
        status: 'active',
        capabilities: { supportsWebhooks: false },
      },
    });

    await expect(
      world.service.sendIngestTestEvent(SCOPE, 'conn-1' as never),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses on a revoked connection', async () => {
    const world = service({
      ingestTests: true,
      connection: {
        id: 'conn-1',
        providerType: 'ses',
        status: 'revoked',
        capabilities: { supportsWebhooks: true },
      },
    });

    await expect(
      world.service.sendIngestTestEvent(SCOPE, 'conn-1' as never),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('is 404 for a connection in another workspace', async () => {
    const world = service({ ingestTests: true, connection: null });

    await expect(
      world.service.sendIngestTestEvent(SCOPE, 'conn-1' as never),
    ).rejects.toMatchObject({ status: 404 });
  });
});
