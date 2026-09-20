import { Outlet, Route } from 'react-router';
import { RequirePermission } from '../../auth/guards.js';
import { ApiKeysPage, NewApiKeyPage } from './api-keys.js';
import { WebhookDeliveriesPage, WebhooksPage } from './webhooks.js';

/**
 * Section J parts 3 and 4, the platform settings: API keys and outbound
 * webhooks — the machine-facing half of settings.
 *
 * Everything here is behind `apikey:write`, which is what `apps/api` guards
 * both routers with (apps/api/src/routes/api-keys.ts and
 * outbound-webhooks.ts). There is no read-only view of either: the list of
 * keys is a map of what a workspace has integrated, and the signing secrets
 * belong with the people who can change them. A member without it gets the
 * K3 locked page, which says which permission is missing, rather than a
 * page of dashes or a 404 for something they can see in the sidebar.
 *
 * /settings/webhooks/:id is the list with J4b's drawer over it rather than a
 * page of its own, so closing the drawer is a back navigation and the row
 * behind it never disappears. /settings/webhooks/:id/deliveries is a real
 * page: it is where somebody lands from an alert and it needs its own URL.
 */
export const settingsPlatformRoutes = (
  <Route
    element={
      <RequirePermission permission="apikey:write">
        <Outlet />
      </RequirePermission>
    }
  >
    <Route path="/settings/api" element={<ApiKeysPage />} />
    <Route path="/settings/api/new" element={<NewApiKeyPage />} />
    <Route path="/settings/webhooks" element={<WebhooksPage />} />
    <Route path="/settings/webhooks/:id" element={<WebhooksPage />} />
    <Route path="/settings/webhooks/:id/deliveries" element={<WebhookDeliveriesPage />} />
  </Route>
);
