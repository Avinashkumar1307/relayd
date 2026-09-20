import { useState } from 'react';
import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  BANNERS,
  NAV,
  Shell,
  type BannerKey,
  type LinkProps,
  type ShellBanner,
  type ShellUsage,
  type ShellWorkspace,
} from '@relayd/ui';
import { useAuth } from '../auth/AuthProvider.js';
import { useWorkspaceRecord, type WorkspaceRecord } from '../auth/workspace-state.js';
import { billingApi, type UsageRow } from '../api/billing.js';
import { RouteErrorBoundary } from '../routes/system/error-page.js';

/**
 * The authenticated shell, wired to this app.
 *
 * `@relayd/ui`'s Shell is router-agnostic: it takes a Link component and the
 * current path. This is the one place those are supplied, so every page
 * inside the shell gets the same sidebar, top bar and banner slot without
 * knowing how navigation works.
 *
 * Three things the shell shows are decided here rather than there, because
 * all three are questions about this workspace and none is a question about
 * layout:
 *
 *   the banner   — K1a–K1f, chosen from the workspace's enforcement state
 *                  and its alerts, through the `BANNERS` contracts
 *   the usage    — GET /billing/usage, the emails row
 *   read-only    — K2, from `useReadOnly()`'s source
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

/**
 * The page's name for the breadcrumb, from the navigation it belongs to.
 *
 * The frames write it as group then page — "Sending / Campaigns",
 * "Audience / Contacts", "Settings / Billing" (K2, K4a, I1c) — with the
 * workspace before it, which the shell adds. Overview is the exception: its
 * one item is drawn alone, as "Northwind Voyages / Dashboard" (K1a, K4b).
 */
export function breadcrumbFor(pathname: string): string {
  for (const group of NAV) {
    for (const item of group.items) {
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
        return group.label === 'Overview' ? item.label : `${group.label} / ${item.label}`;
      }
    }
  }
  // Pages the navigation does not list, because they are reached from
  // somewhere else: the profile from the sidebar's user row, the segment
  // builder from Segments, the connect wizard from Providers. Falling back to
  // "Dashboard" put the wrong name above every one of them.
  for (const [prefix, label] of OFF_NAV) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return label;
  }
  return 'Dashboard';
}

const OFF_NAV: readonly (readonly [string, string])[] = [
  ['/settings/profile', 'Settings / Profile & security'],
  ['/providers/connect', 'Delivery / Connect provider'],
  ['/get-started', 'Get started'],
];

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
};

/* ------------------------------------------------------------------ */
/* K1 — which banner, and where its action goes                        */
/* ------------------------------------------------------------------ */

/**
 * The severity order the sheet asks for: "One at a time, highest severity
 * wins."
 *
 * Danger before warning before info, and within a tone the order K1 lists
 * them (`BANNER_ORDER`). The three billing states are mutually exclusive by
 * construction — a workspace has one enforcement state — so the only real
 * contests are between a billing state and an abuse or delivery one, and
 * losing the ability to send outranks being told about a cap.
 */
const SEVERITY: readonly BannerKey[] = [
  'suspended',
  'provider_failed',
  'past_due',
  'restricted',
  'complaint_pause',
  'new_cap',
];

/**
 * Where each banner's action leads.
 *
 * The label is the design's (`BANNERS[key].actionLabel`); the route is the
 * app's, because a campaign id is not the design's to know.
 */
function hrefFor(key: BannerKey, workspace: WorkspaceRecord | undefined): string {
  const alerts = workspace?.alerts;

  switch (key) {
    case 'past_due':
    case 'restricted':
    case 'suspended':
      return '/billing';
    case 'complaint_pause':
      return alerts?.complaintPause === undefined
        ? '/campaigns'
        : `/campaigns/${alerts.complaintPause.campaignId}`;
    case 'provider_failed':
      return '/providers';
    case 'new_cap':
      // BACKEND PENDING: there is no docs route in this build, so K1d's
      // "How caps work" points at the workspace settings page, which is
      // where the cap is described.
      return '/settings/workspace';
  }
}

/** Every banner this workspace currently qualifies for. */
function raisedBanners(workspace: WorkspaceRecord | undefined): BannerKey[] {
  if (workspace === undefined) return [];

  const keys: BannerKey[] = [];
  const status = workspace.status ?? 'active';

  if (status === 'past_due') keys.push('past_due');
  if (status === 'restricted') keys.push('restricted');
  if (status === 'suspended') keys.push('suspended');

  const alerts = workspace.alerts;
  if (alerts?.newAccountCap !== undefined) keys.push('new_cap');
  if (alerts?.complaintPause !== undefined) keys.push('complaint_pause');
  if (alerts?.providerFailure !== undefined) keys.push('provider_failed');

  return keys;
}

