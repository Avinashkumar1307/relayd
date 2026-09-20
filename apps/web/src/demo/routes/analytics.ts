import type { Route } from '../state.js';
import {
  campaignAnalytics,
  campaignProviders,
  dashboard,
  devices,
  hourly,
  links,
  overview,
  providerStats,
} from '../data/analytics.js';

/**
 * Section C demo routes: the dashboard, the workspace report and the
 * campaign report.
 *
 * DEMO ONLY. Read-only by nature — analytics is a projection, so there is
 * nothing here to mutate.
 *
 * Order matters within the section: `/analytics/campaigns/:id` would
 * otherwise swallow `/analytics/campaigns/:id/links`, so the bare pattern is
 * declared last.
 */
export const routes: Route[] = [
  { method: 'GET', pattern: /^\/analytics\/overview$/u, handler: () => overview },
  { method: 'GET', pattern: /^\/analytics\/dashboard$/u, handler: () => dashboard },
  { method: 'GET', pattern: /^\/analytics\/providers$/u, handler: () => providerStats },
  { method: 'GET', pattern: /^\/analytics\/campaigns\/([^/]+)\/timeseries$/u, handler: () => hourly },
  { method: 'GET', pattern: /^\/analytics\/campaigns\/([^/]+)\/links$/u, handler: () => ({ links }) },
  { method: 'GET', pattern: /^\/analytics\/campaigns\/([^/]+)\/devices$/u, handler: () => devices },
  { method: 'GET', pattern: /^\/analytics\/campaigns\/([^/]+)\/providers$/u, handler: () => campaignProviders },
  {
    method: 'GET',
    pattern: /^\/analytics\/campaigns\/([^/]+)$/u,
    handler: (match) => ({ ...campaignAnalytics, campaignId: match[1] ?? campaignAnalytics.campaignId }),
  },
];

/** SPA paths the demo smoke test walks for this section. */
export const previewPaths: string[] = [
  '/dashboard',
  '/reports',
  '/campaigns/cmp_7q1m9z/analytics',
];
