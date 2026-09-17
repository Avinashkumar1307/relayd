import { z } from 'zod';

/**
 * The segment AST.
 *
 * docs/02: "Segments are stored as a validated JSON AST and compiled to SQL
 * server-side. Never store user SQL." BUILD-PLAN Phase 2: "a fixed set of
 * predicates with preview count. No general query builder."
 *
 * Fixed is the security property. A general query builder is a SQL injection
 * surface with extra steps and an unbounded cost surface — someone eventually
 * writes a predicate that table-scans forty million rows during a launch. Every
 * leaf below maps to an index that migration 0005 actually creates.
 */

/** docs/02: "a hard cap on AST depth (6) and node count (40)". */
export const MAX_DEPTH = 6;
export const MAX_NODES = 40;

const uuidish = z.string().min(1).max(64);

/**
 * Attribute paths address a single top-level key of the jsonb column.
 *
 * Deliberately not a path expression. A dotted or bracketed path would need a
 * parser, and a parser over user input that ends up adjacent to SQL is the
 * thing this whole design exists to avoid. One key, matched against a
 * conservative character class.
 */
const attributePath = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'Attribute names are letters, digits and underscores');

const comparator = z.enum(['eq', 'neq', 'contains', 'gt', 'lt', 'exists', 'not_exists']);

const attributeValue = z.union([z.string().max(512), z.number(), z.boolean()]);

const contactStatus = z.enum([
  'subscribed',
  'unsubscribed',
  'bounced',
  'complained',
  'cleaned',
]);

export type SegmentNode =
  | { op: 'and'; children: SegmentNode[] }
  | { op: 'or'; children: SegmentNode[] }
  | { op: 'not'; child: SegmentNode }
  | { op: 'in_list'; listId: string }
  | { op: 'has_tag'; tagId: string }
  | { op: 'status'; value: z.infer<typeof contactStatus> }
  | { op: 'domain'; value: string }
  | {
      op: 'attr';
      path: string;
      cmp: z.infer<typeof comparator>;
      // Explicitly `| undefined`: under exactOptionalPropertyTypes a bare
      // `value?: T` forbids an explicit undefined, which is exactly what
      // Zod's .optional() produces.
      value?: string | number | boolean | undefined;
    };

const leaf = z.discriminatedUnion('op', [
  z.object({ op: z.literal('in_list'), listId: uuidish }).strict(),
  z.object({ op: z.literal('has_tag'), tagId: uuidish }).strict(),
  z.object({ op: z.literal('status'), value: contactStatus }).strict(),
  z
    .object({ op: z.literal('domain'), value: z.string().min(1).max(253).toLowerCase() })
    .strict(),
  z
    .object({
      op: z.literal('attr'),
      path: attributePath,
      cmp: comparator,
      value: attributeValue.optional(),
    })
    .strict(),
]);

/**
 * Comparators that operate on presence alone. Everything else needs a value,
 * checked during the bounding walk rather than as a Zod refinement — a
 * discriminated union cannot carry an effect, and the better error messages a
 * discriminated union gives are worth more than the refinement.
 */
const VALUELESS_COMPARATORS = new Set(['exists', 'not_exists']);

// Input is declared as unknown: this parses arbitrary JSON from a request
// body, and constraining the input type to SegmentNode would make the
// recursive reference fail to typecheck against itself.
export const segmentNodeSchema: z.ZodType<SegmentNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    z.object({ op: z.literal('and'), children: z.array(segmentNodeSchema).min(1) }).strict(),
    z.object({ op: z.literal('or'), children: z.array(segmentNodeSchema).min(1) }).strict(),
    z.object({ op: z.literal('not'), child: segmentNodeSchema }).strict(),
    leaf,
  ]),
);

export class SegmentAstError extends Error {
  override readonly name = 'SegmentAstError';
}

/** Depth and node count, measured before anything is compiled. */
export function measure(node: SegmentNode): { depth: number; nodes: number } {
  let nodes = 0;

  const walk = (current: SegmentNode, depth: number): number => {
    nodes += 1;
    if (nodes > MAX_NODES) {
      throw new SegmentAstError(`Segment has more than ${MAX_NODES} conditions`);
    }
    if (depth > MAX_DEPTH) {
      throw new SegmentAstError(`Segment is nested more than ${MAX_DEPTH} levels deep`);
    }

    switch (current.op) {
      case 'and':
      case 'or':
        return Math.max(...current.children.map((child) => walk(child, depth + 1)));
      case 'not':
        return walk(current.child, depth + 1);
      case 'attr':
        if (!VALUELESS_COMPARATORS.has(current.cmp) && current.value === undefined) {
          throw new SegmentAstError(`The "${current.cmp}" comparator requires a value`);
        }
        return depth;
      default:
        return depth;
    }
  };

  return { depth: walk(node, 1), nodes };
}

/**
 * Parses and bounds an AST.
 *
 * The caps are checked here rather than in the compiler, so an oversized
 * definition is refused at save time instead of being stored and then failing
 * every time someone opens the segment.
 */
export function parseSegmentAst(input: unknown): SegmentNode {
  const parsed = segmentNodeSchema.safeParse(input);

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new SegmentAstError(
      first === undefined
        ? 'Segment definition is not valid'
        : `${first.path.join('.') || 'definition'}: ${first.message}`,
    );
  }

  measure(parsed.data);
  return parsed.data;
}
