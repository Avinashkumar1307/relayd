import { Route } from 'react-router';
import { RequireAnonymous, RequireAuth } from '../../auth/guards.js';
import { AppShell } from '../../components/app-shell.js';
import { LoginPage } from './login.js';
import { RegisterPage } from './register.js';
import { VerifyEmailPage } from './verify-email.js';
import { ForgotPasswordPage } from './forgot-password.js';
import { ResetPasswordPage } from './reset-password.js';
import { AcceptInvitationPage } from './accept-invitation.js';
import { CreateWorkspacePage } from './create-workspace.js';
import { GetStartedPage } from './get-started.js';

/**
 * Section B, authentication and onboarding.
 *
 * Almost all of it sits outside the RequireAuth + AppShell layout: a
 * signed-out user has to be able to reach every one of these. Sign-in and
 * register additionally turn a signed-in user away, so a stale bookmark
 * lands on the app rather than on a form.
 *
 * Three of them are deliberately *not* RequireAnonymous. Verifying an
 * address, following a reset link and opening an invitation all happen from
 * an email, and the person opening that email may well already have a
 * session in the tab — B5a is drawn for exactly that case. Bouncing them to
 * the dashboard would break the flow the link exists for.
 *
 * /get-started (B6b) is the exception in the other direction: it is a page
 * of the app, inside the shell, and the frame draws it with the sidebar,
 * the breadcrumb and the new-account cap banner. It is declared with its own
 * layout route here rather than in App.tsx, which composes one fragment per
 * section and places this one outside the shell.
 */
export const authRoutes = (
  <>
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

    <Route path="/verify" element={<VerifyEmailPage />} />
    {/* The path this app shipped with before the frames named it /verify. */}
    <Route path="/verify-email" element={<VerifyEmailPage />} />

    <Route path="/forgot-password" element={<ForgotPasswordPage />} />
    {/* Both link shapes: the frame's path parameter and the ?token= form
        older reset emails carry. The page reads either. */}
    <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
    <Route path="/reset-password" element={<ResetPasswordPage />} />

    <Route path="/invite/:token" element={<AcceptInvitationPage />} />
    <Route
      path="/workspaces/new"
      element={
        <RequireAuth>
          <CreateWorkspacePage />
        </RequireAuth>
      }
    />

    <Route
      element={
        <RequireAuth>
          <AppShell />
        </RequireAuth>
      }
    >
      <Route path="/get-started" element={<GetStartedPage />} />
    </Route>
  </>
);
