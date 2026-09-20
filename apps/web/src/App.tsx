import { Link, Navigate, Route, Routes } from 'react-router';
import { AppShell } from './components/app-shell.js';
import { RequireAnonymous, RequireAuth } from './auth/guards.js';
import {
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from './routes/auth-pages.js';
import { TeamSettingsPage, WorkspaceSettingsPage } from './routes/settings-pages.js';
import { ApiSettingsPage } from './routes/settings/api.js';
import { ContactsPage } from './routes/audience/contacts.js';
import { ListsPage, SuppressionsPage, TagsPage } from './routes/audience/collections.js';
import { ImportsPage } from './routes/audience/imports.js';
import {
  CreateTemplatePage,
  TemplateEditorPage,
  TemplatesPage,
} from './routes/templates/templates.js';
import {
  CampaignAnalyticsPage,
  DashboardPage,
} from './routes/analytics/analytics.js';
import {
  CampaignWizardPage,
  CampaignsPage,
  CreateCampaignPage,
} from './routes/campaigns/campaigns.js';
import { ProvidersPage } from './routes/providers/providers.js';
import { SendersPage } from './routes/providers/senders.js';
import {
  BillingPage,
  CancelSubscriptionPage,
  CheckoutCancelPage,
  CheckoutSuccessPage,
  InvoicesPage,
  PlansPage,
} from './routes/billing/billing.js';

/**
 * Phases 1 to 8: authentication, workspace settings, audience, provider
 * connections, templates, campaigns, analytics and billing.
 */
export function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <RequireAnonymous>
            <LoginPage />
          </RequireAnonymous>
        }
      />
      <Route
        path="/register"
        element={
          <RequireAnonymous>
            <RegisterPage />
          </RequireAnonymous>
        }
      />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/audience/contacts" element={<ContactsPage />} />
        <Route path="/audience/lists" element={<ListsPage />} />
        <Route path="/audience/tags" element={<TagsPage />} />
        <Route path="/audience/imports" element={<ImportsPage />} />
        <Route path="/audience/suppressions" element={<SuppressionsPage />} />

        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/templates/create" element={<CreateTemplatePage />} />
        <Route path="/templates/:id" element={<TemplateEditorPage />} />

        <Route path="/dashboard" element={<DashboardPage />} />

        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/campaigns/new" element={<CreateCampaignPage />} />
        <Route path="/campaigns/:id" element={<CampaignWizardPage />} />
        <Route path="/campaigns/:id/analytics" element={<CampaignAnalyticsPage />} />

        <Route path="/providers" element={<ProvidersPage />} />
        <Route path="/senders" element={<SendersPage />} />

        <Route path="/billing" element={<BillingPage />} />
        <Route path="/billing/plans" element={<PlansPage />} />
        <Route path="/billing/success" element={<CheckoutSuccessPage />} />
        <Route path="/billing/cancel" element={<CheckoutCancelPage />} />
        <Route path="/billing/invoices" element={<InvoicesPage />} />
        <Route path="/billing/subscription/cancel" element={<CancelSubscriptionPage />} />

        <Route path="/settings/workspace" element={<WorkspaceSettingsPage />} />
        <Route path="/settings/team" element={<TeamSettingsPage />} />
        <Route path="/settings/api" element={<ApiSettingsPage />} />
      </Route>

      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/audience" element={<Navigate to="/audience/contacts" replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function NotFound() {
  return (
    <main className="mx-auto max-w-lg px-6 py-16 text-center">
      <h1 className="text-lg font-semibold text-slate-900">Page not found</h1>
      <p className="mt-2 text-sm text-slate-600">
        <Link to="/" className="underline">
          Go back
        </Link>
      </p>
    </main>
  );
}
