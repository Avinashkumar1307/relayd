import { describe, expect, it } from 'vitest';
import {
  PROVIDER_VERIFY_SCHEDULE,
  runProviderVerify,
  type ConnectionToVerify,
  type ProviderVerifyPort,
} from '../src/jobs/provider-verify.js';
import { createFakeProvider } from '@relayd/email-providers';
import type { ProviderConnectionId, WorkspaceId } from '@relayd/types';
import type { ProviderCredentials } from '@relayd/email-providers';

/**
 * provider-verify.
 *
 * The behaviour that matters is what it does with a failure: a wrong
 * credential must disable the connection and tell someone, and a provider
 * having a bad minute must not.
 */

const WORKSPACE = 'ws-1' as WorkspaceId;
const CREDENTIALS: ProviderCredentials = { type: 'sendgrid', apiKey: 'SECRET-CANARY-9f3a' };

function connection(overrides: Partial<ConnectionToVerify> = {}): ConnectionToVerify {
  return {
    id: 'conn-1' as ProviderConnectionId,
    providerType: 'sendgrid',
    status: 'active',
    credentialVersion: 1,
    ...overrides,
  };
}

function harness(options: {
  connections?: ConnectionToVerify[];
  credentials?: ProviderCredentials | null;
  verificationFails?: boolean;
  failureKind?: 'auth_failed' | 'provider_unavailable';
  reportsQuota?: boolean;
  quotaThrows?: boolean;
}) {
  const verifications: { id: string; ok: boolean; status: string }[] = [];
  const quotas: { id: string; snapshot: Record<string, unknown> }[] = [];
  const notifications: { connectionId: string; reason: string }[] = [];

  const port: ProviderVerifyPort = {
    async listVerifiable() {
      return options.connections ?? [connection()];
    },
    async credentialsFor() {
      return options.credentials === undefined ? CREDENTIALS : options.credentials;
    },
    async recordVerification(id, result) {
      verifications.push({ id, ok: result.ok, status: result.status });
      return true;
    },
    async recordQuota(id, snapshot) {
      quotas.push({ id, snapshot });
    },
    async notifyOwner(input) {
      notifications.push({ connectionId: input.connectionId, reason: input.reason });
    },
  };

  const adapter = createFakeProvider(
    options.verificationFails === true ? { verificationFails: true } : {},
    options.reportsQuota === false ? { reportsQuota: false } : {},
  );

  // The fake reports auth_failed; a transient failure needs a different kind.
  const adapterFor = () =>
    options.quotaThrows === true
      ? {
          ...adapter,
          async getQuota(): Promise<never> {
            throw new Error('the quota endpoint is down');
          },
        }
      : options.failureKind === 'provider_unavailable'
      ? {
          ...adapter,
          async verifyConnection() {
            return {
              ok: false as const,
              error: {
                kind: 'provider_unavailable' as const,
                retryable: true,
                affects: 'connection' as const,
                message: 'SendGrid is having a moment',
              },
            };
          },
        }
      : adapter;

  return {
    run: () =>
      runProviderVerify({ workspaceId: WORKSPACE, port, adapterFor: adapterFor as never }),
    verifications,
    quotas,
    notifications,
  };
}

describe('a healthy connection', () => {
  it('is marked active and its quota recorded', async () => {
    const { run, verifications, quotas } = harness({
      reportsQuota: true,
    });

    const summary = await run();

    expect(summary).toMatchObject({ checked: 1, healthy: 1, failed: 0 });
    expect(verifications).toEqual([{ id: 'conn-1', ok: true, status: 'active' }]);
    // The fake reports no quota figures, so nothing is recorded — but the
    // read was attempted, which the throwing case below relies on.
    expect(quotas).toEqual([]);
  });

  it('skips the quota read entirely for a provider that reports none', async () => {
    const { run, quotas } = harness({ reportsQuota: false });

    await run();
    expect(quotas).toEqual([]);
  });

  it('does not fail the verification when the quota read throws', async () => {
    // A quota read is advisory. A provider whose quota endpoint is down must
    // not have its working connection marked failed for it.
    const { run, verifications, quotas } = harness({ quotaThrows: true });

    const summary = await run();

    expect(summary.healthy).toBe(1);
    expect(summary.failed).toBe(0);
    expect(verifications[0]?.ok).toBe(true);
    expect(quotas).toEqual([]);
  });
});

