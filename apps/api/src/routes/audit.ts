import { Router, type Request, type Response } from 'express';
import type { TypeOf, ZodTypeAny } from 'zod';
import { ValidationError } from '@relayd/types';
import { formatRow } from '@relayd/audience';
import type { GlobalMembershipRepository } from '@relayd/db';
import {
  exportAuditLogsQuerySchema,
  listAuditLogsQuerySchema,
  type AuditLogFilters,
  type ListAuditLogsQuery,
} from '@relayd/validation';
import { requireScope } from '../context.js';
import { authenticate, requirePermission, requireWorkspace } from '../middleware/authorize.js';
import type { ApiKeyAuthOptions } from '../middleware/api-key-auth.js';
import type { AuditExportRecord, AuditLogService } from '../services/audit-log.js';
import type { TokenService } from '../services/tokens.js';

/**
 * The audit log (J6, docs/03 `/audit-logs`).
 *
 * Read-only, all of it. There is no endpoint here that writes an audit row —
 * rows are written by the services that perform the actions, inside the same
 * transaction, and an audit log that can be appended to over HTTP is a log
 * that can be forged over HTTP.
 *
 * `audit:read` gates every route. The permission matrix gives it to owners
 * and admins only, which is the right line: the audit log is the record of
 * what everybody in the workspace has done, and it is not an editor's to
 * read. An API key may hold it — only `billing:write` is ungrantable — so
 * these routes accept a key, unlike the key-management routes.
 *
 * ## Pagination, and a conflict worth naming
 *
 * docs/03 says "cursor only, no offset anywhere — it degrades and it
 * double-serves rows under concurrent writes". J6's footer says
 * "1–10 of 3,412 events" with numbered prev/next, which a cursor cannot
 * serve: a cursor has no notion of how many rows are behind it or ahead.
 *
 * Both are served. `?cursor=` is the documented form and has no depth limit;
 * `?page=` is J6's and is capped, so the offset can never grow unbounded.
 * Sending both is a 400 rather than a silent preference, because a client
 * that sends both has a bug and quietly honouring one of them hides it.
 * Every response carries `total` either way.
 *
 * The owner should decide whether J6 keeps its numbered pager. If it moves to
 * "load more", the `page` parameter and the count query both go away and this
 * endpoint becomes purely what docs/03 describes.
 */

export interface AuditRouterOptions {
  auditLogs: AuditLogService;
  tokens: TokenService;
  /** Accepts API keys as well as session tokens when wired. */
  apiKeys?: ApiKeyAuthOptions;
  memberships: GlobalMembershipRepository;
}

/** Query strings arrive as strings; Zod coerces, and rejects what it cannot. */
function parseQuery<S extends ZodTypeAny>(schema: S, req: Request): TypeOf<S> {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    throw new ValidationError(
      'Request validation failed',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data as TypeOf<S>;
}

/**
 * The export's columns.
 *
 * Wider than J6's table: the screen shows one line of prose, the file also
 * carries the raw `before` and `after`, which is what somebody reconstructing
 * an incident actually needs.
 */
const EXPORT_COLUMNS: readonly { header: string; value: (row: AuditExportRecord) => unknown }[] = [
  { header: 'Occurred at (UTC)', value: (row) => row.occurredAt },
  { header: 'Actor type', value: (row) => row.actorKind },
  { header: 'Actor', value: (row) => row.actor },
  { header: 'Action', value: (row) => row.action },
  { header: 'Resource type', value: (row) => row.resourceType },
  { header: 'Resource', value: (row) => row.resource },
  { header: 'Details', value: (row) => row.details },
  { header: 'Before', value: (row) => row.before },
  { header: 'After', value: (row) => row.after },
];

/**
 * Writes one chunk, waiting for the socket when it is full.
 *
 * Without the drain wait, a fast query and a slow client buffer the whole
 * export in the Node process — which is the thing streaming exists to avoid.
 */
function writeChunk(res: Response, chunk: string): Promise<void> {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    res.once('drain', resolve);
  });
}

export function auditRoutes(options: AuditRouterOptions): Router {
  const router = Router();
  const { auditLogs } = options;

  const auth = authenticate(options.tokens, options.apiKeys);
  const workspace = requireWorkspace({ memberships: options.memberships });
  const read = [auth, workspace, requirePermission('audit:read')] as const;

  /**
   * The export.
   *
   * Registered before the list so the literal `.csv` path is matched as
   * itself rather than being read as part of anything else, and because a
   * reader looking for "where does Export CSV go" finds it first.
   *
   * Every cell goes through `formatRow` from `@relayd/audience`, which
   * neutralises spreadsheet formulas (docs/06: a leading `=`, `+`, `-`, `@`,
   * tab or CR is prefixed with an apostrophe) as well as quoting for RFC
   * 4180. An audit log is full of attacker-influenced text — a contact name,
   * a template name, a webhook URL — and it is read in Excel by the one
   * person in the workspace with the most authority. Reusing the audience
   * exporter's helper rather than writing a second one is deliberate: two
   * escapers drift, and the one that drifts is the one nobody is looking at.
   */
  router.get('/audit-logs.csv', ...read, async (req: Request, res: Response) => {
    const filters: AuditLogFilters = parseQuery(exportAuditLogsQuerySchema, req);
    const scope = requireScope();

    let started = false;

    // Headers are not sent until there is something to send, so a query that
    // fails still renders the JSON error envelope instead of a truncated file
    // with a 200 on it.
    const begin = async (): Promise<void> => {
      started = true;
      res.status(200).set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
        // Without this a browser may decide a CSV whose first cell looks like
        // markup is HTML, and render it from our origin.
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      // A BOM, or Excel on Windows reads UTF-8 as the system codepage and
      // mangles every non-ASCII name in the file.
      await writeChunk(res, `\uFEFF${formatRow(EXPORT_COLUMNS.map((column) => column.header))}\r\n`);
    };

    await auditLogs.exportRecords(scope, filters, async (record) => {
      if (!started) await begin();
      await writeChunk(res, `${formatRow(EXPORT_COLUMNS.map((column) => column.value(record)))}\r\n`);
    });

    // An empty result is still a file with a header row, not a blank page.
    if (!started) await begin();
    res.end();
  });

  /** What the Actor and Action pickers offer. */
  router.get('/audit-logs/filters', ...read, async (_req: Request, res: Response) => {
    res.json({ data: await auditLogs.filterOptions(requireScope()) });
  });

  router.get('/audit-logs', ...read, async (req: Request, res: Response) => {
    const query: ListAuditLogsQuery = parseQuery(listAuditLogsQuerySchema, req);
    const page = await auditLogs.list(requireScope(), query);

    res.json({
      // `total` rides in `data` rather than in `meta`: the envelope in docs/03
      // models only hasMore and nextCursor, and the count is part of the
      // answer rather than part of how the answer was paged.
      data: { events: page.events, total: page.total },
      meta: {
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      },
    });
  });

  return router;
}
