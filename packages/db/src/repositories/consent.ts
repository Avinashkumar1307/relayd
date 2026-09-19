import { and, desc, eq } from 'drizzle-orm';
import { consentAttestations } from '../schema/abuse.js';
import type { WorkspaceScope } from '../scope.js';
import type { Executor } from './executor.js';

/**
 * Consent attestations (migration 0016; docs/06 "Anti-abuse").
 *
 * **There is no update and no delete here, and that is the design.** docs/02:
 * "This is what lets you defend a workspace when a provider or a regulator
 * asks, and it is what lets you suspend a workspace that lied." A record that
 * can be edited after the fact does neither.
 *
 * The trigger in migration 0016 enforces it at the database, because the
 * absence of a method is not a guarantee — it is only the absence of a
 * method.
 */

export type ConsentSubjectKind = 'import' | 'campaign';

export interface AttestationRow {
  id: string;
  subjectKind: ConsentSubjectKind;
  subjectId: string;
  source: string;
  detail: string | null;
  audienceFingerprint: string | null;
  attestedBy: string;
  attestedAt: Date;
}

export class ConsentRepository {
  constructor(private readonly db: Executor) {}

  async record(
    scope: WorkspaceScope,
    input: {
      id: string;
      subjectKind: ConsentSubjectKind;
      subjectId: string;
      source: string;
      detail?: string | null;
      audienceFingerprint?: string | null;
      attestedBy: string;
      attestedAt?: Date;
      attestedIp?: string | null;
    },
  ): Promise<AttestationRow> {
    const [row] = await this.db
      .insert(consentAttestations)
      .values({
        id: input.id,
        workspaceId: scope.workspaceId,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        source: input.source,
        detail: input.detail ?? null,
        audienceFingerprint: input.audienceFingerprint ?? null,
        attestedBy: input.attestedBy,
        ...(input.attestedAt === undefined ? {} : { attestedAt: input.attestedAt }),
        attestedIp: input.attestedIp ?? null,
      })
      .returning();

    if (row === undefined) throw new Error('recordAttestation: insert returned no row');
    return toRow(row);
  }

  /**
   * The newest attestation for one subject.
   *
   * Newest rather than "the" attestation, because the table is append-only:
   * re-attesting writes a second row, and the older one stays as the record
   * of what was claimed before.
   */
  async newestFor(
    scope: WorkspaceScope,
    subjectKind: ConsentSubjectKind,
    subjectId: string,
  ): Promise<AttestationRow | null> {
    const [row] = await this.db
      .select()
      .from(consentAttestations)
      .where(
        and(
          eq(consentAttestations.workspaceId, scope.workspaceId),
          eq(consentAttestations.subjectKind, subjectKind),
          eq(consentAttestations.subjectId, subjectId),
        ),
      )
      .orderBy(desc(consentAttestations.attestedAt))
      .limit(1);

    return row === undefined ? null : toRow(row);
  }

  /**
   * Everything this workspace has ever claimed, newest first.
   *
   * The query an investigation runs. Both subject kinds together, because
   * "this workspace said signup_form about the import and existing_customer
   * about the campaign that sent it" is the shape of the finding.
   */
  async listForWorkspace(
    scope: WorkspaceScope,
    limit = 100,
  ): Promise<AttestationRow[]> {
    const rows = await this.db
      .select()
      .from(consentAttestations)
      .where(eq(consentAttestations.workspaceId, scope.workspaceId))
      .orderBy(desc(consentAttestations.attestedAt))
      .limit(limit);

    return rows.map(toRow);
  }
}

function toRow(row: typeof consentAttestations.$inferSelect): AttestationRow {
  return {
    id: row.id,
    subjectKind: row.subjectKind as ConsentSubjectKind,
    subjectId: row.subjectId,
    source: row.source,
    detail: row.detail,
    audienceFingerprint: row.audienceFingerprint,
    attestedBy: row.attestedBy,
    attestedAt: row.attestedAt,
  };
}
