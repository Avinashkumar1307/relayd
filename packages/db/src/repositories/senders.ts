import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  ProviderConnectionId,
  SenderAccountId,
  SenderIdentityId,
  WorkspaceId,
} from '@relayd/types';
import { senderAccounts, senderIdentities } from '../schema/providers.js';
import type { SenderStatus } from '../schema/providers.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * Sender identities and sender accounts.
 *
 * An identity is something the provider has verified — a domain or an address.
 * A sender account is a From address built on one. The separation matters
 * because a campaign cannot launch from an unverified identity, and the UI has
 * to be able to say which of the two is wrong.
 */

export interface SenderIdentityRow {
  id: SenderIdentityId;
  workspaceId: WorkspaceId;
  providerId: ProviderConnectionId;
  kind: 'domain' | 'email';
  value: string;
  verificationStatus: 'pending' | 'verified' | 'failed' | 'expired';
  dkimStatus: string | null;
  spfStatus: string | null;
  dmarcStatus: string | null;
  dnsRecords: Record<string, unknown> | null;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
}

export class SenderIdentityRepository {
  constructor(private readonly db: Executor) {}

  async upsert(
    scope: WorkspaceScope,
    input: {
      id: SenderIdentityId;
      providerId: ProviderConnectionId;
      kind: 'domain' | 'email';
      value: string;
      verificationStatus?: SenderIdentityRow['verificationStatus'];
      dkimStatus?: string;
      dnsRecords?: Record<string, unknown>;
    },
  ): Promise<SenderIdentityRow> {
    const [row] = await this.db
      .insert(senderIdentities)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        providerId: input.providerId,
        kind: input.kind,
        value: input.value,
        ...(input.verificationStatus === undefined
          ? {}
          : { verificationStatus: input.verificationStatus }),
        ...(input.dkimStatus === undefined ? {} : { dkimStatus: input.dkimStatus }),
        ...(input.dnsRecords === undefined ? {} : { dnsRecords: input.dnsRecords }),
      })
      // Re-syncing from the provider must update what it found rather than
      // fail on a value that is already there.
      .onConflictDoUpdate({
        target: [senderIdentities.providerId, senderIdentities.kind, senderIdentities.value],
        set: {
          ...(input.verificationStatus === undefined
            ? {}
            : { verificationStatus: input.verificationStatus }),
          ...(input.dkimStatus === undefined ? {} : { dkimStatus: input.dkimStatus }),
          ...(input.dnsRecords === undefined ? {} : { dnsRecords: input.dnsRecords }),
          lastCheckedAt: new Date(),
        },
      })
      .returning();

    if (row === undefined) throw new Error('upsertIdentity: returned no row');
    return toIdentity(row);
  }

  async findById(
    scope: WorkspaceScope,
    id: SenderIdentityId,
  ): Promise<SenderIdentityRow | null> {
    const [row] = await this.db
      .select()
      .from(senderIdentities)
      .where(
        and(eq(senderIdentities.id, id), eq(senderIdentities.workspaceId, scope.workspaceId)),
      )
      .limit(1);

    return row === undefined ? null : toIdentity(row);
  }

  async list(
    scope: WorkspaceScope,
    options: { providerId?: ProviderConnectionId } = {},
  ): Promise<SenderIdentityRow[]> {
    const rows = await this.db
      .select()
      .from(senderIdentities)
      .where(
        and(
          eq(senderIdentities.workspaceId, scope.workspaceId),
          ...(options.providerId === undefined
            ? []
            : [eq(senderIdentities.providerId, options.providerId)]),
        ),
      )
      .orderBy(desc(senderIdentities.createdAt));

    return rows.map(toIdentity);
  }

  async markVerified(
    scope: WorkspaceScope,
    id: SenderIdentityId,
    statuses: { dkim?: string; spf?: string; dmarc?: string } = {},
  ): Promise<boolean> {
    const rows = await this.db
      .update(senderIdentities)
      .set({
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        lastCheckedAt: new Date(),
        ...(statuses.dkim === undefined ? {} : { dkimStatus: statuses.dkim }),
        ...(statuses.spf === undefined ? {} : { spfStatus: statuses.spf }),
        ...(statuses.dmarc === undefined ? {} : { dmarcStatus: statuses.dmarc }),
      })
      .where(and(eq(senderIdentities.id, id), eq(senderIdentities.workspaceId, scope.workspaceId)))
      .returning({ id: senderIdentities.id });

    return rows.length > 0;
  }

  async markUnverified(
    scope: WorkspaceScope,
    id: SenderIdentityId,
    status: 'pending' | 'failed' | 'expired',
  ): Promise<boolean> {
    const rows = await this.db
      .update(senderIdentities)
      .set({ verificationStatus: status, verifiedAt: null, lastCheckedAt: new Date() })
      .where(and(eq(senderIdentities.id, id), eq(senderIdentities.workspaceId, scope.workspaceId)))
      .returning({ id: senderIdentities.id });

    return rows.length > 0;
  }
}

export interface SenderAccountRow {
  id: SenderAccountId;
  workspaceId: WorkspaceId;
  providerId: ProviderConnectionId;
  identityId: SenderIdentityId;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
  status: SenderStatus;
  dailyLimit: number | null;
  hourlyLimit: number | null;
  concurrencyLimit: number;
  healthScore: number;
  consecutiveFailures: number;
  cooldownUntil: Date | null;
  lastSendAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class SenderAccountRepository {
  constructor(private readonly db: Executor) {}

  async create(
    scope: WorkspaceScope,
    input: {
      id: SenderAccountId;
      providerId: ProviderConnectionId;
      identityId: SenderIdentityId;
      fromEmail: string;
      fromName: string;
      replyTo?: string;
      dailyLimit?: number;
      hourlyLimit?: number;
    },
  ): Promise<SenderAccountRow> {
    const [row] = await this.db
      .insert(senderAccounts)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        providerId: input.providerId,
        identityId: input.identityId,
        fromEmail: input.fromEmail,
        fromName: input.fromName,
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        ...(input.dailyLimit === undefined ? {} : { dailyLimit: input.dailyLimit }),
        ...(input.hourlyLimit === undefined ? {} : { hourlyLimit: input.hourlyLimit }),
      })
      .returning();

