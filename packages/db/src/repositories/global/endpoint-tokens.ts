import { eq } from 'drizzle-orm';
import type { ProviderConnectionId, WorkspaceId } from '@relayd/types';
import { providerConnections } from '../../schema/providers.js';
import type { ConnectionStatus, ProviderType } from '../../schema/providers.js';
import type { Executor } from '../executor.js';

/**
 * CROSS-TENANT BY NECESSITY.
 *
 * Resolving an inbound webhook's endpoint token is the query that *decides*
 * which workspace an event belongs to, so it cannot be scoped to one — there
 * is no workspace until it returns. It is the provider-ingest twin of the
 * membership lookup that decides 404 versus proceed.
 *
 * Narrow on purpose. It returns what the ingest route needs to verify a
 * signature and attribute an event, and nothing else: no credential ARN, no
 * workspace content, no counts. A token that resolves tells its bearer only
 * that it is valid, which they already knew.
 */

export interface EndpointResolution {
  connectionId: ProviderConnectionId;
  workspaceId: WorkspaceId;
  providerType: ProviderType;
  status: ConnectionStatus;
  /** The ARN of this connection's webhook secret. Not the secret. */
  webhookSecretArn: string | null;
}

/** Statuses that still accept inbound events. */
const ACCEPTING: readonly ConnectionStatus[] = ['pending', 'verifying', 'active', 'degraded'];

export class GlobalEndpointTokenRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Resolves a token to exactly one connection.
   *
   * The unique index on `endpoint_token` is what makes "exactly one" true, and
   * it is global rather than per workspace for that reason: a token is
   * resolved before any workspace is known, so a collision between two
   * workspaces would attribute an event to the wrong tenant — precisely the
   * attack F4 describes.
   */
  async resolve(token: string): Promise<EndpointResolution | null> {
    // Bounded before the query. A token is a fixed shape, and a 10 KB path
    // segment should cost a length check rather than an index probe.
    if (token.length < 32 || token.length > 128) return null;

    const [row] = await this.db
      .select({
        connectionId: providerConnections.id,
        workspaceId: providerConnections.workspaceId,
        providerType: providerConnections.providerType,
        status: providerConnections.status,
        webhookSecretArn: providerConnections.webhookSecretArn,
      })
      .from(providerConnections)
      .where(eq(providerConnections.endpointToken, token))
      .limit(1);

    return row ?? null;
  }

  /**
   * Whether a resolved connection should still accept events.
   *
   * Separate from `resolve` so the ingest route decides, and so a disabled
   * connection is distinguishable from an unknown token in logs while staying
   * indistinguishable in the response.
   */
  static isAccepting(status: ConnectionStatus): boolean {
    return ACCEPTING.includes(status);
  }
}
