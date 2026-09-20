import { Navigate, Outlet, Route } from 'react-router';
import { RequirePermission } from '../../auth/guards.js';
import { BillingPage } from './overview.js';
import { PlansPage } from './plans.js';
import { CheckoutCancelledPage, CheckoutHandoffPage, CheckoutSuccessPage } from './checkout.js';
import { InvoicesPage } from './invoices.js';
import { PaymentMethodPage } from './payment-method.js';
import { CancelSubscriptionPage } from './cancel-subscription.js';

/**
 * Section I, billing.
 *
 * Everything under /billing is behind `billing:read`, so an Editor gets the
 * K3 locked page rather than a half-rendered screen full of dashes.
 * `billing:write` is owner-only and is checked control by control inside the
 * pages, because an Admin can legitimately read the invoice history and
 * cannot legitimately move money (CLAUDE.md section 11).
 *
 * /billing/checkout, /billing/success and /billing/cancel are the three
 * pages around Stripe Checkout, and they are inside the authenticated
 * layout on purpose: the success page polls our own API until the
 * webhook-derived row exists rather than trusting the redirect (CLAUDE.md
 * section 10), and that poll needs a session.
 *
 * /billing/subscription/cancel was this app's original path for the cancel
 * page. The design calls it /billing/cancel-subscription, so the old one
 * redirects: a link in somebody's tab or an email should not 404 because a
 * route was renamed.
 */
export const billingRoutes = (
  <Route
    element={
      <RequirePermission permission="billing:read">
        <Outlet />
      </RequirePermission>
    }
  >
    <Route path="/billing" element={<BillingPage />} />
    <Route path="/billing/plans" element={<PlansPage />} />
    <Route path="/billing/checkout" element={<CheckoutHandoffPage />} />
    <Route path="/billing/success" element={<CheckoutSuccessPage />} />
    <Route path="/billing/cancel" element={<CheckoutCancelledPage />} />
    <Route path="/billing/invoices" element={<InvoicesPage />} />
    <Route path="/billing/payment-method" element={<PaymentMethodPage />} />
    <Route path="/billing/cancel-subscription" element={<CancelSubscriptionPage />} />
    <Route
      path="/billing/subscription/cancel"
      element={<Navigate to="/billing/cancel-subscription" replace />}
    />
  </Route>
);
