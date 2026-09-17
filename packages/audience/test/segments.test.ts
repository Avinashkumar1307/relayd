import { describe, expect, it } from 'vitest';
import {
  MAX_DEPTH,
  MAX_NODES,
  SegmentAstError,
  parseSegmentAst,
} from '../src/segments/ast.js';
import { compilePreviewCount, compileSegment } from '../src/segments/compile.js';

const WS = 'workspace-1';

const compile = (definition: unknown) => compileSegment(definition, WS);

describe('AST validation', () => {
  it('accepts the shape docs/02 documents', () => {
    const definition = {
      op: 'and',
      children: [
        { op: 'in_list', listId: 'list-1' },
        { op: 'not', child: { op: 'has_tag', tagId: 'tag-1' } },
        { op: 'attr', path: 'country', cmp: 'eq', value: 'AE' },
      ],
    };
    expect(() => parseSegmentAst(definition)).not.toThrow();
  });

  it('rejects an unknown operator rather than ignoring it', () => {
    expect(() => parseSegmentAst({ op: 'raw_sql', sql: 'DROP TABLE contacts' })).toThrow(
      SegmentAstError,
    );
  });

  it('rejects unknown keys, so an extra field cannot ride along', () => {
    expect(() =>
      parseSegmentAst({ op: 'in_list', listId: 'l', extra: 'anything' }),
    ).toThrow(SegmentAstError);
  });

  it('rejects an attribute path that is not an identifier', () => {
    for (const path of ['a.b', "a'b", 'a;b', 'a b', '1abc', '', 'a)--']) {
      expect(() => parseSegmentAst({ op: 'attr', path, cmp: 'eq', value: 'x' }), path).toThrow(
        SegmentAstError,
      );
    }
  });

  it('requires a value for comparators that need one', () => {
    expect(() => parseSegmentAst({ op: 'attr', path: 'country', cmp: 'eq' })).toThrow(
      /requires a value/u,
    );
  });

  it('allows the presence comparators without a value', () => {
    expect(() => parseSegmentAst({ op: 'attr', path: 'country', cmp: 'exists' })).not.toThrow();
  });

  it('caps nesting depth', () => {
    let node: unknown = { op: 'status', value: 'subscribed' };
    for (let i = 0; i < MAX_DEPTH + 2; i += 1) node = { op: 'not', child: node };
    expect(() => parseSegmentAst(node)).toThrow(/nested more than/u);
  });

  it('caps node count', () => {
    const children = Array.from({ length: MAX_NODES + 5 }, () => ({
      op: 'status',
      value: 'subscribed',
    }));
    expect(() => parseSegmentAst({ op: 'and', children })).toThrow(/more than 40 conditions/u);
  });

  it('rejects an empty boolean group', () => {
    expect(() => parseSegmentAst({ op: 'and', children: [] })).toThrow(SegmentAstError);
  });
});

describe('compilation never concatenates user input', () => {
  /** Every value a caller could control, in one segment. */
  const hostile = {
    op: 'and',
    children: [
      { op: 'in_list', listId: "'; DROP TABLE contacts; --" },
      { op: 'has_tag', tagId: "' OR 1=1 --" },
      { op: 'status', value: 'subscribed' },
      { op: 'attr', path: 'country', cmp: 'eq', value: "'; DELETE FROM contacts; --" },
    ],
  };

  it('puts every value in a parameter, never in the SQL text', () => {
    const { where, params } = compile(hostile);

    expect(where).not.toContain('DROP TABLE');
    expect(where).not.toContain('DELETE FROM');
    expect(where).not.toContain('OR 1=1');
    expect(params).toContain("'; DROP TABLE contacts; --");
    expect(params).toContain("' OR 1=1 --");
  });

  it('emits only placeholders and SQL the compiler itself wrote', () => {
    const { where } = compile(hostile);
    // No single quotes at all except the two the ILIKE wildcards need, which
    // this segment does not use.
    expect(where).not.toMatch(/'[^']*DROP/iu);
    expect(where).toMatch(/\$\d+/u);
  });

  it('numbers parameters contiguously from 1', () => {
    const { where, params } = compile(hostile);
    const used = [...where.matchAll(/\$(\d+)/gu)].map((m) => Number(m[1]));
    expect(Math.min(...used)).toBe(1);
    expect(Math.max(...used)).toBe(params.length);
  });

  it('binds the attribute path too, not just the value', () => {
    // The schema already restricts the path, but two independent defences
    // means relaxing one does not open a hole.
    const { where, params } = compile({ op: 'attr', path: 'country', cmp: 'exists' });
    expect(where).not.toContain('country');
    expect(params).toContain('country');
  });
});

