import { Outlet, Route } from 'react-router';
import { RequirePermission } from '../../auth/guards.js';
import { PoolsPage } from './list.js';
import { PoolDrawer } from './pool-drawer.js';

/**
 * Section H, sending pools.
 *
 * The drawer is a route over the list rather than a piece of its state: H1b
 * is a URL a customer can be sent, and a refresh in the middle of picking
 * members should not throw the pool away. Both drawer routes render the list
 * behind them, so closing is a navigation back to `/pools` and the table is
 * already there.
 *
 * `/pools/new` is declared before `/pools/:id` so the literal segment wins.
 *
 * Everything is behind `provider:read`, which every role holds; `provider:write`
 * is checked control by control inside the pages, because a pool is sending
 * infrastructure and the person who may build a campaign is not necessarily
 * the person who may decide which provider accounts it goes out through
 * (apps/api/src/routes/pools.ts).
 */
export const poolsRoutes = (
  <Route
    element={
      <RequirePermission permission="provider:read">
        <Outlet />
      </RequirePermission>
    }
  >
    <Route path="/pools" element={<PoolsPage />} />
    <Route
      path="/pools/new"
      element={
        <>
          <PoolsPage />
          <PoolDrawer mode="create" />
        </>
      }
    />
    <Route
      path="/pools/:id"
      element={
        <>
          <PoolsPage />
          <PoolDrawer mode="edit" />
        </>
      }
    />
  </Route>
);