    if (row === undefined) throw new Error('createSender: insert returned no row');
    return toSender(row);
  }

  async findById(scope: WorkspaceScope, id: SenderAccountId): Promise<SenderAccountRow | null> {
    const [row] = await this.db
      .select()
      .from(senderAccounts)
      .where(and(eq(senderAccounts.id, id), eq(senderAccounts.workspaceId, scope.workspaceId)))
      .limit(1);

    return row === undefined ? null : toSender(row);
  }

  async list(
    scope: WorkspaceScope,
    options: { providerId?: ProviderConnectionId } = {},
  ): Promise<SenderAccountRow[]> {
    const rows = await this.db
      .select()
      .from(senderAccounts)
      .where(
        and(
          eq(senderAccounts.workspaceId, scope.workspaceId),
          ...(options.providerId === undefined
            ? []
            : [eq(senderAccounts.providerId, options.providerId)]),
        ),
      )
      .orderBy(desc(senderAccounts.createdAt));

    return rows.map(toSender);
  }

  async update(
    scope: WorkspaceScope,
    id: SenderAccountId,
    patch: {
      fromName?: string;
      replyTo?: string | null;
      dailyLimit?: number | null;
      hourlyLimit?: number | null;
      concurrencyLimit?: number;
    },
  ): Promise<SenderAccountRow | null> {
    const [row] = await this.db
      .update(senderAccounts)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(senderAccounts.id, id), eq(senderAccounts.workspaceId, scope.workspaceId)))
      .returning();

    return row === undefined ? null : toSender(row);
  }

  /**
   * A guarded status transition, as on connections.
   *
   * The router marks a sender cooling_down while an operator may be pausing
   * it; whichever lands second must not silently undo the first.
   */
  async transition(
    scope: WorkspaceScope,
    id: SenderAccountId,
    from: readonly SenderStatus[],
    to: SenderStatus,
    fields: { cooldownUntil?: Date | null } = {},
  ): Promise<boolean> {
    const rows = await this.db
      .update(senderAccounts)
      .set({ status: to, ...fields, updatedAt: new Date() })
      .where(
        and(
          eq(senderAccounts.id, id),
          eq(senderAccounts.workspaceId, scope.workspaceId),
          sql`${senderAccounts.status} = ANY(${sql.param(from)})`,
        ),
      )
      .returning({ id: senderAccounts.id });

    return rows.length > 0;
  }

  /**
   * Adjusts health, clamped to the column's own range.
   *
   * Relative rather than absolute: two workers reporting failures at once
   * must not lose one another's penalty, which a read-modify-write would.
   * The CHECK constraint on the column would reject an out-of-range value, so
   * the clamp is here rather than discovering it as a failed statement in the
   * middle of a send.
   */
  async adjustHealth(
    scope: WorkspaceScope,
    id: SenderAccountId,
    delta: number,
  ): Promise<number | null> {
    const [row] = await this.db
      .update(senderAccounts)
      .set({
        healthScore: sql`GREATEST(0, LEAST(100, ${senderAccounts.healthScore} + ${delta}))`,
        consecutiveFailures:
          delta < 0
            ? sql`${senderAccounts.consecutiveFailures} + 1`
            : sql`0`,
        updatedAt: new Date(),
      })
      .where(and(eq(senderAccounts.id, id), eq(senderAccounts.workspaceId, scope.workspaceId)))
      .returning({ healthScore: senderAccounts.healthScore });

    return row?.healthScore ?? null;
  }

  async recordSend(scope: WorkspaceScope, id: SenderAccountId, at: Date): Promise<void> {
    await this.db
      .update(senderAccounts)
      .set({ lastSendAt: at })
      .where(and(eq(senderAccounts.id, id), eq(senderAccounts.workspaceId, scope.workspaceId)));
  }

  async remove(scope: WorkspaceScope, id: SenderAccountId): Promise<boolean> {
    const rows = await this.db
      .delete(senderAccounts)
      .where(and(eq(senderAccounts.id, id), eq(senderAccounts.workspaceId, scope.workspaceId)))
      .returning({ id: senderAccounts.id });

    return rows.length > 0;
  }
}

function toIdentity(row: typeof senderIdentities.$inferSelect): SenderIdentityRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    providerId: row.providerId,
    kind: row.kind,
    value: row.value,
    verificationStatus: row.verificationStatus,
    dkimStatus: row.dkimStatus,
    spfStatus: row.spfStatus,
    dmarcStatus: row.dmarcStatus,
    dnsRecords: (row.dnsRecords as Record<string, unknown> | null) ?? null,
    verifiedAt: row.verifiedAt,
    lastCheckedAt: row.lastCheckedAt,
    createdAt: row.createdAt,
  };
}

function toSender(row: typeof senderAccounts.$inferSelect): SenderAccountRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    providerId: row.providerId,
    identityId: row.identityId,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    replyTo: row.replyTo,
    status: row.status,
    dailyLimit: row.dailyLimit,
    hourlyLimit: row.hourlyLimit,
    concurrencyLimit: row.concurrencyLimit,
    healthScore: row.healthScore,
    consecutiveFailures: row.consecutiveFailures,
    cooldownUntil: row.cooldownUntil,
    lastSendAt: row.lastSendAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
