import type { Route } from '../state.js';
import { state } from '../state.js';
import { billingOverview } from '../data/billing.js';
import { SCENARIOS, baseWorkspacePatch, scenarioFrom } from '../data/system.js';

/**
 * Section K demo routes: the system states.
 *
 * DEMO ONLY. Section K adds no endpoint of its own — every K frame is a
 * *condition* on endpoints other sections already serve. So instead of
 * routes, this file patches the two records the shell reads, once, when the
 * demo server is installed:
 *
 *   GET /workspaces/current   the enforcement state and the alerts (K1, K2)
 *   GET /billing              the matching billing state
 *
 * Which patch is applied comes from `?demo=` in the URL, read once at
 * install. The scenarios are:
 *
 *   ?demo=past_due          K1a — card declined, sending continues
 *   ?demo=restricted        K1b — 18 days overdue, launches blocked
 *   ?demo=suspended         K1c + K2 — read-only workspace
 *   ?demo=new_cap           K1d — 500/day for the first 7 days
 *   ?demo=complaint_pause   K1e — campaign auto-paused at 0.34%
 *   ?demo=provider_failed   K1f — SendGrid credentials rejected
 *
 * With no `?demo=` the workspace is healthy, which is what every other
 * section's frames are drawn in.
 *
 * `routes` stays empty and is concatenated last, so nothing here can shadow
 * a section's own pattern.
 */

function applyScenario(): void {
  Object.assign(state.workspace, baseWorkspacePatch);

  const key = scenarioFrom(typeof window === 'undefined' ? '' : window.location.search);
  if (key === null) return;

  const scenario = SCENARIOS[key];
  Object.assign(state.workspace, scenario.workspace);
  Object.assign(billingOverview.state, scenario.billing);
}

applyScenario();

export const routes: Route[] = [];

/**
 * SPA paths the demo smoke test walks for this section.
 *
 * The two `/system/*` paths are K3 and K4d on their own; `/not-a-page` is
 * A4, which is every unmatched path. The banner states are the same
 * `/dashboard` with a query string, so they are not listed here — visit
 * `/dashboard?demo=suspended` (and the five others above) to see them.
 */
export const previewPaths: string[] = ['/system/locked', '/system/error', '/not-a-page'];
