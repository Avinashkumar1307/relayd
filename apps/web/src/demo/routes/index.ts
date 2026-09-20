import type { Route } from '../state.js';
import * as publicSection from './public.js';
import * as auth from './auth.js';
import * as workspace from './workspace.js';
import * as audience from './audience.js';
import * as imports from './imports.js';
import * as segments from './segments.js';
import * as templates from './templates.js';
import * as campaigns from './campaigns.js';
import * as pools from './pools.js';
import * as analytics from './analytics.js';
import * as providers from './providers.js';
import * as billing from './billing.js';
import * as platform from './platform.js';
import * as system from './system.js';

/**
 * Every section's demo routes, in one table.
 *
 * DEMO ONLY — loaded only when `VITE_DEMO=1`.
 *
 * The sections are imported by name, including the ones that are still
 * empty, so adding an endpoint means editing exactly one file — the
 * section's own — and never this one. Section order only matters within a
 * section (the first matching pattern wins, and several sections rely on a
 * literal segment being declared before a dynamic one); across sections the
 * path prefixes are disjoint, so the order below is just the order of the
 * app.
 */
const SECTIONS = [
  publicSection,
  auth,
  workspace,
  audience,
  imports,
  segments,
  templates,
  campaigns,
  pools,
  analytics,
  providers,
  billing,
  platform,
  system,
];

export const ROUTES: Route[] = SECTIONS.flatMap((section) => section.routes);

/**
 * The SPA paths `demo-smoke.test.tsx` renders.
 *
 * Collected the same way, so a section that adds a page adds it to the
 * smoke test by editing its own file.
 */
export const PREVIEW_PATHS: string[] = SECTIONS.flatMap((section) => section.previewPaths);
