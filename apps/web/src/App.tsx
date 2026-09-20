import { Route, Routes } from 'react-router';
import { AppShell } from './components/app-shell.js';
import { RequireAuth } from './auth/guards.js';
import { publicRoutes } from './routes/public/routes.js';
import { authRoutes } from './routes/auth/routes.js';
import { analyticsRoutes } from './routes/analytics/routes.js';
import { audienceCollectionsRoutes } from './routes/audience/collections-routes.js';
import { audiencePipelineRoutes } from './routes/audience/pipeline-routes.js';
import { templatesRoutes } from './routes/templates/routes.js';
import { campaignsRoutes } from './routes/campaigns/routes.js';
import { poolsRoutes } from './routes/pools/routes.js';
import { providersRoutes } from './routes/providers/routes.js';
import { billingRoutes } from './routes/billing/routes.js';
import { settingsWorkspaceRoutes } from './routes/settings/workspace-routes.js';
import { settingsPlatformRoutes } from './routes/settings/platform-routes.js';
import { systemRoutes } from './routes/system/routes.js';

/**
 * The route table, composed from one fragment per section.
 *
 * Every <Route> used to be declared here, which made this file the one place
 * ten teams all had to edit — and therefore the one place they all
 * conflicted. Each section now owns a `routes.tsx` exporting a fragment of
 * <Route> elements, and this file only says where each fragment sits
 * relative to the others. React Router flattens fragments when it builds the
 * route tree, so `{audienceRoutes}` behaves exactly as if the routes were
 * written inline.
 *
 * Order is the only thing decided here, and only two parts of it matter:
 * the authenticated sections sit inside the RequireAuth + AppShell layout
 * route, and the system fragment's "*" comes last.
 */
export function App() {
  return (
    <Routes>
      {publicRoutes}
      {authRoutes}

      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        {analyticsRoutes}
        {audienceCollectionsRoutes}
        {audiencePipelineRoutes}
        {templatesRoutes}
        {campaignsRoutes}
        {poolsRoutes}
        {providersRoutes}
        {billingRoutes}
        {settingsWorkspaceRoutes}
        {settingsPlatformRoutes}
      </Route>

      {systemRoutes}
    </Routes>
  );
}
