import type { ProviderConnectionId, WorkspaceId } from '@relayd/types';
import type {
  EmailProviderAdapter,
  ProviderCredentials,
  ProviderType,
} from '@relayd/email-providers';

/**
 * provider-verify.
 *
 * Re-checks each of a workspace's provider connections against the provider
 * and records what it found. Without it a revoked SES key or an expired
 * SendGrid key is discovered at launch, by a campaign, in front of a customer.
 *
 * Deliberately per-workspace, not cross-tenant. The scheduler enumerates
 * workspaces and enqueues one of these per workspace, so this job runs as
 * `relayd_app` under RLS with `app.workspace_id` set from its payload, and
 * needs no entry in the `relayd_global` allowlist (INVARIANTS R20). Enumerating
 * workspaces is the scheduler's job and the scheduler already connects
 * directly.
 *
 * The queue that carries it, with its explicit settings, is declared in Phase
 * 5. This is the handler, which is the part that can be wrong.
 */

export interface ConnectionToVerify {
  id: ProviderConnectionId;
  providerType: ProviderType;
  status: string;
  credentialVersion: number;
}

export interface ProviderVerifyPort {
  /** Connections in this workspace worth checking. */
  listVerifiable(): Promise<ConnectionToVerify[]>;

  /**
   * The credential for one connection, from the secret store.
   *
   * Null when the secret is gone — which is itself a finding, not an error:
   * a connection pointing at a deleted secret can never send again and the
   * owner needs to know.
   */
  credentialsFor(id: ProviderConnectionId): Promise<ProviderCredentials | null>;

  recordVerification(
    id: ProviderConnectionId,
    result:
      | { ok: true; status: 'active'; capabilities?: Record<string, unknown> }
      | { ok: false; status: 'error' | 'degraded'; error: Record<string, unknown> },
  ): Promise<boolean>;

  recordQuota(id: ProviderConnectionId, snapshot: Record<string, unknown>): Promise<void>;

  /** Called when a connection stops being usable, so the owner hears about it. */
  notifyOwner?(input: {
    connectionId: ProviderConnectionId;
    reason: string;
  }): Promise<void>;
}

export interface ProviderVerifyDeps {
  workspaceId: WorkspaceId;
  port: ProviderVerifyPort;
  adapterFor: (type: ProviderType) => EmailProviderAdapter | null;
  now?: () => Date;
}

export interface ProviderVerifySummary {
  checked: number;
  healthy: number;
  failed: number;
  skipped: number;
}

/**
 * Statuses worth re-checking.
 *
 * A revoked or disabled connection is not re-checked: the owner turned it off,
 * and re-verifying it would either fail forever or quietly bring it back.
 */
const VERIFIABLE = new Set(['pending', 'verifying', 'active', 'degraded', 'error']);

export async function runProviderVerify(
  deps: ProviderVerifyDeps,
): Promise<ProviderVerifySummary> {
  const summary: ProviderVerifySummary = { checked: 0, healthy: 0, failed: 0, skipped: 0 };

  for (const connection of await deps.port.listVerifiable()) {
    if (!VERIFIABLE.has(connection.status)) {
      summary.skipped += 1;
      continue;
    }

    const adapter = deps.adapterFor(connection.providerType);
    if (adapter === null) {
      summary.skipped += 1;
      continue;
    }

    summary.checked += 1;

    const credentials = await deps.port.credentialsFor(connection.id);
    if (credentials === null) {
      // The secret is gone. The connection can never send again, and saying
      // so is more useful than a verification that cannot be attempted.
      summary.failed += 1;
      await deps.port.recordVerification(connection.id, {
        ok: false,
        status: 'error',
        error: { kind: 'auth_failed', message: 'The stored credential could not be read' },
      });
      await deps.port.notifyOwner?.({
        connectionId: connection.id,
        reason: 'The stored credential could not be read',
      });
      continue;
    }

    const result = await adapter.verifyConnection(credentials);

    if (result.ok) {
      summary.healthy += 1;
      await deps.port.recordVerification(connection.id, {
        ok: true,
        status: 'active',
        capabilities: { ...adapter.capabilities },
      });

      // Advisory. A provider that will not report its quota must not turn a
      // successful verification into a failed one.
      if (adapter.capabilities.reportsQuota) {
        const quota = await adapter.getQuota(credentials).catch(() => null);
        if (quota !== null) {
          await deps.port.recordQuota(connection.id, {
            max24Hour: quota.max24Hour,
            sentLast24Hours: quota.sentLast24Hours,
            maxSendRate: quota.maxSendRate,
            checkedAt: quota.checkedAt.toISOString(),
          });
        }
      }

      continue;
    }

    summary.failed += 1;

    /**
     * An auth failure is the connection's problem; anything else may be the
     * provider having a bad minute.
     *
     * Marking a transient outage as `error` would disable a working
     * connection and need a human to turn it back on, which is a worse
     * outcome than a campaign retrying.
     */
    const permanent = result.error?.kind === 'auth_failed' || result.error?.kind === 'invalid_sender';

    await deps.port.recordVerification(connection.id, {
      ok: false,
      status: permanent ? 'error' : 'degraded',
      // The typed error, already scrubbed at the adapter boundary (R22).
      error: { kind: result.error?.kind ?? 'unknown', message: result.error?.message ?? '' },
    });

    if (permanent) {
      // Only for a permanent failure. Paging an owner every time a provider
      // has a slow minute is how alerts get muted.
      await deps.port.notifyOwner?.({
        connectionId: connection.id,
        reason: result.error?.message ?? 'The provider rejected these credentials',
      });
    }
  }

  return summary;
}

/**
 * The schedule, declared but not yet installed.
 *
 * Phase 5 creates `scheduled_jobs` and the scheduler that reads it; this is
 * the row it will carry. Recurring work is driven from that table by the
 * scheduler process — BullMQ repeatable jobs are not used (CLAUDE.md §9),
 * because a repeatable job lives in Redis and Redis is transport.
 */
export const PROVIDER_VERIFY_SCHEDULE = {
  name: 'provider-verify',
  /** Hourly. A revoked credential should not go unnoticed for a day. */
  cron: '17 * * * *',
  /** One job per workspace, so each runs scoped under RLS (R20). */
  fanOut: 'per-workspace',
  timezone: 'UTC',
} as const;
