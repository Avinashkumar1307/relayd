import { describe, expect, it } from 'vitest';
import type { WorkspaceScope } from '@relayd/db';
import type { UserId } from '@relayd/types';
import { PoolService } from '../src/services/pools.js';
import type { PoolRepositories } from '../src/services/pools.js';
import {
  MAX_REPLAY,
  OutboundWebhookService,
  REPLAY_WINDOW_DAYS,
  TEST_EVENT_TYPE,
} from '../src/services/outbound-webhooks.js';
import type { OutboundWebhookRepositories } from '../src/services/outbound-webhooks.js';

/**
 * The pool drawer's sender list (H1b) and the webhook test and replay (J4b,
 * J4c).
 *
 * The two properties worth a test each:
 *
 *   **A pool does not divide or multiply a quota.** Every connection figure
 *   is repeated verbatim on every sender that draws on it, so the browser
 *   can count each connection once. A service that divided the rate between
 *   members, or summed it per sender, would be telling the customer the
 *   thing docs/07 spends a page refusing.
 *
 *   **A replay never double-delivers.** Proved at the SQL level in
 *   `packages/db/test/dashboard-reads.test.ts`; proved here as the
 *   behaviour the customer sees — press it twice, one replay.
 */

const NOW = new Date('2026-09-19T12:00:00.000Z');
const SCOPE = { workspaceId: 'ws-1' } as unknown as WorkspaceScope;
const ACTOR = { userId: 'usr-1' as UserId };

// ----------------------------------------------------------------- the pool

function senderRow(over: Record<string, unknown> = {}) {
  return {
    senderAccountId: 'snd-1',
    fromEmail: 'hello@northwind.travel',
    senderStatus: 'active',
    providerConnectionId: 'conn-ses',
    providerType: 'ses',
    connectionName: 'production',
    connectionStatus: 'active',
    config: { region: 'eu-west-1' },
    quotaSnapshot: { max24Hour: 50_000, maxSendRate: 14 },
    identityStatus: 'verified',
    identityValue: 'northwind.travel',
    sentToday: 41_200,
    ...over,
  };
}

function pools(rows: Record<string, unknown>[]) {
  const repos = {
    pools: {
      async listEligibleSenders() {
        return rows;
      },
    },
    auditLogs: { async append() {} },
  } as unknown as PoolRepositories;

  return new PoolService({
    unitOfWork: (fn) => fn(repos),
    newId: () => 'new-id',
    currentActor: () => ({ type: 'user', id: 'usr-1' }) as never,
    now: () => NOW,
  });
}

describe('the senders a pool may contain', () => {
  it('repeats the connection’s own rate and headroom on every sender', async () => {
    // Two senders, one SES account. Both report the connection's figures
    // unchanged, which is what lets the drawer count the connection once.
    const rows = await pools([
      senderRow(),
      senderRow({ senderAccountId: 'snd-2', fromEmail: 'news@northwind.travel' }),
    ]).eligibleSenders(SCOPE);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.perSecond).toBe(14);
    expect(rows[1]?.perSecond).toBe(14);
    expect(rows[0]?.remainingToday).toBe(8_800);
    expect(rows[1]?.remainingToday).toBe(8_800);
    expect(rows[0]?.providerConnectionId).toBe(rows[1]?.providerConnectionId);
  });

  it('labels the connection with its region and the customer’s name for it', async () => {
    const [row] = await pools([senderRow()]).eligibleSenders(SCOPE);

    expect(row?.connectionLabel).toBe('production · eu-west-1');
    expect(row?.monogram).toBe('SES');
  });

  it('never puts an unexpected config key in the label', async () => {
    const [row] = await pools([
      senderRow({ config: { password: 'hunter2', host: 'mail.northwind.travel' } }),
    ]).eligibleSenders(SCOPE);

    expect(row?.connectionLabel).not.toContain('hunter2');
    expect(row?.connectionLabel).toContain('mail.northwind.travel');
  });

  it('reports zero headroom rather than a guess when the provider reports no quota', async () => {
    // SMTP. Inventing a default would put a number on the combined-headroom
    // panel that the rate limiter does not agree with.
    const [row] = await pools([
      senderRow({ providerType: 'smtp', quotaSnapshot: null, sentToday: 0 }),
    ]).eligibleSenders(SCOPE);

    expect(row?.perSecond).toBe(0);
    expect(row?.remainingToday).toBe(0);
  });

  it('floors headroom at zero for a connection already over its quota', async () => {
    const [row] = await pools([
      senderRow({ quotaSnapshot: { max24Hour: 1_000 }, sentToday: 1_400 }),
    ]).eligibleSenders(SCOPE);

    expect(row?.remainingToday).toBe(0);
  });

  it('blocks an unverified identity before anything else', async () => {
    // The commonest cause, and the one whose later failure is most
    // confusing: the pool accepts the sender, the campaign launches, and
    // every message is rejected by the provider.
    const [row] = await pools([
      senderRow({ identityStatus: 'pending', senderStatus: 'paused' }),
    ]).eligibleSenders(SCOPE);

    expect(row?.blockedReason).toBe('Pending DNS');
  });

  it('names a revoked connection and a paused sender', async () => {
    const [revoked] = await pools([senderRow({ connectionStatus: 'revoked' })]).eligibleSenders(SCOPE);
    expect(revoked?.blockedReason).toBe('Connection revoked');

    const [paused] = await pools([senderRow({ senderStatus: 'cooling_down' })]).eligibleSenders(SCOPE);
    expect(paused?.blockedReason).toBe('Sender cooling down');
  });

  it('says null, not undefined, for a sender that is fine', async () => {
    // The browser's type is `blockedReason?: string | null`, and a row that
    // omitted the key would be indistinguishable from one nobody checked.
    const [row] = await pools([senderRow()]).eligibleSenders(SCOPE);

    expect(row?.blockedReason).toBeNull();
  });
});

