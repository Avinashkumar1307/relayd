/**
 * Path helpers for the architecture rules.
 *
 * Every rule here is a path-scoped ban: a construct is legal in one directory
 * and illegal everywhere else. That makes correct path handling the whole
 * game, and the repository is developed on Windows and built on Linux CI, so
 * separators are normalised before any comparison. A rule that silently
 * stopped matching on one platform would be worse than no rule at all.
 */

/** @param {string} filename */
export function normalize(filename) {
  return filename.replace(/\\/gu, '/');
}

/**
 * True when `filename` sits under any of `patterns`.
 * @param {string} filename
 * @param {readonly RegExp[]} patterns
 */
export function isUnder(filename, patterns) {
  const normalized = normalize(filename);
  return patterns.some((pattern) => pattern.test(normalized));
}

/**
 * Directories that may hold Drizzle calls (CLAUDE.md section 7). Both layouts
 * are accepted because CLAUDE.md section 3 writes the path without `src/`
 * while INVARIANTS R11 writes a sibling package's path with it.
 */
export const DB_REPOSITORY_DIRS = [/\/packages\/db\/(src\/)?repositories\//u];

/** The only place plan codes may appear (CLAUDE.md section 7). */
export const BILLING_PLAN_DIRS = [/\/packages\/billing\/(src\/)?plans\//u];

/** Email provider SDKs are confined here (docs/13). */
export const EMAIL_ADAPTER_DIRS = [/\/packages\/email-providers\/(src\/)?adapters\//u];

/** The Stripe SDK is confined here (docs/13). */
export const BILLING_ADAPTER_DIRS = [/\/packages\/billing\/(src\/)?adapters\//u];

/** The only sanctioned reader of process.env (CLAUDE.md section 7). */
export const CONFIG_DIRS = [/\/packages\/config\//u];

/** no-console applies to application and package source only. */
export const APP_AND_PACKAGE_DIRS = [/\/apps\//u, /\/packages\//u];
