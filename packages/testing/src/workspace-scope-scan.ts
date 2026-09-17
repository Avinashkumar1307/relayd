import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * INVARIANTS R36 — workspace scope is set in exactly one place, and only with
 * transaction-local semantics.
 *
 * Two forms are forbidden anywhere in the codebase:
 *
 *   SET app.workspace_id = ...                      (session-scoped)
 *   set_config('app.workspace_id', ..., false)      (is_local = false)
 *
 * The second is identical in effect to the first and completely invisible to
 * a grep for "SET", which is what the invariant originally specified. Under
 * PgBouncer transaction pooling either one survives past COMMIT and is handed
 * to the next tenant to borrow the connection.
 */

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sql']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.turbo', 'coverage', '.git', '.husky']);

/** The only file permitted to set workspace scope. */
export const SCOPE_OWNER = 'packages/db/src/scope.ts';

export type ViolationKind =
  | 'bare-set'
  | 'set-config-session'
  | 'scope-write-outside-owner';

export interface ScopeViolation {
  file: string;
  line: number;
  kind: ViolationKind;
  text: string;
}

/**
 * `SET app.workspace_id` and `SET SESSION app.workspace_id`, but not
 * `SET LOCAL app.workspace_id`.
 */
const BARE_SET = /\bset\s+(?!local\b)(?:session\s+)?["'`]?app\.workspace_id/giu;

/** set_config('app.workspace_id', <anything>, false) */
const SET_CONFIG_SESSION =
  /set_config\s*\(\s*["'`]app\.workspace_id["'`]\s*,[\s\S]*?,\s*false\s*\)/giu;

/** Any write of app.workspace_id, transaction-local or not. */
const SCOPE_WRITES = [
  /set_config\s*\(\s*["'`]app\.workspace_id["'`]/giu,
  /\bset\s+(?:local\s+|session\s+)?["'`]?app\.workspace_id/giu,
];

/**
 * Blanks out comments while preserving every byte offset and newline, so
 * reported line numbers stay correct.
 *
 * Comments are excluded because they legitimately discuss the forbidden
 * forms — scope.ts explains at length why a bare SET is banned, and that
 * explanation must not trip the scanner that enforces it.
 */
export function blankComments(source: string): string {
  const blank = (match: string): string =>
    match.replace(/[^\n]/gu, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, blank)
    .replace(/(?:--|\/\/)[^\n]*/gu, blank);
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/** Scans one file's contents. `relativePath` uses forward slashes. */
export function scanSource(relativePath: string, source: string): ScopeViolation[] {
  const code = blankComments(source);
  const violations: ScopeViolation[] = [];

  const record = (kind: ViolationKind, index: number, text: string): void => {
    violations.push({ file: relativePath, line: lineOf(code, index), kind, text: text.trim() });
  };

  for (const match of code.matchAll(BARE_SET)) {
    record('bare-set', match.index ?? 0, match[0]);
  }

  for (const match of code.matchAll(SET_CONFIG_SESSION)) {
    record('set-config-session', match.index ?? 0, match[0]);
  }

  if (relativePath !== SCOPE_OWNER) {
    for (const pattern of SCOPE_WRITES) {
      for (const match of code.matchAll(pattern)) {
        record('scope-write-outside-owner', match.index ?? 0, match[0]);
      }
    }
  }

  return violations;
}

/** Every scannable file under the given roots, relative to `repoRoot`. */
export async function collectSourceFiles(
  repoRoot: string,
  roots: readonly string[],
): Promise<string[]> {
  const found: string[] = [];

  const walk = async (absolute: string): Promise<void> => {
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await walk(path.join(absolute, entry.name));
      } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
        found.push(path.relative(repoRoot, path.join(absolute, entry.name)).replaceAll(path.sep, '/'));
      }
    }
  };

  for (const root of roots) {
    await walk(path.join(repoRoot, root));
  }

  return found.sort();
}

export async function scanRepository(
  repoRoot: string,
  roots: readonly string[] = ['apps', 'packages'],
): Promise<{ files: string[]; violations: ScopeViolation[] }> {
  const files = await collectSourceFiles(repoRoot, roots);
  const violations: ScopeViolation[] = [];

  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    violations.push(...scanSource(file, source));
  }

  return { files, violations };
}
