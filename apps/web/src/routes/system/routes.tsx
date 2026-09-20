import { Route } from 'react-router';
import { AppShell } from '../../components/app-shell.js';
import { RequireAuth } from '../../auth/guards.js';
import { NotFound } from './not-found.js';
import { ErrorPreviewPage } from './error-page.js';
import { LockedPreviewPage } from './locked-page.js';

/**
 * Section K: the system states, and whatever has to be last.
 *
 * "*" only wins when nothing else matched, so App.tsx composes this after
 * every section. Owning it here means a section adding routes never has to
 * think about where the catch-all sits.
 *
 * The two `/system/*` routes are how K3 and K4d are reachable on their own.
 * Both states normally arrive through something else — a role that cannot
 * open a page, a query that failed — and neither is a place a user
 * navigates to, so they exist for the design comparison and for anyone
 * checking the two states without having to break a page to see them. They
 * sit inside the shell because that is how both frames draw them.
 */
export const systemRoutes = (
  <>
    <Route
      element={
        <RequireAuth>
          <AppShell />
        </RequireAuth>
      }
    >
      <Route path="/system/locked" element={<LockedPreviewPage />} />
      <Route path="/system/error" element={<ErrorPreviewPage />} />
    </Route>

    <Route path="*" element={<NotFound />} />
  </>
);
