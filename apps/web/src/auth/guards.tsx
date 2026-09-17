import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { Permission } from '@relayd/types';
import { useAuth } from './AuthProvider.js';

/**
 * Route guards.
 *
 * These hide and redirect; they do not secure anything. Every one of these
 * decisions is made again on the server, which is the one that counts
 * (CLAUDE.md section 10: "Entitlement checks are server-side only"). A user
 * who edits their way past a guard reaches an endpoint that returns 403.
 */

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <FullPageSpinner />;

  if (status === 'anonymous') {
    // Remember where they were headed so login can return them there.
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return <>{children}</>;
}

export function RequireAnonymous({ children }: { children: ReactNode }) {
  const { status } = useAuth();

  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'authenticated') return <Navigate to="/settings/workspace" replace />;

  return <>{children}</>;
}

/**
 * Renders children only if the current role holds the permission.
 *
 * Use for controls, not for secrets: anything rendered is in the bundle
 * regardless. This stops a viewer being shown a Delete button they cannot
 * use, which is a usability fix, not a security boundary.
 */
export function IfPermitted({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can } = useAuth();
  return <>{can(permission) ? children : fallback}</>;
}

export function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const { can, status } = useAuth();

  if (status === 'loading') return <FullPageSpinner />;
  if (!can(permission)) return <NotPermitted permission={permission} />;

  return <>{children}</>;
}

function FullPageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center" role="status" aria-live="polite">
      <span className="text-sm text-slate-500">Loading…</span>
    </div>
  );
}

function NotPermitted({ permission }: { permission: Permission }) {
  return (
    <div className="mx-auto max-w-lg px-6 py-16 text-center">
      <h1 className="text-lg font-semibold text-slate-900">You do not have access to this</h1>
      <p className="mt-2 text-sm text-slate-600">
        This page needs the <code className="rounded bg-slate-100 px-1">{permission}</code>{' '}
        permission. An owner or admin of this workspace can change your role.
      </p>
    </div>
  );
}
