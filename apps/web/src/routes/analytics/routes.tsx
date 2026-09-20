import { Route } from 'react-router';
import { DashboardPage } from './dashboard.js';
import { ReportsPage } from './reports.js';
import { CampaignAnalyticsPage } from './campaign.js';

/**
 * Section C, analytics: the dashboard, the workspace report and the
 * per-campaign report.
 *
 * `/campaigns/:id/analytics` lives under the campaigns path but is owned
 * here, not by the campaigns section, because it is built from the analytics
 * API and shares its rate, confidence and bot-filtering rendering.
 *
 * `/reports` is the destination the sidebar has always linked to. It has no
 * frame of its own; see the note at the top of `reports.tsx`.
 */
export const analyticsRoutes = (
  <>
    <Route path="/dashboard" element={<DashboardPage />} />
    <Route path="/reports" element={<ReportsPage />} />
    <Route path="/campaigns/:id/analytics" element={<CampaignAnalyticsPage />} />
  </>
);
