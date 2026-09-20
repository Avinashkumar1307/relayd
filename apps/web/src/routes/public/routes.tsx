import { Navigate, Route } from 'react-router';
import { useAuth } from '../../auth/AuthProvider.js';
import { PublicPage } from './chrome.js';
import { LandingPage } from './landing-page.js';
import { PricingPage } from './pricing-page.js';

/**
 * Section A, the public pages.
 *
 * Each section owns one fragment like this so twelve teams can add routes in
 * parallel without touching App.tsx or each other's files. React Router
 * flattens fragments inside <Routes>, so App.tsx can render `{publicRoutes}`
 * as a direct child.
 *
 * A3 Unsubscribe (/u/:token) is not here: it is served by `apps/edge`,
 * which has to answer without the SPA's JavaScript or its session. A4 Not
 * found belongs to section K, with the rest of the system states.
 */

/**
 * "/" is two pages.
 *
 * The design's section note is explicit — "Signed-in users are redirected to
 * /dashboard" — so the root is the A1 landing for an anonymous visitor and a
 * redirect for everyone else. Nothing is rendered while the session is still
 * being restored: a signed-in user reloading the app should not see a
 * marketing page flash before the dashboard.
 */
function LandingOrDashboard() {
  const { status } = useAuth();

  if (status === 'loading') return <div className="min-h-screen bg-bg" aria-hidden="true" />;
  if (status === 'authenticated') return <Navigate to="/dashboard" replace />;

  return (
    <PublicPage>
      <LandingPage />
    </PublicPage>
  );
}

export const publicRoutes = (
  <>
    <Route path="/" element={<LandingOrDashboard />} />
    <Route
      path="/pricing"
      element={
        <PublicPage footer="compact">
          <PricingPage />
        </PublicPage>
      }
    />
  </>
);
