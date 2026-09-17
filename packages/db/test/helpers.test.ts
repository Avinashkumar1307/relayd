import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { bindPlaceholders, suppressionHash } from '../src/helpers.js';

/**
 * Renders a SQL object exactly as the driver would receive it.
 *
 * Uses Drizzle's own dialect rather than walking its internals, so this test
 * checks the real serialisation rather than my guess at its shape.
 */
const dialect = new PgDialect();

function inspect(sql: ReturnType<typeof bindPlaceholders>): {
  text: string;
  params: unknown[];
} {
  const query = dialect.sqlToQuery(sql);
  return { text: query.sql, params: query.params };
}

describe('bindPlaceholders', () => {
  it('turns every $n into a bound parameter, not text', () => {
    const { text, params } = inspect(
      bindPlaceholders('SELECT 1 WHERE a = $1 AND b = $2', ['first', 'second']),
    );

    expect(params).toEqual(['first', 'second']);
    expect(text).not.toContain('first');
    expect(text).not.toContain('second');
  });

  it('keeps hostile values out of the SQL text entirely', () => {
    // The whole point: the segment compiler promises values are parameters,
    // and this is where that promise either survives or is quietly dropped.
    const hostile = "'; DROP TABLE contacts; --";
    const { text, params } = inspect(bindPlaceholders('SELECT 1 WHERE x = $1', [hostile]));

    expect(params).toEqual([hostile]);
    expect(text).not.toContain('DROP TABLE');
  });

  it('preserves literal SQL around the placeholders', () => {
    const { text } = inspect(bindPlaceholders('SELECT count(*) FROM t WHERE a = $1', ['x']));
    expect(text).toContain('SELECT count(*) FROM t WHERE a =');
  });

  it('handles a statement with no placeholders', () => {
    const { text, params } = inspect(bindPlaceholders('SELECT 1', []));
    expect(text).toBe('SELECT 1');
    expect(params).toEqual([]);
  });

  it('handles repeated use of the same placeholder', () => {
    const { params } = inspect(bindPlaceholders('SELECT $1, $1, $2', ['a', 'b']));
    expect(params).toEqual(['a', 'a', 'b']);
  });

  it('handles double-digit placeholders without truncating them', () => {
    // $10 must not be read as $1 followed by a literal zero.
    const values = Array.from({ length: 12 }, (_, i) => `v${i + 1}`);
    const text = values.map((_, i) => `$${i + 1}`).join(',');
    const { params } = inspect(bindPlaceholders(text, values));
    expect(params).toEqual(values);
  });

  it('refuses a placeholder with no corresponding parameter', () => {
    // Silently binding undefined would turn a compiler bug into a query that
    // runs and quietly matches nothing.
    expect(() => bindPlaceholders('SELECT $1, $2', ['only-one'])).toThrow(/only 1 parameters/u);
  });

  it('refuses $0, which is not a valid Postgres placeholder', () => {
    expect(() => bindPlaceholders('SELECT $0', ['x'])).toThrow();
  });

  it('binds null and numbers as values, not as text', () => {
    const { text, params } = inspect(bindPlaceholders('SELECT $1, $2', [null, 42]));
    expect(params).toEqual([null, 42]);
    expect(text).not.toContain('42');
  });
});

describe('suppressionHash', () => {
  it('is 32 bytes', () => {
    expect(suppressionHash('a@example.com')).toHaveLength(32);
  });

  it('ignores case, so the fast check agrees with the citext column', () => {
    expect(suppressionHash('A@Example.COM').equals(suppressionHash('a@example.com'))).toBe(true);
  });

  it('ignores surrounding whitespace', () => {
    expect(suppressionHash('  a@example.com \t').equals(suppressionHash('a@example.com'))).toBe(
      true,
    );
  });

  it('distinguishes different addresses', () => {
    expect(suppressionHash('a@example.com').equals(suppressionHash('b@example.com'))).toBe(false);
  });

  it('does not collapse addresses that differ only inside the local part', () => {
    // Plus-addressing is a different mailbox to most providers; treating
    // a+b@x.com as a@x.com would silently suppress mail the user never
    // asked to stop.
    expect(suppressionHash('a+tag@example.com').equals(suppressionHash('a@example.com'))).toBe(
      false,
    );
  });
});
