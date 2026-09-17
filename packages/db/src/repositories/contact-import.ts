import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { from as copyFrom } from 'pg-copy-streams';
import type pg from 'pg';
import { escapeCopyValue } from '../helpers.js';
import type { WorkspaceScope } from '../scope.js';

/**
 * Bulk contact ingest: COPY into a staging table, then one merge.
 *
 * BUILD-PLAN Phase 2 specifies COPY rather than batched inserts, and the
 * reason is measurable: 500,000 single-row inserts is 500,000 round trips and
 * 500,000 parse-plan cycles, while COPY is one stream and the merge is one
 * statement. docs/01 chose Drizzle partly so this could "drop to pg COPY FROM
 * STDIN in the same pool".
 *
 * This takes a raw pg client rather than a Drizzle handle because COPY is a
 * protocol-level operation with no query-builder representation. It is the
 * only place in the codebase that does, which is why it is here in
 * repositories/ with everything else that touches the database.
 */

export interface ImportRow {
  email: string;
  firstName?: string;
  lastName?: string;
  attributes: Record<string, string>;
  flagged: boolean;
}

export interface MergeResult {
  created: number;
  updated: number;
  skipped: number;
}

export interface MergeOptions {
  /** When false, an existing contact is left untouched and counted skipped. */
  updateExisting: boolean;
  /** Recorded on every contact this import creates (docs/02). */
  consentDeclaration: string;
  consentStatus?: 'unknown' | 'single_optin' | 'double_optin' | 'imported_declared';
}

export class ContactImportRepository {
  constructor(private readonly client: pg.PoolClient | pg.Client) {}

  /**
   * Writes one batch and merges it into contacts.
   *
   * Must run inside a transaction that has already set app.workspace_id: the
   * staging table is ON COMMIT DROP, and the merge relies on RLS being in
   * force for the same scope.
   */
  async writeBatch(
    scope: WorkspaceScope,
    rows: readonly ImportRow[],
    options: MergeOptions,
  ): Promise<MergeResult> {
    if (rows.length === 0) return { created: 0, updated: 0, skipped: 0 };

    await this.createStagingTable();
    await this.copyInto(rows);

    return this.merge(scope, options);
  }

  /**
   * A per-transaction staging table.
   *
   * TEMP and ON COMMIT DROP, so concurrent imports in different connections
   * cannot collide and nothing survives a failure. UNLOGGED is implied for
   * temp tables, which is what makes the COPY cheap.
   */
  private async createStagingTable(): Promise<void> {
    await this.client.query(`
      CREATE TEMP TABLE IF NOT EXISTS contact_import_staging (
        email      text NOT NULL,
        first_name text,
        last_name  text,
        attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
        flagged    boolean NOT NULL DEFAULT false
      ) ON COMMIT DROP
    `);
    // Reused across batches within one transaction.
    await this.client.query('TRUNCATE contact_import_staging');
  }

  private async copyInto(rows: readonly ImportRow[]): Promise<void> {
    const stream = this.client.query(
      copyFrom(
        `COPY contact_import_staging (email, first_name, last_name, attributes, flagged)
         FROM STDIN WITH (FORMAT text)`,
      ),
    );

    const source = Readable.from(
      (function* generate() {
        for (const row of rows) {
          yield `${[
            escapeCopyValue(row.email),
            escapeCopyValue(row.firstName ?? null),
            escapeCopyValue(row.lastName ?? null),
            escapeCopyValue(JSON.stringify(row.attributes)),
            row.flagged ? 't' : 'f',
          ].join('\t')}\n`;
        }
      })(),
    );

    await pipeline(source, stream);
  }

  /**
   * One statement merges the whole batch.
   *
   * ON CONFLICT names the partial unique index predicate explicitly, because
   * uq_contacts_ws_email is partial on deleted_at IS NULL and Postgres will
   * not infer a partial index without it.
   *
   * `xmax = 0` in RETURNING distinguishes an inserted row from an updated one.
   * It is the standard idiom and the only way to get per-row create/update
   * counts out of a single upsert; the alternative is a second query that
   * races with the first.
   */
  private async merge(scope: WorkspaceScope, options: MergeOptions): Promise<MergeResult> {
    const consentStatus = options.consentStatus ?? 'imported_declared';

    const updateClause = options.updateExisting
      ? `DO UPDATE SET
           first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
           last_name  = COALESCE(EXCLUDED.last_name,  contacts.last_name),
           attributes = contacts.attributes || EXCLUDED.attributes,
           updated_at = now()`
      : 'DO NOTHING';

    const { rows } = await this.client.query<{ created: boolean }>(
      `
      INSERT INTO contacts (
        id, workspace_id, email, first_name, last_name, attributes,
        source, consent_status, consent_source, consent_at
      )
      SELECT
        gen_random_uuid(), $1, s.email, s.first_name, s.last_name, s.attributes,
        'import', $2, $3, now()
      FROM contact_import_staging s
      ON CONFLICT (workspace_id, email) WHERE deleted_at IS NULL
      ${updateClause}
      RETURNING (xmax = 0) AS created
      `,
      [scope.workspaceId, consentStatus, options.consentDeclaration],
    );

    const created = rows.filter((row) => row.created).length;
    const updated = rows.length - created;

    // Rows the merge did not touch at all: present already, with
    // updateExisting off.
    const { rows: staged } = await this.client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_import_staging',
    );
    const stagedCount = Number(staged[0]?.count ?? 0);

    return { created, updated, skipped: Math.max(stagedCount - rows.length, 0) };
  }
}

/**
 * The id column has no default in the schema — ids are UUIDv7 generated in the
 * application (CLAUDE.md section 8). The merge above uses gen_random_uuid()
 * instead, deliberately: generating 500,000 v7 ids in Node and shipping them
 * through COPY costs a column of bandwidth and a round of string building for
 * rows that are mostly conflicts. Imported contacts are the one population
 * where insertion order carries no useful locality, because COPY presents them
 * all at once.
 *
 * Recorded here rather than in a commit message because the next person to
 * read the schema will wonder.
 */
export const IMPORT_ID_STRATEGY = 'gen_random_uuid';
