import { Link, Navigate, Outlet, Route, Routes } from 'react-router';
import { useAuth } from './auth/AuthProvider.js';
import { RequireAnonymous, RequireAuth } from './auth/guards.js';
import {
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from './routes/auth-pages.js';
import { TeamSettingsPage, WorkspaceSettingsPage } from './routes/settings-pages.js';

/**
 * Phase 1 routes only: authentication and workspace settings. Audience,
 * campaigns, analytics and billing arrive with the phases that own them.
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
        <Route path="/settings/workspace" element={<WorkspaceSettingsPage />} />
        <Route path="/settings/team" element={<TeamSettingsPage />} />
      </Route>

      <Route path="/" element={<Navigate to="/settings/workspace" replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

/**
 * The authenticated shell: workspace switcher and navigation.
 *
 * Renders an Outlet so nested routes appear inside it.
 */
function AppShell() {
  const { memberships, currentWorkspaceId, switchWorkspace, logout, current } = useAuth();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-4">
            <span className="text-sm font-semibold text-slate-900">Relayd</span>

            {memberships.length > 1 ? (
              <>
                <label className="sr-only" htmlFor="workspace-switcher">
                  Current workspace
                </label>
                <select
                  id="workspace-switcher"
                  value={currentWorkspaceId ?? ''}
                  onChange={(event) => switchWorkspace(event.target.value)}
                  className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                >
                  {memberships.map((membership) => (
                    <option key={membership.workspaceId} value={membership.workspaceId}>
                      {membership.workspaceName}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <span className="text-sm text-slate-600">{current?.workspaceName}</span>
            )}
          </div>

          <nav className="flex items-center gap-4 text-sm">
            <Link to="/settings/workspace" className="text-slate-600 hover:text-slate-900">
              Workspace
            </Link>
            <Link to="/settings/team" className="text-slate-600 hover:text-slate-900">
              Team
            </Link>
            <button
              type="button"
              onClick={() => void logout()}
              className="text-slate-600 hover:text-slate-900"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>

      <Outlet />
    </div>
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
