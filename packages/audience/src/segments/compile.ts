import type { SegmentNode } from './ast.js';
import { parseSegmentAst } from './ast.js';

/**
 * Compiles a validated AST into parameterised SQL.
 *
 * Two rules, and the whole design follows from them:
 *
 *   No user value is ever concatenated into the SQL string. Every one becomes
 *   a positional parameter. The only text this function interpolates is
 *   produced by this function.
 *
 *   No predicate crosses a workspace boundary. The workspace is a parameter
 *   applied at the top level AND inside every subquery, so a compiled fragment
 *   is safe even if RLS is somehow not in force — the same defence-in-depth
 *   the repositories use.
 */

export interface CompiledSegment {
  /** A boolean SQL expression over the `contacts` alias `c`. */
  where: string;
  params: unknown[];
}

const COMPARATOR_SQL: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  lt: '<',
};

class Compiler {
  readonly params: unknown[] = [];

  constructor(private readonly workspaceId: string) {}

  /** Appends a parameter and returns its placeholder. */
  private bind(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  compile(node: SegmentNode): string {
    switch (node.op) {
      case 'and':
        return `(${node.children.map((child) => this.compile(child)).join(' AND ')})`;

      case 'or':
        return `(${node.children.map((child) => this.compile(child)).join(' OR ')})`;

      case 'not':
        // COALESCE, because NOT NULL is NULL, not TRUE. Without it a contact
        // whose attribute is absent silently fails a negated predicate that
        // the user plainly meant to include them in.
        return `(NOT COALESCE(${this.compile(node.child)}, FALSE))`;

      case 'status':
        return `(c.status = ${this.bind(node.value)})`;

      case 'domain':
        // Matches ix_contacts_domain (workspace_id, email_domain).
        return `(c.email_domain = ${this.bind(node.value)})`;

      case 'in_list':
        // The workspace predicate is repeated inside the subquery on purpose:
        // a fragment that is only safe because of its caller is not safe.
        return `(EXISTS (
          SELECT 1 FROM contact_list_members m
           WHERE m.contact_id = c.id
             AND m.workspace_id = ${this.bind(this.workspaceId)}
             AND m.list_id = ${this.bind(node.listId)}
        ))`;

      case 'has_tag':
        return `(EXISTS (
          SELECT 1 FROM contact_tags t
           WHERE t.contact_id = c.id
             AND t.workspace_id = ${this.bind(this.workspaceId)}
             AND t.tag_id = ${this.bind(node.tagId)}
        ))`;

      case 'attr':
        return this.compileAttribute(node);
    }
  }

  private compileAttribute(node: Extract<SegmentNode, { op: 'attr' }>): string {
    // The path is bound as a parameter, never interpolated, even though the
    // schema already restricts it to an identifier-shaped string. Two
    // independent defences, because one of them will eventually be relaxed by
    // someone who does not know why it was tight.
    const path = this.bind(node.path);

    switch (node.cmp) {
      case 'exists':
        return `(c.attributes ? ${path})`;

      case 'not_exists':
        return `(NOT (c.attributes ? ${path}))`;

      case 'contains':
        // Case-insensitive substring. The pattern is built by the database
        // from a bound parameter, so a value containing % or _ cannot widen
        // the match — the ESCAPE clause makes them literal.
        return `(c.attributes ->> ${path} ILIKE '%' || replace(replace(${this.bind(
          String(node.value ?? ''),
        )}, '%', '\\%'), '_', '\\_') || '%' ESCAPE '\\')`;

      case 'gt':
      case 'lt': {
        // Numeric comparison only when the stored value actually looks
        // numeric; otherwise Postgres raises on the cast and one bad row
        // fails the whole preview.
        const operator = COMPARATOR_SQL[node.cmp];
        return `(
          c.attributes ->> ${path} ~ '^-?[0-9]+(\\.[0-9]+)?$'
          AND (c.attributes ->> ${path})::numeric ${operator} ${this.bind(
            Number(node.value),
          )}::numeric
        )`;
      }

      case 'eq':
      case 'neq': {
        const operator = COMPARATOR_SQL[node.cmp];
        return `(c.attributes ->> ${path} ${operator} ${this.bind(String(node.value))})`;
      }
    }
  }
}

/**
 * Compiles a segment definition for one workspace.
 *
 * Returns a boolean expression over `contacts c`, plus the parameters in
 * order. The caller supplies the FROM clause and its own workspace and
 * soft-delete predicates, so this fragment can be reused for a preview count,
 * a page of results, or a campaign snapshot without three copies of the
 * compiler.
 */
export function compileSegment(
  definition: unknown,
  workspaceId: string,
): CompiledSegment {
  const ast = parseSegmentAst(definition);
  const compiler = new Compiler(workspaceId);
  const where = compiler.compile(ast);
  return { where, params: compiler.params };
}

/**
 * A preview count, capped.
 *
 * docs/02 requires a preview to return in under two seconds, and BUILD-PLAN
 * requires "a hard count cap". Counting a subquery limited to cap + 1 rows
 * means a segment matching four million contacts costs the same as one
 * matching the cap, and the caller can tell "exactly N" from "more than N"
 * by whether the result exceeded the cap.
 */
export function compilePreviewCount(
  definition: unknown,
  workspaceId: string,
  cap = 10_000,
): { sql: string; params: unknown[]; cap: number } {
  const compiled = compileSegment(definition, workspaceId);
  const params = [...compiled.params];

  params.push(workspaceId);
  const workspaceParam = `$${params.length}`;
  params.push(cap + 1);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT count(*)::int AS matched
      FROM (
        SELECT 1
          FROM contacts c
         WHERE c.workspace_id = ${workspaceParam}
           AND c.deleted_at IS NULL
           AND ${compiled.where}
         LIMIT ${limitParam}
      ) capped
  `;

  return { sql, params, cap };
}
