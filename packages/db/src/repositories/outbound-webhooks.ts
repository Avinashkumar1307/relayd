import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { UserId, WorkspaceId } from '@relayd/types';
import {
  outboundWebhookDeliveries,
  outboundWebhookEndpoints,
} from '../schema/platform.js';
import type { WebhookDeliveryStatus, WebhookEndpointStatus } from '../schema/platform.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * Outbound webhook endpoints and their deliveries.
 *
 * `secret_ref` is a Secrets Manager ARN and never a secret, the same rule
 * provider credentials follow. Nothing in this file reads or returns a
 * secret; the delivery worker resolves the ARN when it needs to sign.
 *
 * Deliveries are one row per `(endpoint, event)` rather than per attempt. The
 * unique index is what makes a producer emitting the same event twice send it
 * once, and `attempt` carries the story of the retries.
 */

export interface WebhookEndpointRow {
  id: string;
  workspaceId: WorkspaceId;
  url: string;
  secretRef: string;
  previousSecretRef: string | null;
  secretRotatedAt: Date | null;
  events: string[];
  status: WebhookEndpointStatus;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  disabledAt: Date | null;
  disabledReason: string | null;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookDeliveryRow {
  id: number;
  endpointId: string;
  eventType: string;
  eventId: string;
  attempt: number;
  status: WebhookDeliveryStatus;
  responseCode: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number | null;
  scheduledFor: Date;
  deliveredAt: Date | null;
  createdAt: Date;
}

export class OutboundWebhookRepository {
  constructor(private readonly db: Executor) {}

  async create(
    scope: WorkspaceScope,
    input: {
      id: string;
      url: string;
      secretRef: string;
      events: readonly string[];
      description?: string;
      createdBy?: UserId;
    },
  ): Promise<WebhookEndpointRow> {
    const [row] = await this.db
      .insert(outboundWebhookEndpoints)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        url: input.url,
        secretRef: input.secretRef,
        events: [...input.events],
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      })
      .returning();