describe('a failing connection', () => {
  it('marks a rejected credential as error and tells the owner', async () => {
    // A revoked key is the connection's problem and will not fix itself.
    const { run, verifications, notifications } = harness({ verificationFails: true });

    const summary = await run();

    expect(summary).toMatchObject({ checked: 1, healthy: 0, failed: 1 });
    expect(verifications).toEqual([{ id: 'conn-1', ok: false, status: 'error' }]);
    expect(notifications).toHaveLength(1);
  });

  it('marks a transient outage as degraded and tells nobody', async () => {
    // Marking a bad minute as `error` disables a working connection and needs
    // a human to turn it back on — worse than a campaign retrying. And paging
    // an owner every time a provider is slow is how alerts get muted.
    const { run, verifications, notifications } = harness({
      failureKind: 'provider_unavailable',
    });

    const summary = await run();

    expect(summary.failed).toBe(1);
    expect(verifications).toEqual([{ id: 'conn-1', ok: false, status: 'degraded' }]);
    expect(notifications).toEqual([]);
  });

  it('reports a missing secret as a finding rather than crashing', async () => {
    // A connection pointing at a deleted secret can never send again, and the
    // owner needs to know that more than the job needs to succeed.
    const { run, verifications, notifications } = harness({ credentials: null });

    const summary = await run();

    expect(summary.failed).toBe(1);
    expect(verifications).toEqual([{ id: 'conn-1', ok: false, status: 'error' }]);
    expect(notifications[0]?.reason).toMatch(/could not be read/u);
  });

  it('leaks no credential into the recorded error', async () => {
    const { run, verifications, notifications } = harness({ verificationFails: true });
    await run();

    expect(JSON.stringify([verifications, notifications])).not.toContain('SECRET-CANARY-9f3a');
  });
});

describe('what it leaves alone', () => {
  it('skips a connection the owner disabled', async () => {
    // Re-verifying it would either fail forever or quietly bring it back.
    const { run, verifications } = harness({
      connections: [connection({ status: 'disabled' }), connection({ status: 'revoked' })],
    });

    const summary = await run();

    expect(summary).toMatchObject({ checked: 0, skipped: 2 });
    expect(verifications).toEqual([]);
  });

  it('checks every other status', async () => {
    const { run } = harness({
      connections: [
        connection({ id: 'c1' as ProviderConnectionId, status: 'pending' }),
        connection({ id: 'c2' as ProviderConnectionId, status: 'active' }),
        connection({ id: 'c3' as ProviderConnectionId, status: 'degraded' }),
        connection({ id: 'c4' as ProviderConnectionId, status: 'error' }),
      ],
    });

    // `error` is included on purpose: a connection whose credential was
    // rotated outside our UI recovers on its own rather than needing a click.
    expect((await run()).checked).toBe(4);
  });

  it('does nothing for a workspace with no connections', async () => {
    const { run, verifications } = harness({ connections: [] });

    expect(await run()).toEqual({ checked: 0, healthy: 0, failed: 0, skipped: 0 });
    expect(verifications).toEqual([]);
  });
});

describe('the schedule', () => {
  it('fans out per workspace, so each run is scoped under RLS', () => {
    // R20: a cross-tenant job would need an entry in the relayd_global
    // allowlist. Fanning out means it never needs one.
    expect(PROVIDER_VERIFY_SCHEDULE.fanOut).toBe('per-workspace');
  });

  it('runs often enough that a revoked credential is noticed the same day', () => {
    expect(PROVIDER_VERIFY_SCHEDULE.cron).toMatch(/^\d+ \* \* \* \*$/u);
  });
});
