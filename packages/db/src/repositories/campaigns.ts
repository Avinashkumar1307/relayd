import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { CampaignId, RecipientId, UserId, WorkspaceId } from '@relayd/types';
import { campaignCounters, campaignEvents, campaignRecipients, campaigns } from '../schema/campaigns.js';
import { users } from '../schema/identity.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * Campaigns: reads, writes and the counter row.
 *
 * The engine's own statements — the guarded claim, the snapshot, the lattice
 * — live in `campaign-engine.ts` next door, because they are a different kind
 * of thing: each one is a single carefully shaped statement whose `WHERE`
 * clause *is* an invariant, and mixing them in with ordinary CRUD is how one
 * of them eventually gets "simplified".
 *
 * Two rules hold throughout this file.
 *
 * **Nothing here aggregates over `campaign_recipients`** (R13). Progress comes
 * from `campaign_counters`, a single row. A `GROUP BY` over the recipients of
 * a 500k campaign is a sequential scan competing with the dispatcher's own
 * writes, and three people watching a dashboard would run one every 1.7
 * seconds.
 *
 * **Every method takes `WorkspaceScope` first** (CLAUDE.md §6.2) and every
 * statement filters on it, even where RLS would too. The scope is the guard a
 * reader can see; RLS is the one that holds when this file is wrong.
 */

export interface CampaignRow {
  id: CampaignId;
  workspaceId: WorkspaceId;
  name: string;
  status: string;
  templateVersionId: string | null;
  senderAccountId: string | null;
  sendingPoolId: string | null;
  audience: unknown;
  subjectOverride: string | null;
  throttlePerHour: number | null;
  scheduledAt: Date | null;
  timezone: string | null;
  recipientCount: number;
  launchedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * G1's Archive action (migration 0021).
   *
   * The timestamp rather than a boolean, unlike `TemplateRow.archived`: a
   * campaign report is a record of what happened and when, and "filed away
   * on 3 October" belongs in it. A template has no report.
   */
  archivedAt: Date | null;
}

/**
 * One row of G3's event timeline, as `campaign_events` stores it plus the
 * name of whoever caused it.
 *
 * `actorName` is resolved by a join here rather than by a second query in
 * the service, because a timeline of forty entries would otherwise be forty
 * round trips to `users` to render forty names.
 */
export interface CampaignEventRow {
  id: string;
  eventType: string;
  actorType: 'user' | 'api_key' | 'system' | 'provider';
  actorId: string | null;
  actorName: string | null;
  detail: unknown;
  createdAt: Date;
}

export interface CampaignCountersRow {
  campaignId: CampaignId;
  total: number;
  pending: number;
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  suppressed: number;
  uncertain: number;
  updatedAt: Date;
}

export interface RecipientRow {
  id: RecipientId;
  email: string;
  state: string;
  deliveryState: string | null;
  attemptCount: number;
  errorCode: string | null;
  providerMessageId: string | null;
  sentAt: Date | null;
  terminalAt: Date | null;
}

/** Campaign statuses a draft edit or a delete is still allowed from. */
const EDITABLE_STATUSES = ['draft', 'scheduled'];

/**
 * Campaign statuses that can be archived: the terminal ones, all of them.
 *
 * The design's row menu offers Archive on `completed`, `cancelled` and
 * `failed` and not on `completed_with_errors`, whose menu is full with
 * "Retry failed". That is a menu decision, not a rule — a campaign that
 * finished with some bounces is as over as one that did not, and a server
 * that refused it would leave the customer with one campaign they can never
 * get off the list. So the server allows the whole terminal set and the UI
 * offers what the frame draws.
 */
const ARCHIVABLE_STATUSES = [
  'completed',
  'completed_with_errors',
  'cancelled',
  'failed',
];

export class CampaignRepository {
  constructor(private readonly db: Executor) {}