describe('workspace scoping', () => {
  it('binds the workspace inside every subquery, not only at the top', () => {
    const { where, params } = compile({
      op: 'or',
      children: [
        { op: 'in_list', listId: 'list-1' },
        { op: 'has_tag', tagId: 'tag-1' },
      ],
    });

    // Two subqueries, each with its own workspace parameter.
    expect(where.match(/m\.workspace_id = \$\d+/gu)).toHaveLength(1);
    expect(where.match(/t\.workspace_id = \$\d+/gu)).toHaveLength(1);
    expect(params.filter((p) => p === WS)).toHaveLength(2);
  });
});

describe('semantics that are easy to get wrong', () => {
  it('treats NOT over a null predicate as true, not null', () => {
    // NOT NULL is NULL in SQL, so without COALESCE a contact missing the
    // attribute silently fails a negation the user meant to include them in.
    const { where } = compile({
      op: 'not',
      child: { op: 'attr', path: 'country', cmp: 'eq', value: 'AE' },
    });
    expect(where).toContain('COALESCE');
  });

  it('escapes wildcards in a contains value', () => {
    const { where, params } = compile({
      op: 'attr',
      path: 'plan',
      cmp: 'contains',
      value: '100%',
    });
    // The pattern is assembled by the database from a bound parameter, and
    // % and _ are neutralised so they cannot widen the match.
    expect(where).toContain('ESCAPE');
    expect(where).toContain('replace');
    expect(params).toContain('100%');
  });

  it('guards a numeric comparison against non-numeric stored values', () => {
    // One row holding "n/a" would otherwise fail the cast and take the whole
    // preview down with it.
    const { where } = compile({ op: 'attr', path: 'score', cmp: 'gt', value: 10 });
    expect(where).toContain('~');
    expect(where).toContain('::numeric');
  });

  it('uses the generated email_domain column, which an index covers', () => {
    const { where } = compile({ op: 'domain', value: 'Example.COM' });
    expect(where).toContain('c.email_domain');
  });

  it('lowercases a domain before binding it', () => {
    const { params } = compile({ op: 'domain', value: 'Example.COM' });
    expect(params).toContain('example.com');
  });
});

describe('preview count', () => {
  it('caps the scan so a huge segment costs the same as a small one', () => {
    const { sql, params, cap } = compilePreviewCount(
      { op: 'status', value: 'subscribed' },
      WS,
      500,
    );

    expect(sql).toContain('LIMIT');
    expect(cap).toBe(500);
    // cap + 1, so the caller can tell "exactly 500" from "more than 500".
    expect(params).toContain(501);
  });

  it('applies the workspace and soft-delete predicates itself', () => {
    const { sql } = compilePreviewCount({ op: 'status', value: 'subscribed' }, WS);
    expect(sql).toContain('c.workspace_id =');
    expect(sql).toContain('c.deleted_at IS NULL');
  });

  it('keeps parameter numbering valid after appending its own', () => {
    const { sql, params } = compilePreviewCount(
      {
        op: 'and',
        children: [
          { op: 'in_list', listId: 'l' },
          { op: 'attr', path: 'country', cmp: 'eq', value: 'AE' },
        ],
      },
      WS,
    );

    const used = [...sql.matchAll(/\$(\d+)/gu)].map((m) => Number(m[1]));
    expect(new Set(used).size).toBe(params.length);
    expect(Math.max(...used)).toBe(params.length);
  });
});
