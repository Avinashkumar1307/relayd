import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router';
import { NAV, Shell, type LinkProps, type ShellWorkspace } from '@relayd/ui';
import { useAuth } from '../auth/AuthProvider.js';

/**
 * The authenticated shell, wired to this app.
 *
 * `@relayd/ui`'s Shell is router-agnostic: it takes a Link component and the
 * current path. This is the one place those are supplied, so every page
 * inside the shell gets the same sidebar, top bar and banner slot without
 * knowing how navigation works.
 *
 * What is mocked for now, and where it will come from:
 *
 *   plan and usage       — the billing overview query (Phase 8), not yet
 *                          wired to the shell
 *   banner               — the workspace's enforcement / dunning state
 *                          (Phases 8 and 11), read from one query
 *   initials             — the profile (J5), once it exists as a query
 *
 * Each is a single prop on Shell, so wiring it is a change here, not there.
 */

function AppLink({ href, children, onClick, ...rest }: LinkProps) {
  return (
    <RouterLink to={href} onClick={onClick} {...rest}>
      {children}
    </RouterLink>
  );
}

/** Two letters from a workspace name: "Northwind Voyages" → "NV". */
export function monogramFor(name: string): string {
  const words = name.trim().split(/\s+/u).filter((word) => word !== '');
  const letters = words.length >= 2 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : name.slice(0, 2);
  return letters.toUpperCase();
}

/** The page's name for the breadcrumb, from the navigation it belongs to. */
export function breadcrumbFor(pathname: string): string {
  for (const group of NAV) {
    for (const item of group.items) {
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return item.label;
    }
  }
  return 'Dashboard';
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
};

export function AppShell() {
  const { memberships, current, switchWorkspace, logout, can } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const workspaces: ShellWorkspace[] = memberships.map((membership) => ({
    id: membership.workspaceId,
    name: membership.workspaceName,
    monogram: monogramFor(membership.workspaceName),
    plan: 'Pro',
    role: ROLE_LABEL[membership.role] ?? membership.role,
  }));

  const workspace =
    workspaces.find((candidate) => candidate.id === current?.workspaceId) ??
    workspaces[0] ??
    ({ id: '', name: 'Workspace', monogram: 'WS', plan: '—', role: '—' } satisfies ShellWorkspace);

  // Billing is owner-only (CLAUDE.md section 11); the frame shows it locked
  // for everyone else rather than hidden.
  const nav = can('billing:write')
    ? NAV
    : NAV.map((group) => ({
        ...group,
        items: group.items.map((item) => (item.key === 'billing' ? { ...item, locked: true } : item)),
      }));

  return (
    <Shell
      workspace={workspace}
      workspaces={workspaces}
      onSwitchWorkspace={switchWorkspace}
      user={{ name: 'You', initials: 'DH' }}
      currentPath={pathname}
      breadcrumb={breadcrumbFor(pathname)}
      Link={AppLink}
      nav={nav}
      canCreate={can('campaign:write')}
      onCreate={() => navigate('/campaigns/new')}
      onSignOut={() => void logout()}
    >
      <Outlet />
    </Shell>
  );
}
