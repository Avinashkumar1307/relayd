import { createHash } from 'node:crypto';
import { and, inArray, isNull, lte, or, gt, eq, sql } from 'drizzle-orm';
import { blockedLinkDomains, globalBlockedAddresses } from '../../schema/abuse.js';
import type { Executor } from '../executor.js';

/**
 * The cross-workspace block list (migration 0018; docs/06 "Shared signals").
 *
 * docs/06: "Addresses that complained in any workspace go on a global block
 * list applied everywhere."
 *
 * Cross-tenant by nature — that is the entire feature — so it lives here and
 * takes no `WorkspaceScope` (CLAUDE.md section 6.2).
 */

/**
 * Hashes an address for the block list.
 *
 * Peppered, and the pepper is what makes the hash worth anything. Email
 * addresses are drawn from a small enough space to enumerate: an unpeppered
 * SHA-256 of a stolen table can be brute-forced against a dictionary in an
 * afternoon, which would turn a safety feature into a leak of every
 * complainer we have.
 *
 * The pepper comes from Secrets Manager and is passed in rather than read
 * here, because `packages/config` is the only place that reads the
 * environment (CLAUDE.md section 7) and because a test needs to be able to
 * supply its own.
 */
export function hashAddress(address: string, pepper: string): Buffer {
  const normalised = address.trim().toLowerCase();

  // The pepper goes first. Appended, a length-extension attack against
  // SHA-256 lets somebody who learns one hash compute others without knowing
  // the secret — not exploitable in this exact shape, but there is no reason
  // to build the version that needs the argument.
  return createHash('sha256').update(pepper).update('\u0000').update(normalised).digest();
}

export class GlobalBlockListRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Which of these addresses are blocked.
   *
   * Takes hashes, not addresses. The plaintext never reaches this layer, so
   * it cannot reach a query log or a slow-query report — which is where a
   * table of complainers would otherwise leak from.
   *
   * Batched because the send path checks a page of recipients at a time and
   * a query per recipient would be a round trip per email.
   */
  async blockedAmong(hashes: readonly Buffer[]): Promise<Set<string>> {
    if (hashes.length === 0) return new Set();

    const rows = await this.db
      .select({ addressHash: globalBlockedAddresses.addressHash })
      .from(globalBlockedAddresses)
      .where(inArray(globalBlockedAddresses.addressHash, [...hashes]));

    // Hex rather than the Buffer, so a caller can use `Set.has` — two Buffers
    // with identical bytes are different objects and would never match.
    return new Set(rows.map((row) => row.addressHash.toString('hex')));
  }

  /**
   * Records a complaint against an address.
   *
   * `workspace_count` counts *distinct* workspaces, so it is only incremented
   * when the caller knows this workspace has not reported this address
   * before — the caller has the per-workspace suppression row that answers
   * that, and doing it here would need the workspace id, which is the one
   * thing this table deliberately does not store.
   */
  async record(input: {
    addressHash: Buffer;
    reason: 'complaint' | 'spam_trap' | 'manual' | 'abuse_report';
    at: Date;
    newWorkspace: boolean;
  }): Promise<void> {
    await this.db
      .insert(globalBlockedAddresses)
      .values({
        addressHash: input.addressHash,
        reason: input.reason,
        workspaceCount: 1,
        firstSeenAt: input.at,
        lastSeenAt: input.at,
      })
      .onConflictDoUpdate({
        target: globalBlockedAddresses.addressHash,
        set: {
          // GREATEST rather than assignment: provider webhooks arrive out of
          // order, and a late event carrying an older timestamp must not move
          // `last_seen_at` backwards — the column is what an operator reads to
          // decide whether an address is still active.
          lastSeenAt: sql`greatest(${globalBlockedAddresses.lastSeenAt}, ${input.at})`,
          ...(input.newWorkspace
            ? { workspaceCount: sql`${globalBlockedAddresses.workspaceCount} + 1` }
            : {}),
        },
      });
  }

  /** Blocked link domains, for the launch check. */
  async blockedDomains(domains: readonly string[], now: Date): Promise<string[]> {
    if (domains.length === 0) return [];

    const rows = await this.db
      .select({ domain: blockedLinkDomains.domain })
      .from(blockedLinkDomains)
      .where(
        and(
          inArray(blockedLinkDomains.domain, domains.map((domain) => domain.toLowerCase())),
          eq(blockedLinkDomains.verdict, 'malicious'),
          // A null expiry means permanent. Written as an explicit OR rather
          // than relying on the comparison, because `null > now` is null in
          // SQL and would silently drop every permanent block.
          or(isNull(blockedLinkDomains.expiresAt), gt(blockedLinkDomains.expiresAt, now)),
        ),
      );

    return rows.map((row) => row.domain);
  }

  /** Caches a feed verdict, or records an operator's decision. */
  async blockDomain(input: {
    domain: string;
    verdict: 'malicious' | 'suspicious';
    source: string;
    note?: string | null;
    expiresAt?: Date | null;
  }): Promise<void> {
    await this.db
      .insert(blockedLinkDomains)
      .values({
        domain: input.domain.toLowerCase(),
        verdict: input.verdict,
        source: input.source,
        note: input.note ?? null,
        expiresAt: input.expiresAt ?? null,
      })
      .onConflictDoUpdate({
        target: blockedLinkDomains.domain,
        set: {
          verdict: input.verdict,
          source: input.source,
          ...(input.note === undefined ? {} : { note: input.note }),
          expiresAt: input.expiresAt ?? null,
          updatedAt: sql`now()`,
        },
      });
  }

  /** Drops expired entries. For the nightly maintenance job. */
  async pruneExpiredDomains(now: Date): Promise<number> {
    const rows = await this.db
      .delete(blockedLinkDomains)
      .where(lte(blockedLinkDomains.expiresAt, now))
      .returning({ domain: blockedLinkDomains.domain });

    return rows.length;
  }
}
