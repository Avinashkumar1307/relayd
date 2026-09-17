import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SCOPE_OWNER,
  blankComments,
  scanRepository,
  scanSource,
} from '../src/workspace-scope-scan.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The forbidden forms are assembled at runtime rather than written as literals.
 * This file is itself scanned by the repository sweep below, and a literal here
 * would be a violation of the rule it exists to enforce.
 */
const FORBIDDEN = {
  bareSet: 'SET ' + 'app.workspace_id = $1',
  sessionSet: 'SET SESSION ' + 'app.workspace_id = $1',
  setConfigFalse: 'set_config(' + "'app.workspace_id', $1, false)",
};

const ALLOWED = {
  setLocal: 'SET LOCAL ' + 'app.workspace_id = $1',
  setConfigTrue: 'set_config(' + "'app.workspace_id', $1, true)",
  read: 'current_setting(' + "'app.workspace_id', true)",
};

const kinds = (source: string, file = 'packages/campaigns/src/thing.ts'): string[] =>
  scanSource(file, source).map((v) => v.kind);

/**
 * A scanner that matches nothing is indistinguishable from a scanner that
 * works. These tests check the detector itself before it is pointed at the
 * repository.
 */
describe('R36 detector', () => {
  it('flags a bare SET', () => {
    expect(kinds(FORBIDDEN.bareSet)).toContain('bare-set');
  });

  it('flags a session-scoped SET', () => {
    expect(kinds(FORBIDDEN.sessionSet)).toContain('bare-set');
  });

  it('flags set_config with is_local false, which a grep for SET never sees', () => {
    expect(kinds(FORBIDDEN.setConfigFalse)).toContain('set-config-session');
  });

  it('accepts SET LOCAL', () => {
    expect(kinds(ALLOWED.setLocal, SCOPE_OWNER)).toEqual([]);
  });

  it('accepts set_config with is_local true', () => {
    expect(kinds(ALLOWED.setConfigTrue, SCOPE_OWNER)).toEqual([]);
  });

  it('accepts reading the setting, which RLS policies must do', () => {
    expect(kinds(ALLOWED.read, 'packages/db/migrations/0002_identity.sql')).toEqual([]);
  });

  it('flags any scope write outside the owning file', () => {
    expect(kinds(ALLOWED.setConfigTrue)).toContain('scope-write-outside-owner');
    expect(kinds(ALLOWED.setLocal)).toContain('scope-write-outside-owner');
  });

  it('ignores the forbidden forms inside comments', () => {
    // scope.ts explains at length why a bare SET is banned; that explanation
    // must not trip the scanner enforcing it.
    expect(kinds('// never write ' + FORBIDDEN.bareSet)).toEqual([]);
    expect(kinds('-- never write ' + FORBIDDEN.bareSet)).toEqual([]);
    expect(kinds('/* ' + FORBIDDEN.setConfigFalse + ' */')).toEqual([]);
  });

  it('keeps line numbers correct after blanking comments', () => {
    const source = ['// a comment', '/* two', '   lines */', FORBIDDEN.bareSet].join('\n');
    expect(scanSource('packages/x/src/a.ts', source)[0]?.line).toBe(4);
  });

  it('preserves length and newlines when blanking', () => {
    const source = 'a /* x */ b\n// y\nz';
    const blanked = blankComments(source);
    expect(blanked).toHaveLength(source.length);
    expect(blanked.split('\n')).toHaveLength(source.split('\n').length);
  });
});

describe('R36 across the repository', () => {
  it('scans a meaningful number of files', async () => {
    // Guards against a broken walker reporting a clean sweep of nothing.
    const { files } = await scanRepository(repoRoot);
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain(SCOPE_OWNER);
  });

  it('contains neither forbidden form anywhere in apps/ or packages/', async () => {
    const { violations } = await scanRepository(repoRoot);
    const forbidden = violations.filter(
      (v) => v.kind === 'bare-set' || v.kind === 'set-config-session',
    );
    expect(
      forbidden.map((v) => `${v.file}:${v.line} ${v.kind} ${v.text}`),
    ).toEqual([]);
  });

  it('sets workspace scope in exactly one file', async () => {
    const { violations } = await scanRepository(repoRoot);
    const strays = violations.filter((v) => v.kind === 'scope-write-outside-owner');
    expect(strays.map((v) => `${v.file}:${v.line} ${v.text}`)).toEqual([]);
  });
});
