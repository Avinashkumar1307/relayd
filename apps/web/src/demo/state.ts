/**
 * The demo backend's shared vocabulary and its in-memory store.
 *
 * DEMO ONLY — loaded only when `VITE_DEMO=1`.
 *
 * Split out of `server.ts` so each section's route file can import the
 * pieces it needs without importing every other section's routes. Mutations
 * apply to the copies held here, so the flow is clickable: creating a list
 * adds a row, revoking a key greys it out, launching a campaign moves it to
 * `sending`. Reload and it all goes back.
 */

import * as audience from './data/audience.js';
import * as imports from './data/imports.js';
import * as templates from './data/templates.js';
import * as campaigns from './data/campaigns.js';
import * as providers from './data/providers.js';
import * as platform from './data/platform.js';
import * as workspaceData from './data/workspace.js';

export interface Route {
  method: string;
  /** Matched against the path after `/api/v1`. */
  pattern: RegExp;
  handler: (match: RegExpMatchArray, body: unknown) => unknown;
  /** Answer with the list envelope (`data` + `meta`) rather than `{ data }`. */
  paged?: boolean;
}

/**
 * A demo row.
 *
 * Deliberately loose. The fixtures are object literals, so TypeScript infers
 * the narrowest possible type from each — `color: string` from one entry
 * that happens to be non-null — and every mutation would then need a cast.
 * The real types live in `src/api/*.ts` and are what the pages are checked
 * against; this harness only has to hand back plausible JSON.
 */
export type Row = Record<string, unknown> & { id: string };

/** Deep copies, so a mutation cannot corrupt the fixture for the next reload. */
export const clone = (value: unknown): Row[] => JSON.parse(JSON.stringify(value)) as Row[];

interface DemoState {
  contacts: Row[];
  lists: Row[];
  tags: Row[];
  suppressions: Row[];
  imports: Row[];
  templates: Row[];
  campaigns: Row[];
  connections: Row[];
  senders: Row[];
  apiKeys: Row[];
  webhookEndpoints: Row[];
  team: Row[];
  workspace: Row;
}

export const state: DemoState = {
  contacts: clone(audience.contacts),
  lists: clone(audience.lists),
  tags: clone(audience.tags),
  suppressions: clone(audience.suppressions),
  imports: clone(imports.imports),
  templates: clone(templates.templates),
  campaigns: clone(campaigns.campaigns),
  connections: clone(providers.connections),
  senders: clone(providers.senders),
  apiKeys: clone(platform.apiKeys),
  webhookEndpoints: clone(platform.webhookEndpoints),
  team: clone(workspaceData.team),
  workspace: JSON.parse(JSON.stringify(workspaceData.workspace)) as Row,
};

const collections = new Map<string, Row[]>();

/**
 * A named mutable collection, cloned from its seed on first use.
 *
 * `state` above is the original set, and every field in it is a field
 * twelve sections share a file to declare. A section that needs its own
 * store — pools, segments, whatever lands next — calls this instead and
 * touches nobody else's file:
 *
 *     const pools = collection('pools', () => POOL_FIXTURES);
 *
 * Memoised by name, so every handler in a section sees the same array
 * across requests. Because the array identity is what is remembered,
 * removals have to mutate it (`splice`, or `length = 0` then `push`)
 * rather than rebind a local.
 */
export function collection(name: string, seed: () => unknown[]): Row[] {
  const existing = collections.get(name);
  if (existing !== undefined) return existing;

  const rows = clone(seed());
  collections.set(name, rows);
  return rows;
}

let nextId = 1000;

/** A fresh id with the prefix the real ids of that kind use. */
export const id = (prefix: string): string => `${prefix}${(nextId += 1)}`;

export const nowIso = (): string => new Date().toISOString();

export const find = (rows: Row[], wanted: string): Row | undefined =>
  rows.find((row) => row.id === wanted);
