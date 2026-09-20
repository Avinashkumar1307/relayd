import { z } from 'zod';

/**
 * Audit log query schemas (docs/02 audit_logs, docs/03 `/audit-logs`).
 *
 * Shared with the web app so J6's filter controls and the server agree on
 * what a filter value may be. The page keeps its filters in the query string
 * — a row somebody found is sent to a colleague as a link — so every field
 * here arrives as text and is coerced, never trusted.
 */

/**
 * The windows J6 offers.
 *
 * `all` is deliberately last and deliberately not the default: the default
 * read must be bounded so it walks `ix_audit_ws_time` over a short range
 * rather than the whole of a workspace's history.
 */
export const AUDIT_RANGE_VALUES = ['last_7', 'last_30', 'last_90', 'all'] as const;
export type AuditRange = (typeof AUDIT_RANGE_VALUES)[number];

export const auditRangeSchema = z.enum(AUDIT_RANGE_VALUES);

/** How many days each named window covers. `all` has no lower bound. */
export const AUDIT_RANGE_DAYS: Readonly<Record<AuditRange, number | null>> = {
  last_7: 7,
  last_30: 30,
  last_90: 90,
  all: null,
};

/**
 * The actor filter value for rows Relayd itself wrote.
 *
 * Those rows carry `actor_type = 'system'` (or `'provider'`) and a null
 * `actor_id`, so there is no id to filter on. The picker needs *some* value,
 * and a literal is honest about it being synthetic rather than minting a uuid
 * that matches nothing.
 */
export const SYSTEM_ACTOR_ID = 'system';

const actorFilter = z.union([z.literal(SYSTEM_ACTOR_ID), z.string().uuid()]);

/**
 * An empty query-string value means "no filter", not "match the empty
 * string". The page clears a filter by deleting the parameter, but a
 * hand-built URL or a stale bookmark can still carry `?q=`.
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : value));

/** The fields that narrow the result set. Shared by the list and the export. */
export const auditLogFiltersSchema = z.object({
  actor: actorFilter.optional(),
  action: optionalText(120),
  /**
   * Either one object's id or a whole resource type — `?resource=<uuid>` from
   * a campaign page's "see the history of this campaign" link, or
   * `?resource=campaign` for every campaign event.
   */
  resource: optionalText(200),
  range: auditRangeSchema.default('last_30'),
  q: optionalText(200),
});

/**
 * The deepest page the dashboard may ask for.
 *
 * Offset paging degrades linearly, so it is bounded rather than open. Past
 * this, narrowing the range or the filters is the answer — and the cursor
 * form below has no such ceiling.
 */
export const MAX_AUDIT_PAGE = 1000;

/**
 * A cursor is base64url of `{ occurredAt, id }`.
 *
 * Checked here rather than shrugged off downstream, because the alternative —
 * a repository that cannot read a cursor and quietly starts from the top —
 * re-serves rows the caller has already seen. In an audit log that reads as
 * the same event happening twice.
 *
 * Decoded by hand rather than with `Buffer` or `atob`: these schemas are
 * imported by the browser as well as the API, and the package compiles with
 * neither the DOM nor the Node type libraries.
 */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * base64url to a byte string, or null if it is not base64url.
 *
 * Bytes, not UTF-8: a cursor we mint holds an ISO timestamp and a uuid, both
 * pure ASCII, so the two are the same thing here. Anything carrying
 * multi-byte text is not a cursor this API issued, and the field checks below
 * reject it.
 */
function decodeBase64Url(value: string): string | null {
  let accumulator = 0;
  let bits = 0;
  let decoded = '';

  for (const character of value) {
    if (character === '=') continue;
    const index = BASE64_ALPHABET.indexOf(
      character === '+' ? '-' : character === '/' ? '_' : character,
    );
    if (index < 0) return null;

    accumulator = (accumulator << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      decoded += String.fromCharCode((accumulator >> bits) & 0xff);
    }
  }

  return decoded;
}

export function isAuditCursor(value: string): boolean {
  try {
    const decoded = decodeBase64Url(value);
    if (decoded === null) return false;

    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const { occurredAt, id } = parsed as { occurredAt?: unknown; id?: unknown };
    return (
      typeof occurredAt === 'string' &&
      typeof id === 'string' &&
      id !== '' &&
      !Number.isNaN(Date.parse(occurredAt))
    );
  } catch {
    return false;
  }
}

export const auditCursorSchema = z
  .string()
  .trim()
  .max(500)
  .refine(isAuditCursor, { message: 'Malformed cursor' });

export const listAuditLogsQuerySchema = auditLogFiltersSchema
  .extend({
    /**
     * J6's numbered pager. docs/03 says "cursor only, no offset anywhere";
     * J6's footer says "1–10 of 3,412 events" with prev/next, which a cursor
     * cannot serve. Both forms are accepted and `cursor` is the documented
     * one — see the router for the full reasoning.
     */
    page: z.coerce.number().int().min(1).max(MAX_AUDIT_PAGE).optional(),
    cursor: auditCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((value) => value.page === undefined || value.cursor === undefined, {
    path: ['cursor'],
    message: 'Use page or cursor, not both',
  });

/**
 * The CSV export takes the filters and nothing else.
 *
 * Zod strips unknown keys, so the `page` and `limit` the page happens to put
 * on the export link are dropped rather than rejected: an export is the whole
 * filtered set, bounded by the server's own row cap.
 */
export const exportAuditLogsQuerySchema = auditLogFiltersSchema;

export type AuditLogFilters = z.infer<typeof auditLogFiltersSchema>;
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;
