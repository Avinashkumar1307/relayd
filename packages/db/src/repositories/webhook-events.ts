import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { ProviderConnectionId, WorkspaceId } from '@relayd/types';
import { providerWebhookEvents } from '../schema/providers.js';
import type { ProviderType } from '../schema/providers.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * The inbound webhook inbox (INVARIANTS R4).
 *
 * Events land here verified but unapplied. Nothing in this file marks an event
 * matched — that is the events worker's job, and it does it scoped to
 * `(workspace_id, provider_connection_id)`. An event that matches nothing
 * stays here as evidence.
 */

export interface WebhookEventRow {
  id: bigint;
  workspaceId: WorkspaceId;
  providerConnectionId: ProviderConnectionId;
  providerType: ProviderType;
  dedupeKey: string;
  matched: boolean;
  eventType: string | null;
  providerMessageId: string | null;
  recipientEmail: string | null;
  occurredAt: Date | null;
  payload: unknown;
  receivedAt: Date;
  processedAt: Date | null;
  processError: string | null;
}

export class WebhookEventRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Stores one event, idempotently.
   *
   * Returns false when the dedupe key was already present for this
   * connection. That is the expected case, not an error: every provider
   * redelivers, and several redeliver aggressively. The unique index on
   * `(provider_connection_id, dedupe_key)` is the whole guarantee; this is
   * just the statement that leans on it.
   */
  async store(
    scope: WorkspaceScope,
    input: {
      providerConnectionId: ProviderConnectionId;
      providerType: ProviderType;
      dedupeKey: string;
      eventType?: string;
      providerMessageId?: string;
      recipientEmail?: string;
      occurredAt?: Date;
      payload: unknown;
    },
  ): Promise<boolean> {
    const rows = await this.db
      .insert(providerWebhookEvents)
      .values({
        workspaceId: scope.workspaceId,
        providerConnectionId: input.providerConnectionId,
        providerType: input.providerType,
        dedupeKey: input.dedupeKey,
        payload: input.payload,
        ...(input.eventType === undefined ? {} : { eventType: input.eventType }),
        ...(input.providerMessageId === undefined
          ? {}
          : { providerMessageId: input.providerMessageId }),
        ...(input.recipientEmail === undefined ? {} : { recipientEmail: input.recipientEmail }),
        ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      })
      .onConflictDoNothing({
        target: [providerWebhookEvents.providerConnectionId, providerWebhookEvents.dedupeKey],
      })
      .returning({ id: providerWebhookEvents.id });

    return rows.length > 0;
  }

  /**
   * Claims a page of unprocessed events for interpretation.
   *
   * FOR UPDATE SKIP LOCKED so two workers on the same workspace take
   * different rows rather than one waiting on the other (CLAUDE.md §12: never
   * a Redis lock; a guarded read is the first preference).
   */
  async claimUnprocessed(scope: WorkspaceScope, limit = 100): Promise<WebhookEventRow[]> {
    const rows = await this.db
      .select()
      .from(providerWebhookEvents)
      .where(
        and(
          eq(providerWebhookEvents.workspaceId, scope.workspaceId),
          isNull(providerWebhookEvents.processedAt),
        ),
      )
      .orderBy(asc(providerWebhookEvents.receivedAt))
      .limit(limit)
      .for('update', { skipLocked: true });

    return rows.map(toRow);
  }

  /**
   * Marks an event processed.
   *
   * `matched` is set here and only here, by the worker that resolved the
   * event to a recipient inside this workspace and this connection. The
   * ingest route never sets it.
   */
  async markProcessed(
    scope: WorkspaceScope,
    id: bigint,
    result: { matched: boolean; error?: string },
  ): Promise<void> {
    await this.db
      .update(providerWebhookEvents)
      .set({
        processedAt: new Date(),
        matched: result.matched,
        ...(result.error === undefined ? {} : { processError: result.error.slice(0, 500) }),
      })
      .where(
        and(
          eq(providerWebhookEvents.id, id),
          eq(providerWebhookEvents.workspaceId, scope.workspaceId),
        ),
      );
  }

  /**
   * How many recent events matched nothing.
   *
   * R4 requires an unmatched-rate alarm. A rising rate means either a
   * misconfigured connection or somebody posting events that do not belong to
   * this workspace, and both are worth waking someone for.
   */
  async unmatchedRate(
    scope: WorkspaceScope,
    since: Date,
  ): Promise<{ total: number; unmatched: number }> {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        unmatched: sql<number>`count(*) FILTER (WHERE NOT ${providerWebhookEvents.matched})::int`,
      })
      .from(providerWebhookEvents)
      .where(
        and(
          eq(providerWebhookEvents.workspaceId, scope.workspaceId),
          sql`${providerWebhookEvents.processedAt} >= ${since}`,
        ),
      );

    return { total: row?.total ?? 0, unmatched: row?.unmatched ?? 0 };
  }

  async listUnmatched(scope: WorkspaceScope, limit = 50): Promise<WebhookEventRow[]> {
    const rows = await this.db
      .select()
      .from(providerWebhookEvents)
      .where(
        and(
          eq(providerWebhookEvents.workspaceId, scope.workspaceId),
          eq(providerWebhookEvents.matched, false),
        ),
      )
      .orderBy(asc(providerWebhookEvents.receivedAt))
      .limit(limit);

    return rows.map(toRow);
  }
}

function toRow(row: typeof providerWebhookEvents.$inferSelect): WebhookEventRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    providerConnectionId: row.providerConnectionId,
    providerType: row.providerType,
    dedupeKey: row.dedupeKey,
    matched: row.matched,
    eventType: row.eventType,
    providerMessageId: row.providerMessageId,
    recipientEmail: row.recipientEmail,
    occurredAt: row.occurredAt,
    payload: row.payload,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
    processError: row.processError,
  };
}