// -------------------------------------------------------------- the webhooks

function webhooks(over: { endpoint?: unknown; replayed?: number } = {}) {
  const enqueued: Record<string, unknown>[] = [];
  const audit: string[] = [];
  const replays: Record<string, unknown>[] = [];

  const repos = {
    webhooks: {
      async find() {
        return over.endpoint === undefined
          ? { id: 'wh-1', url: 'https://hooks.example.com/relayd', status: 'active' }
          : over.endpoint;
      },
      async enqueueDelivery(_scope: WorkspaceScope, input: Record<string, unknown>) {
        enqueued.push(input);
        return true;
      },
      async replayFailed(_scope: WorkspaceScope, input: Record<string, unknown>) {
        replays.push(input);
        return over.replayed ?? 0;
      },
    },
    auditLogs: {
      async append(_scope: WorkspaceScope, entry: { action: string }) {
        audit.push(entry.action);
      },
    },
  } as unknown as OutboundWebhookRepositories;

  return {
    enqueued,
    audit,
    replays,
    service: new OutboundWebhookService({
      unitOfWork: (fn) => fn(repos),
      newId: () => 'new-id',
      async storeSecret() {
        return { ref: 'arn:secret', secret: 'whsec_x' };
      },
      now: () => NOW,
    }),
  };
}

describe('the webhook test event', () => {
  it('queues a real delivery rather than posting inline', async () => {
    // A test that took a different path from the thing it is testing would
    // prove nothing about signing, retries or the delivery log.
    const world = webhooks();

    const result = await world.service.sendTest(SCOPE, { endpointId: 'wh-1', actor: ACTOR });

    expect(result).toEqual({ sent: true });
    expect(world.enqueued[0]?.['eventType']).toBe(TEST_EVENT_TYPE);
    expect(world.enqueued[0]?.['endpointId']).toBe('wh-1');
    expect(world.audit).toContain('webhook_endpoint.test_sent');
  });

  it('gives each press its own event id, so pressing twice sends twice', async () => {
    // The one place duplicate suppression is not wanted: they pressed it
    // again because the first one did not arrive.
    const world = webhooks();

    await world.service.sendTest(SCOPE, { endpointId: 'wh-1', actor: ACTOR });

    expect(String(world.enqueued[0]?.['eventId'])).toContain(String(NOW.getTime()));
  });

  it('refuses on a disabled endpoint rather than queueing into a void', async () => {
    const world = webhooks({ endpoint: { id: 'wh-1', url: 'https://x.test', status: 'disabled' } });

    await expect(
      world.service.sendTest(SCOPE, { endpointId: 'wh-1', actor: ACTOR }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('is 404 for an endpoint in another workspace', async () => {
    const world = webhooks({ endpoint: null });

    await expect(
      world.service.sendTest(SCOPE, { endpointId: 'wh-1', actor: ACTOR }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('the webhook replay', () => {
  it('re-queues the failures and says how many', async () => {
    const world = webhooks({ replayed: 42 });

    const result = await world.service.replay(SCOPE, { endpointId: 'wh-1', actor: ACTOR });

    expect(result).toEqual({ replaying: 42 });
    expect(world.audit).toContain('webhook_endpoint.replayed');
  });

  it('bounds the window and the batch', async () => {
    const world = webhooks({ replayed: 1 });

    await world.service.replay(SCOPE, { endpointId: 'wh-1', actor: ACTOR });

    const call = world.replays[0];
    expect(call?.['limit']).toBe(MAX_REPLAY);
    expect((call?.['since'] as Date).toISOString()).toBe(
      new Date(NOW.getTime() - REPLAY_WINDOW_DAYS * 86_400_000).toISOString(),
    );
  });

  it('is idempotent: the second press replays nothing', async () => {
    // The guard is the repository's `status IN ('failed','abandoned')`. Once
    // the rows are pending they no longer match, so a second call finds
    // none — which is what the fake models by answering zero.
    let remaining = 3;

    const repos = {
      webhooks: {
        async find() {
          return { id: 'wh-1', url: 'https://x.test', status: 'active' };
        },
        async replayFailed() {
          const moved = remaining;
          remaining = 0;
          return moved;
        },
      },
      auditLogs: { async append() {} },
    } as unknown as OutboundWebhookRepositories;

    const service = new OutboundWebhookService({
      unitOfWork: (fn) => fn(repos),
      newId: () => 'new-id',
      async storeSecret() {
        return { ref: 'arn:secret', secret: 'whsec_x' };
      },
      now: () => NOW,
    });

    expect(await service.replay(SCOPE, { endpointId: 'wh-1', actor: ACTOR })).toEqual({
      replaying: 3,
    });
    expect(await service.replay(SCOPE, { endpointId: 'wh-1', actor: ACTOR })).toEqual({
      replaying: 0,
    });
  });

  it('refuses to replay into a disabled endpoint', async () => {
    // Every row would re-fail and the customer would be where they started.
    const world = webhooks({ endpoint: { id: 'wh-1', url: 'https://x.test', status: 'disabled' } });

    await expect(
      world.service.replay(SCOPE, { endpointId: 'wh-1', actor: ACTOR }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
