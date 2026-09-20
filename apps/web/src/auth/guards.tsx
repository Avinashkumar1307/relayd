import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { Permission } from '@relayd/types';
import { DashboardSkeleton, DetailSkeleton, Skeleton, TableSkeleton } from '@relayd/ui';
import { useAuth } from './AuthProvider.js';
import { LockedPage } from '../routes/system/locked-page.js';

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

  if (status === 'loading') return <RouteSkeleton pathname={location.pathname} />;

  if (status === 'anonymous') {
    // Remember where they were headed so login can return them there.
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return <>{children}</>;
}

export function RequireAnonymous({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <RouteSkeleton pathname={location.pathname} />;
  // The dashboard, not workspace settings: this redirect was written in
  // phase 1, when /settings/workspace was the only page there was.
  if (status === 'authenticated') return <Navigate to="/dashboard" replace />;

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

/**
 * A whole page a role cannot open: K3, the locked page.
 *
 * Not a 404 — this user is a member of the workspace and the page exists;
 * hiding it would leave them guessing. A *non-member* is the other case and
 * gets A4 (CLAUDE.md section 11: 404, never 403).
 */
export function RequirePermission({
  permission,
  children,
  fallback,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode | undefined;
}) {
  const { can, status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <RouteSkeleton pathname={location.pathname} />;
  if (!can(permission)) return <>{fallback ?? <LockedPage permission={permission} />}</>;

  return <>{children}</>;
}

/* ------------------------------------------------------------------ */
/* K4a / K4b / K4c — the skeleton that matches where we are going      */
/* ------------------------------------------------------------------ */

/** Sections whose `/:id` route is a detail page (K4c), not another list. */
const DETAIL_PARENTS = ['/campaigns', '/templates', '/pools', '/providers', '/audience/lists', '/audience/segments'];

/**
 * The right skeleton for the route being restored.
 *
 * The sheet's rule is "shapes match the final layout so nothing jumps", and
 * the three compositions in `@relayd/ui` are the three shapes the app has.
 * Picking by path is the only information available while the session is
 * still being traded for — the page component has not mounted yet — and it
 * is enough: the dashboard, a detail page and everything else.
 */
export function RouteSkeleton({ pathname }: { pathname: string }) {
  return (
    <div className="min-h-screen bg-bg text-text">
      <div className="mx-auto w-full max-w-[1280px] px-4 pt-7 pb-10 md:px-8">
        <div className="mb-5 flex flex-col gap-2">
          <Skeleton width={200} height={24} radius={6} />
          <Skeleton width={280} height={14} />
        </div>
        <Body pathname={pathname} />
      </div>
    </div>
  );
}

function Body({ pathname }: { pathname: string }) {
  if (pathname === '/dashboard' || pathname === '/') return <DashboardSkeleton />;

  const isDetail = DETAIL_PARENTS.some((parent) => {
    if (!pathname.startsWith(`${parent}/`)) return false;
    const rest = pathname.slice(parent.length + 1);
    return rest !== '' && rest !== 'new';
  });

  return isDetail ? <DetailSkeleton /> : <TableSkeleton />;
}