function bannerFor(workspace: WorkspaceRecord | undefined): ShellBanner | null {
  const raised = raisedBanners(workspace);
  const key = SEVERITY.find((candidate) => raised.includes(candidate));
  if (key === undefined) return null;

  const definition = BANNERS[key];
  return {
    tone: definition.tone,
    icon: definition.icon,
    title: definition.title,
    body: definition.body,
    action: { label: definition.actionLabel, href: hrefFor(key, workspace) },
  };
}

/* ------------------------------------------------------------------ */
/* The sidebar's usage block                                           */
/* ------------------------------------------------------------------ */

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Renews 1 Oct · 12 days left" — the frame's line, from the period end. */
function renewsLabel(periodEnd: string, now: Date = new Date()): string {
  const end = new Date(periodEnd);
  if (Number.isNaN(end.getTime())) return '';

  const days = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000));
  const date = `${end.getUTCDate()} ${MONTH[end.getUTCMonth()] ?? ''}`;
  return `Renews ${date} · ${days} ${days === 1 ? 'day' : 'days'} left`;
}

function usageFor(rows: UsageRow[] | undefined): ShellUsage | undefined {
  const emails = rows?.find((row) => row.featureKey === 'emails.sent');
  // An unlimited allowance has no bar to draw: a percentage of unlimited is
  // not a number, and the sidebar's block is entirely that percentage.
  if (emails === undefined || emails.included === null) return undefined;

  return { used: emails.used, limit: emails.included, renewsLabel: renewsLabel(emails.periodEnd) };
}

/* ------------------------------------------------------------------ */

export function AppShell() {
  const { memberships, current, switchWorkspace, logout, can, user } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(0);

  const workspaceQuery = useWorkspaceRecord();
  const record = workspaceQuery.data;

  // Both are owner/admin reads; an editor gets a 403 and the shell simply
  // draws no usage block rather than an empty one.
  const enabled = can('billing:read');
  const usageQuery = useQuery({
    queryKey: [current?.workspaceId ?? 'none', 'billing', 'usage'],
    queryFn: () => billingApi.usage(),
    staleTime: 60_000,
    retry: false,
    enabled,
  });
  const overviewQuery = useQuery({
    queryKey: [current?.workspaceId ?? 'none', 'billing', 'overview'],
    queryFn: () => billingApi.overview(),
    staleTime: 60_000,
    retry: false,
    enabled,
  });

  const planName = overviewQuery.data?.subscription?.planName ?? '—';

  const workspaces: ShellWorkspace[] = memberships.map((membership) => ({
    id: membership.workspaceId,
    name: membership.workspaceName,
    monogram: monogramFor(membership.workspaceName),
    // BACKEND PENDING: the membership list carries no plan, so only the
    // workspace we are actually in can name one.
    plan: membership.workspaceId === current?.workspaceId ? planName : '—',
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

  const usage = usageFor(usageQuery.data);
  const banner = bannerFor(record);
  const readOnly = (record?.status ?? 'active') === 'suspended';
  const breadcrumb = breadcrumbFor(pathname);

  return (
    <Shell
      workspace={workspace}
      workspaces={workspaces}
      onSwitchWorkspace={switchWorkspace}
      user={{
        // The session only carries a user against the preview backend for
        // now (AuthProvider.SessionUser, BACKEND PENDING), so fall back to
        // the address and then to something that is at least not a name.
        name: user?.name ?? user?.email ?? 'Your account',
        initials: monogramFor(user?.name ?? user?.email ?? 'Relayd user'),
      }}
      currentPath={pathname}
      breadcrumb={breadcrumb}
      Link={AppLink}
      nav={nav}
      {...(usage === undefined ? {} : { usage })}
      banner={banner}
      readOnly={readOnly}
      hasAlerts={(record?.alertCount ?? 0) > 0 || banner !== null}
      canCreate={can('campaign:write')}
      onCreate={() => {
        void navigate('/campaigns/new');
      }}
      onSignOut={() => void logout()}
    >
      <RouteErrorBoundary
        resetKey={pathname}
        title={breadcrumb}
        onRetry={() => setAttempt((value) => value + 1)}
      >
        <Outlet key={attempt} />
      </RouteErrorBoundary>
    </Shell>
  );
}