    if (row === undefined) throw new Error('createWebhookEndpoint: insert returned no row');
    return toEndpoint(row);
  }

  async list(scope: WorkspaceScope): Promise<WebhookEndpointRow[]> {
    const rows = await this.db
      .select()
      .from(outboundWebhookEndpoints)
      .where(eq(outboundWebhookEndpoints.workspaceId, scope.workspaceId))
      .orderBy(desc(outboundWebhookEndpoints.createdAt));

    return rows.map(toEndpoint);
  }

  async find(scope: WorkspaceScope, endpointId: string): Promise<WebhookEndpointRow | null> {
    const [row] = await this.db
      .select()
      .from(outboundWebhookEndpoints)
      .where(
        and(
          eq(outboundWebhookEndpoints.workspaceId, scope.workspaceId),
          eq(outboundWebhookEndpoints.id, endpointId),
        ),
      )
      .limit(1);

    return row === undefined ? null : toEndpoint(row);
  }

  /**
   * The endpoints one event should reach.
   *
   * Filtered in SQL rather than in the caller, because a workspace with forty
   * endpoints and one subscriber to this event type should cost one row
   * rather than forty. `&&` is the array-overlap operator, and the `{*}`
   * member is how a wildcard subscription joins in.
   */
  async subscribersFor(
    scope: WorkspaceScope,
    eventType: string,
  ): Promise<WebhookEndpointRow[]> {
    const rows = await this.db
      .select()
      .from(outboundWebhookEndpoints)
      .where(
        and(
          eq(outboundWebhookEndpoints.workspaceId, scope.workspaceId),
          inArray(outboundWebhookEndpoints.status, ['active', 'failing']),
          sql`${outboundWebhookEndpoints.events} && ARRAY[${eventType}, '*']::text[]`,
        ),
      );

    return rows.map(toEndpoint);
  }

  async update(
    scope: WorkspaceScope,
    input: {
      endpointId: string;
      url?: string;
      events?: readonly string[];
      description?: string | null;
      status?: WebhookEndpointStatus;
    },
  ): Promise<WebhookEndpointRow | null> {
    const [row] = await this.db
      .update(outboundWebhookEndpoints)
      .set({
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.events === undefined ? {} : { events: [...input.events] }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.status === undefined ? {} : { status: input.status }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outboundWebhookEndpoints.workspaceId, scope.workspaceId),
          eq(outboundWebhookEndpoints.id, input.endpointId),
        ),
      )
      .returning();

    return row === undefined ? null : toEndpoint(row);
  }

  /**
   * Rotates the signing secret, keeping the old one as `previous`.
   *
   * The overlap is what makes rotation something a customer will actually do:
   * without it every consumer breaks at the instant the new secret lands.
   */
  async rotateSecret(
    scope: WorkspaceScope,
    input: { endpointId: string; secretRef: string; at: Date },
  ): Promise<WebhookEndpointRow | null> {
    const existing = await this.find(scope, input.endpointId);
    if (existing === null) return null;

    const [row] = await this.db
      .update(outboundWebhookEndpoints)
      .set({
        secretRef: input.secretRef,
        previousSecretRef: existing.secretRef,
        secretRotatedAt: input.at,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(outboundWebhookEndpoints.workspaceId, scope.workspaceId),
          eq(outboundWebhookEndpoints.id, input.endpointId),
        ),
      )
      .returning();

    return row === undefined ? null : toEndpoint(row);
  }

  /** Records the result of an attempt, and the endpoint's new health. */
  async recordHealth(
    scope: WorkspaceScope,
    input: {
      endpointId: string;
      status: WebhookEndpointStatus;
      consecutiveFailures: number;
      succeededAt?: Date;
      failedAt?: Date;
      disabledAt?: Date;
      disabledReason?: string;
    },
  ): Promise<void> {
    await this.db
      .update(outboundWebhookEndpoints)
      .set({
        status: input.status,
        consecutiveFailures: input.consecutiveFailures,
        ...(input.succeededAt === undefined ? {} : { lastSuccessAt: input.succeededAt }),
        ...(input.failedAt === undefined ? {} : { lastFailureAt: input.failedAt }),
        ...(input.disabledAt === undefined ? {} : { disabledAt: input.disabledAt }),
        ...(input.disabledReason === undefined ? {} : { disabledReason: input.disabledReason }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outboundWebhookEndpoints.workspaceId, scope.workspaceId),
          eq(outboundWebhookEndpoints.id, input.endpointId),
        ),
      );
  }

  async remove(scope: WorkspaceScope, endpointId: string): Promise<boolean> {
    const rows = await this.db
      .delete(outboundWebhookEndpoints)
      .where(
        and(
          eq(outboundWebhookEndpoints.workspaceId, scope.workspaceId),
          eq(outboundWebhookEndpoints.id, endpointId),
        ),
      )
      .returning({ id: outboundWebhookEndpoints.id });

    return rows.length > 0;
  }

  /**
   * Queues a delivery, or reports that this event is already queued.
   *
   * `ON CONFLICT DO NOTHING` on `(endpoint_id, event_id)` — a producer that
   * emits the same event twice sends it once.
   */
  async enqueueDelivery(
    scope: WorkspaceScope,
    input: {
      endpointId: string;
      eventId: string;
      eventType: string;
      payload: unknown;
      scheduledFor: Date;
    },
  ): Promise<boolean> {
    const rows = await this.db
      .insert(outboundWebhookDeliveries)
      .values({
        workspaceId: scope.workspaceId,
        endpointId: input.endpointId,
        eventId: input.eventId,
        eventType: input.eventType,
        payload: input.payload,
        scheduledFor: input.scheduledFor,
      })
      .onConflictDoNothing()
      .returning({ id: outboundWebhookDeliveries.id });

    return rows.length > 0;
  }

  /** Deliveries due to be attempted. */
  async dueDeliveries(
    scope: WorkspaceScope,
    input: { now: Date; limit: number },
  ): Promise<WebhookDeliveryRow[]> {
    const rows = await this.db
      .select()
      .from(outboundWebhookDeliveries)
      .where(
        and(
          eq(outboundWebhookDeliveries.workspaceId, scope.workspaceId),
          eq(outboundWebhookDeliveries.status, 'pending'),
          lt(outboundWebhookDeliveries.scheduledFor, input.now),
        ),
      )
      .orderBy(outboundWebhookDeliveries.scheduledFor)
      .limit(Math.max(1, Math.trunc(input.limit)));

    return rows.map(toDelivery);
  }

  async recordAttempt(
    scope: WorkspaceScope,
    input: {
      deliveryId: number;
      createdAt: Date;
      attempt: number;
      status: WebhookDeliveryStatus;
      responseCode?: number;
      responseBody?: string;
      error?: string;
      durationMs?: number;
      scheduledFor?: Date;
      deliveredAt?: Date;
    },
  ): Promise<void> {
    await this.db
      .update(outboundWebhookDeliveries)
      .set({
        attempt: input.attempt,
        status: input.status,
        ...(input.responseCode === undefined ? {} : { responseCode: input.responseCode }),
        ...(input.responseBody === undefined ? {} : { responseBody: input.responseBody }),
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.scheduledFor === undefined ? {} : { scheduledFor: input.scheduledFor }),
        ...(input.deliveredAt === undefined ? {} : { deliveredAt: input.deliveredAt }),
      })
      .where(
        and(
          eq(outboundWebhookDeliveries.workspaceId, scope.workspaceId),
          eq(outboundWebhookDeliveries.id, input.deliveryId),
          // The partition key. Without it Postgres scans every partition to
          // find one row.
          eq(outboundWebhookDeliveries.createdAt, input.createdAt),
        ),
      );
  }

  /**
   * Re-queues this endpoint's failed deliveries (J4c).
   *
   * **It cannot double-deliver, and that is structural rather than
   * careful.** The guard is the `status IN ('failed','abandoned')` predicate
   * on the UPDATE itself: a `delivered` row is never matched, so a replay can
   * never re-send something that arrived, and a `pending` row is never
   * matched either, so a replay cannot queue a second attempt at something
   * already in flight. Running it twice in a row therefore moves rows the
   * first time and zero rows the second — the guarded-update idiom CLAUDE.md
   * section 9 asks for, with `RETURNING` as the count.
   *
   * `attempt` is deliberately not reset. The delivery worker's backoff reads
   * it, and zeroing it would give an endpoint that has already failed nine
   * times a fresh set of nine retries every time somebody clicked the button.
   * `scheduled_for` moves to now, which is what "replay" means.
   *
   * `created_at >= since` is the partition pruner. Without it this UPDATE
   * visits every partition of `outbound_webhook_deliveries` to find rows that
   * can only be in the recent ones.
   */
  async replayFailed(
    scope: WorkspaceScope,
    input: { endpointId: string; since: Date; now: Date; limit: number },
  ): Promise<number> {
    const limit = Math.min(10_000, Math.max(1, Math.trunc(input.limit)));

    const { rows } = await this.db.execute<{ id: string }>(sql`
      UPDATE outbound_webhook_deliveries
         SET status = 'pending',
             scheduled_for = ${input.now},
             error = NULL
       WHERE (workspace_id, endpoint_id, created_at, id) IN (
               SELECT workspace_id, endpoint_id, created_at, id
                 FROM outbound_webhook_deliveries
                WHERE workspace_id = ${scope.workspaceId}
                  AND endpoint_id = ${input.endpointId}
                  AND created_at >= ${input.since}
                  AND status IN ('failed', 'abandoned')
                ORDER BY created_at
                LIMIT ${limit}
             )
   RETURNING id
    `);

    return rows.length;
  }

  /**
   * How much a replay would re-send, and how far back it could reach.
   *
   * Read separately from the replay itself so J4c can print the number on the
   * button before anybody presses it.
   */
  async countReplayable(
    scope: WorkspaceScope,
    input: { endpointId: string; since: Date },
  ): Promise<number> {
    const { rows } = await this.db.execute<{ undelivered: number }>(sql`
      SELECT count(*)::int AS "undelivered"
        FROM outbound_webhook_deliveries
       WHERE workspace_id = ${scope.workspaceId}
         AND endpoint_id = ${input.endpointId}
         AND created_at >= ${input.since}
         AND status IN ('failed', 'abandoned')
    `);

    return rows[0]?.undelivered ?? 0;
  }

  /** The delivery log an integrator reads when an event did not arrive. */
  async listDeliveries(
    scope: WorkspaceScope,
    input: { endpointId: string; limit: number },
  ): Promise<WebhookDeliveryRow[]> {
    const rows = await this.db
      .select()
      .from(outboundWebhookDeliveries)
      .where(
        and(
          eq(outboundWebhookDeliveries.workspaceId, scope.workspaceId),
          eq(outboundWebhookDeliveries.endpointId, input.endpointId),
        ),
      )
      .orderBy(desc(outboundWebhookDeliveries.createdAt))
      .limit(Math.max(1, Math.trunc(input.limit)));

    return rows.map(toDelivery);
  }
}

function toEndpoint(row: typeof outboundWebhookEndpoints.$inferSelect): WebhookEndpointRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    url: row.url,
    secretRef: row.secretRef,
    previousSecretRef: row.previousSecretRef,
    secretRotatedAt: row.secretRotatedAt,
    events: row.events,
    status: row.status,
    consecutiveFailures: row.consecutiveFailures,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    disabledAt: row.disabledAt,
    disabledReason: row.disabledReason,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDelivery(row: typeof outboundWebhookDeliveries.$inferSelect): WebhookDeliveryRow {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventType: row.eventType,
    eventId: row.eventId,
    attempt: row.attempt,
    status: row.status,
    responseCode: row.responseCode,
    responseBody: row.responseBody,
    error: row.error,
    durationMs: row.durationMs,
    scheduledFor: row.scheduledFor,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
  };
}