  async list(
    scope: WorkspaceScope,
    query: {
      state?: string | undefined;
      search?: string | undefined;
      /** Default `active`: archiving is how G1 gets a campaign off the list. */
      archived?: 'active' | 'archived' | 'all' | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ): Promise<{ items: CampaignRow[]; nextCursor: string | null }> {
    const conditions = [
      eq(campaigns.workspaceId, scope.workspaceId),
      isNull(campaigns.deletedAt),
    ];

    // Archived campaigns are hidden unless asked for. A row the customer
    // filed away reappearing at the top of Completed next week is the whole
    // reason the action exists.
    if (query.archived === 'archived') conditions.push(isNotNull(campaigns.archivedAt));
    else if (query.archived !== 'all') conditions.push(isNull(campaigns.archivedAt));

    if (query.state !== undefined) conditions.push(eq(campaigns.status, query.state as never));
    if (query.search !== undefined) conditions.push(ilike(campaigns.name, `%${query.search}%`));

    // Keyset, not OFFSET. A workspace with 40,000 campaigns paging to the end
    // with OFFSET reads every row it skips.
    if (query.cursor !== undefined) {
      const at = new Date(query.cursor);
      if (!Number.isNaN(at.getTime())) conditions.push(lt(campaigns.createdAt, at));
    }

    const rows = await this.db
      .select()
      .from(campaigns)
      .where(and(...conditions))
      .orderBy(desc(campaigns.createdAt))
      // One extra, to know whether there is another page without counting.
      .limit(query.limit + 1);

    const items = rows.slice(0, query.limit).map(toCampaign);
    const nextCursor =
      rows.length > query.limit ? (items.at(-1)?.createdAt.toISOString() ?? null) : null;

    return { items, nextCursor };
  }

  async findById(scope: WorkspaceScope, id: CampaignId): Promise<CampaignRow | null> {
    const [row] = await this.db
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.id, id),
          eq(campaigns.workspaceId, scope.workspaceId),
          isNull(campaigns.deletedAt),
        ),
      )
      .limit(1);

    return row === undefined ? null : toCampaign(row);
  }

  /** R13: the single-row read that every progress poll uses. */
  async readCounters(scope: WorkspaceScope, id: CampaignId): Promise<CampaignCountersRow | null> {
    const [row] = await this.db
      .select()
      .from(campaignCounters)
      .where(
        and(eq(campaignCounters.campaignId, id), eq(campaignCounters.workspaceId, scope.workspaceId)),
      )
      .limit(1);

    return row === undefined ? null : toCounters(row);
  }

  async listRecipients(
    scope: WorkspaceScope,
    id: CampaignId,
    query: {
      state?: string | undefined;
      deliveryState?: string | undefined;
      search?: string | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ): Promise<{ items: RecipientRow[]; nextCursor: string | null }> {
    const conditions = [
      eq(campaignRecipients.workspaceId, scope.workspaceId),
      eq(campaignRecipients.campaignId, id),
    ];

    if (query.state !== undefined) {
      conditions.push(eq(campaignRecipients.state, query.state as never));
    }
    if (query.deliveryState !== undefined) {
      conditions.push(eq(campaignRecipients.deliveryState, query.deliveryState as never));
    }
    if (query.search !== undefined) {
      conditions.push(ilike(campaignRecipients.email, `%${query.search}%`));
    }
    if (query.cursor !== undefined) {
      // Ordered by id, which is UUIDv7 and therefore time-ordered. A cursor
      // on `id` needs no second column to break ties.
      conditions.push(sql`${campaignRecipients.id} > ${query.cursor}`);
    }

    const rows = await this.db
      .select()
      .from(campaignRecipients)
      .where(and(...conditions))
      .orderBy(asc(campaignRecipients.id))
      .limit(query.limit + 1);

    const items = rows.slice(0, query.limit).map(toRecipient);
    const nextCursor = rows.length > query.limit ? (items.at(-1)?.id ?? null) : null;

    return { items, nextCursor };
  }

  async create(
    scope: WorkspaceScope,
    input: {
      id: CampaignId;
      name: string;
      subject?: string;
      templateId?: string;
      senderAccountId?: string;
      sendingPoolId?: string;
      audience?: unknown;
      createdBy?: UserId;
    },
  ): Promise<CampaignRow> {
    const [row] = await this.db
      .insert(campaigns)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        name: input.name,
        ...(input.subject === undefined ? {} : { subjectOverride: input.subject }),
        ...(input.senderAccountId === undefined
          ? {}
          : { senderAccountId: input.senderAccountId as never }),
        ...(input.sendingPoolId === undefined
          ? {}
          : { sendingPoolId: input.sendingPoolId as never }),
        ...(input.audience === undefined ? {} : { audience: input.audience }),
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      })
      .returning();

    if (row === undefined) throw new Error('createCampaign: insert returned no row');

    // The counter row exists from creation, so `progress` never has to answer
    // "no counters yet" differently from "no campaign".
    await this.db.insert(campaignCounters).values({
      campaignId: input.id,
      workspaceId: scope.workspaceId,
    });

    return toCampaign(row);
  }

  /**
   * Edits a draft.
   *
   * Guarded on status rather than checked first: between a read and a write,
   * another request can launch the campaign, and editing the subject of a
   * campaign that is already sending changes what the report claims was sent.
   */
  async update(
    scope: WorkspaceScope,
    id: CampaignId,
    input: Record<string, unknown>,
  ): Promise<CampaignRow | null> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };

    if (typeof input['name'] === 'string') patch['name'] = input['name'];
    if (typeof input['subject'] === 'string') patch['subjectOverride'] = input['subject'];
    if (typeof input['senderAccountId'] === 'string') {
      patch['senderAccountId'] = input['senderAccountId'];
    }
    if (typeof input['sendingPoolId'] === 'string') {
      patch['sendingPoolId'] = input['sendingPoolId'];
    }
    if (input['audience'] !== undefined) patch['audience'] = input['audience'];

    const [row] = await this.db
      .update(campaigns)
      .set(patch)
      .where(
        and(
          eq(campaigns.id, id),
          eq(campaigns.workspaceId, scope.workspaceId),
          isNull(campaigns.deletedAt),
          inArray(campaigns.status, EDITABLE_STATUSES as never[]),
        ),
      )
      .returning();

    return row === undefined ? null : toCampaign(row);
  }

  /**
   * Soft delete, guarded the same way.
   *
   * Soft, because deleting a launched campaign would delete the record of
   * what was sent to whom — which is the one thing a customer may be legally
   * required to produce. The guard stops it happening at all; the soft delete
   * means even a future guard bug is recoverable.
   */
  async remove(scope: WorkspaceScope, id: CampaignId): Promise<boolean> {
    const rows = await this.db
      .update(campaigns)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(campaigns.id, id),
          eq(campaigns.workspaceId, scope.workspaceId),
          isNull(campaigns.deletedAt),
          inArray(campaigns.status, EDITABLE_STATUSES as never[]),
        ),
      )
      .returning({ id: campaigns.id });

    return rows.length > 0;
  }

  /** Guarded `draft -> scheduled`. Zero rows means it was not a draft. */
  async schedule(
    scope: WorkspaceScope,
    id: CampaignId,
    input: { scheduledAt: Date; timezone: string },
  ): Promise<CampaignRow | null> {
    const [row] = await this.db
      .update(campaigns)
      .set({
        status: 'scheduled' as never,
        scheduledAt: input.scheduledAt,
        timezone: input.timezone,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(campaigns.id, id),
          eq(campaigns.workspaceId, scope.workspaceId),
          isNull(campaigns.deletedAt),
          inArray(campaigns.status, ['draft', 'scheduled'] as never[]),
        ),
      )
      .returning();

    return row === undefined ? null : toCampaign(row);
  }

  /**
   * Copies a campaign's configuration into a new draft.
   *
   * Never the state, the counters, the recipients or the pinned template
   * version. A clone that carried those would be a second campaign claiming
   * to have sent what the first one sent.
   */
  async clone(
    scope: WorkspaceScope,
    input: { sourceId: CampaignId; id: CampaignId; name: string },
  ): Promise<CampaignRow> {
    const source = await this.findById(scope, input.sourceId);
    if (source === null) throw new Error('cloneCampaign: source not found in this workspace');

    const [row] = await this.db
      .insert(campaigns)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        name: input.name,
        // Configuration only. Not the status, the counts, the snapshot, the
        // pinned template version or the schedule.
        ...(source.subjectOverride === null ? {} : { subjectOverride: source.subjectOverride }),
        ...(source.senderAccountId === null
          ? {}
          : { senderAccountId: source.senderAccountId as never }),
        ...(source.sendingPoolId === null ? {} : { sendingPoolId: source.sendingPoolId as never }),
        ...(source.throttlePerHour === null ? {} : { throttlePerHour: source.throttlePerHour }),
        audience: source.audience,
        clonedFrom: input.sourceId,
      })
      .returning();

    if (row === undefined) throw new Error('cloneCampaign: insert returned no row');

    await this.db.insert(campaignCounters).values({
      campaignId: input.id,
      workspaceId: scope.workspaceId,
    });

    return toCampaign(row);
  }

  /**
   * Files a terminal campaign away (G1's Archive action).
   *
   * Guarded on the status rather than checked first, for the same reason
   * `update` is: a campaign can complete between a read and a write, and —
   * more to the point — a *sending* campaign must never be archivable. An
   * archived campaign is hidden from the list, and hiding one that is still
   * handing messages to a provider would take the only progress view of a
   * live send off the screen.
   *
   * Also guarded on `archived_at IS NULL`, so a second archive returns zero
   * rows and the service can say so instead of silently moving the
   * timestamp.
   */
  async archive(scope: WorkspaceScope, id: CampaignId): Promise<CampaignRow | null> {
    const [row] = await this.db
      .update(campaigns)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(campaigns.id, id),
          eq(campaigns.workspaceId, scope.workspaceId),
          isNull(campaigns.deletedAt),
          isNull(campaigns.archivedAt),
          inArray(campaigns.status, ARCHIVABLE_STATUSES as never[]),
        ),
      )
      .returning();

    return row === undefined ? null : toCampaign(row);
  }

  /**
   * The inverse.
   *
   * Not in the design's row menu — an archived campaign has no frame that
   * lists it yet — but archiving without it is a one-way door, and a
   * one-way door reached from a menu two clicks from "Duplicate" is a
   * support ticket. No status guard: whatever state the campaign was
   * archived in is the state it comes back to.
   */
  async unarchive(scope: WorkspaceScope, id: CampaignId): Promise<CampaignRow | null> {
    const [row] = await this.db
      .update(campaigns)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(campaigns.id, id),
          eq(campaigns.workspaceId, scope.workspaceId),
          isNull(campaigns.deletedAt),
          isNotNull(campaigns.archivedAt),
        ),
      )
      .returning();

    return row === undefined ? null : toCampaign(row);
  }

  /**
   * G3's event timeline: `campaign_events`, newest first, with the actor's
   * name resolved.
   *
   * Reads `campaign_events` and nothing else. It is emphatically not an
   * aggregate over `campaign_recipients` (R13) — the numbers a timeline
   * entry quotes were written into its `detail` blob by whoever recorded it,
   * at the moment it was true, which is also the only way "31,618 of 48,213
   * handed to providers" can still be right when the page is reopened
   * tomorrow.
   *
   * Bounded. A long campaign accumulates dispatch and dunning entries, and
   * an unbounded read of a table indexed `(campaign_id, created_at DESC)`
   * is a fine query right up to the campaign that has forty thousand of
   * them.
   */
  async listEvents(
    scope: WorkspaceScope,
    id: CampaignId,
    options: { limit?: number } = {},
  ): Promise<CampaignEventRow[]> {
    const rows = await this.db
      .select({
        id: campaignEvents.id,
        eventType: campaignEvents.eventType,
        actorType: campaignEvents.actorType,
        actorId: campaignEvents.actorId,
        actorName: users.name,
        detail: campaignEvents.detail,
        createdAt: campaignEvents.createdAt,
      })
      .from(campaignEvents)
      // Left, not inner: most entries are the system's and have no user, and
      // an inner join would silently drop every one of them.
      .leftJoin(users, eq(users.id, campaignEvents.actorId))
      .where(
        and(
          eq(campaignEvents.workspaceId, scope.workspaceId),
          eq(campaignEvents.campaignId, id),
        ),
      )
      .orderBy(desc(campaignEvents.createdAt), desc(campaignEvents.id))
      .limit(Math.min(Math.max(options.limit ?? 100, 1), 200));

    return rows.map(toEvent);
  }

  /**
   * The Idempotency-Key claim (F29).
   *
   * No separate key table: `campaigns.idempotency_key` and the unique index
   * `uq_campaign_idem` on `(workspace_id, idempotency_key)` already exist for
   * exactly this, and a second table would need its own expiry, its own
   * cleanup job and its own answer to what happens when the two disagree.
   *
   * One guarded UPDATE decides which request is the launcher:
   *
   *   `SET idempotency_key = $key WHERE id = $id AND idempotency_key IS NULL`
   *
   * Zero rows means either somebody else claimed it — in which case the
   * caller reads the row and returns their result — or this is the same
   * request arriving twice, which is the same answer. The launch's own
   * guarded transition (R29) is still the durable guard; this only decides
   * what the loser is told.
   */
  async claimLaunchKey(
    scope: WorkspaceScope,
    input: { id: CampaignId; key: string },
  ): Promise<'claimed' | 'taken'> {
    const rows = await this.db
      .update(campaigns)
      .set({ idempotencyKey: input.key })
      .where(
        and(
          eq(campaigns.id, input.id),
          eq(campaigns.workspaceId, scope.workspaceId),
          isNull(campaigns.idempotencyKey),
        ),
      )
      .returning({ id: campaigns.id });

    return rows.length > 0 ? 'claimed' : 'taken';
  }

  /**
   * The result a replayed launch should be given.
   *
   * Returns null when the key on the row is a *different* key, which is not a
   * replay at all — it is a second launch attempt on a campaign that has
   * already been launched once, and it deserves the ordinary 409.
   */
  async findLaunchByKey(
    scope: WorkspaceScope,
    input: { id: CampaignId; key: string },
  ): Promise<{ ok: true; recipientCount: number; suppressedAtSnapshot: number } | null> {
    const [row] = await this.db
      .select({
        key: campaigns.idempotencyKey,
        recipientCount: campaigns.recipientCount,
        snapshotAt: campaigns.snapshotAt,
      })
      .from(campaigns)
      .where(and(eq(campaigns.id, input.id), eq(campaigns.workspaceId, scope.workspaceId)))
      .limit(1);

    if (row === undefined || row.key !== input.key || row.snapshotAt === null) return null;

    // `suppressedAtSnapshot` is not stored on the campaign — it is reported
    // once, at launch. A replay gets zero rather than a wrong number, and the
    // count is on the campaign's own timeline for anyone who needs it.
    return { ok: true, recipientCount: row.recipientCount, suppressedAtSnapshot: 0 };
  }

  /**
   * The audience preview count.
   *
   * Over `contacts`, not over `campaign_recipients` — R13 forbids the latter
   * in a request path and says nothing about the former, which is the whole
   * point of a preview: telling the author how many people this will reach
   * before they commit to reaching them.
   *
   * Counted with the same predicates the snapshot uses, so the number the
   * author sees is the number they get. A preview that omits the suppression
   * check reads high by exactly the count the launch will then refuse.
   */
  async previewAudienceCount(
    scope: WorkspaceScope,
    input: { listIds: readonly string[] },
  ): Promise<{ eligible: number; suppressed: number }> {
    if (input.listIds.length === 0) return { eligible: 0, suppressed: 0 };

    for (const id of input.listIds) {
      if (!/^[0-9a-fA-F-]{1,64}$/u.test(id)) {
        throw new Error(`Refusing to interpolate an unexpected list id: ${JSON.stringify(id)}`);
      }
    }

    const literal = `ARRAY[${input.listIds.map((id) => `'${id}'`).join(', ')}]`;

    const { rows } = await this.db.execute<{ eligible: string; suppressed: string }>(sql`
      SELECT
        count(*) FILTER (
          WHERE NOT EXISTS (
            SELECT 1 FROM suppressions s
             WHERE s.workspace_id = c.workspace_id AND s.email = c.email
          )
        )::text AS eligible,
        count(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM suppressions s
             WHERE s.workspace_id = c.workspace_id AND s.email = c.email
          )
        )::text AS suppressed
        FROM contacts c
       WHERE c.workspace_id = ${scope.workspaceId}
         AND c.status = 'subscribed'
         AND c.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM contact_list_members m
            WHERE m.contact_id = c.id
              AND m.workspace_id = c.workspace_id
              AND m.list_id = ANY(${sql.raw(literal)}::uuid[])
         )
    `);

    return {
      eligible: Number(rows[0]?.eligible ?? 0),
      suppressed: Number(rows[0]?.suppressed ?? 0),
    };
  }

  /**
   * A test send.
   *
   * Deliberately writes no `campaign_recipients` row. A test send is not a
   * send: it is never metered, never appears in the counters, and must not
   * make a draft campaign look partly sent.
   */
  async enqueueTestSend(
    scope: WorkspaceScope,
    input: { campaignId: CampaignId; to: string[] },
  ): Promise<{ queued: number }> {
    await this.db.insert(campaignEvents).values({
      workspaceId: scope.workspaceId,
      campaignId: input.campaignId,
      eventType: 'campaign.test_send',
      detail: { to: input.to },
    });

    return { queued: input.to.length };
  }
}

function toCampaign(row: Record<string, unknown>): CampaignRow {
  return row as unknown as CampaignRow;
}

function toCounters(row: Record<string, unknown>): CampaignCountersRow {
  return row as unknown as CampaignCountersRow;
}

function toRecipient(row: Record<string, unknown>): RecipientRow {
  return row as unknown as RecipientRow;
}

/**
 * `campaign_events.id` is a BIGSERIAL, and a bigint does not survive
 * `JSON.stringify` — it throws. Rendered as a string at the boundary, which
 * is also what the client declares it as.
 */
function toEvent(row: {
  id: bigint | number | string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  detail: unknown;
  createdAt: Date;
}): CampaignEventRow {
  return {
    id: String(row.id),
    eventType: row.eventType,
    actorType: row.actorType as CampaignEventRow['actorType'],
    actorId: row.actorId,
    actorName: row.actorName,
    detail: row.detail,
    createdAt: row.createdAt,
  };
}
