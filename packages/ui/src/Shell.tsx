import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Icon, type IconName } from './icons.js';
import type { Tone } from './states.js';

/**
 * The application shell (design/Shell.dc.html; design/01 Shell + Dashboard
 * options.dc.html — committed: 1a shell, 1b bands, 1c sidebar usage).
 *
 * Everything here is the frame, measured: a 260px navy sidebar that collapses
 * to 64, a 56px top bar on the surface colour, a banner slot under it, and a
 * 1280px main column with 28/32/40 padding. The values are the export's, not
 * approximations — where a number appears below it was read off the frame.
 *
 * ## Router-agnostic on purpose
 *
 * The shell takes a `Link` component and `currentPath` rather than importing
 * React Router. `packages/ui` is presentational (docs/09: "presentational
 * only"), and the one thing that would make it impossible to render in a
 * test without a router is a router import.
 */

export interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: IconName;
  /** Shown with a lock and not navigable: billing for non-owners. */
  locked?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * The navigation, in the export's order and grouping (Shell.dc.html `NAV`).
 *
 * Kept as data so a test can assert it matches the design file, and so the
 * sidebar and any mobile drawer render the same list from the same place.
 */
export const NAV: readonly NavGroup[] = [
  { label: 'Overview', items: [{ key: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: 'dashboard' }] },
  {
    label: 'Audience',
    items: [
      { key: 'contacts', label: 'Contacts', href: '/audience/contacts', icon: 'contacts' },
      { key: 'lists', label: 'Lists', href: '/audience/lists', icon: 'lists' },
      { key: 'tags', label: 'Tags', href: '/audience/tags', icon: 'tags' },
      { key: 'segments', label: 'Segments', href: '/audience/segments', icon: 'segments' },
      { key: 'imports', label: 'Imports', href: '/audience/imports', icon: 'imports' },
      { key: 'suppressions', label: 'Suppressions', href: '/audience/suppressions', icon: 'suppressions' },
    ],
  },
  {
    label: 'Sending',
    items: [
      { key: 'campaigns', label: 'Campaigns', href: '/campaigns', icon: 'campaigns' },
      { key: 'templates', label: 'Templates', href: '/templates', icon: 'templates' },
      { key: 'pools', label: 'Sending Pools', href: '/pools', icon: 'pools' },
    ],
  },
  {
    label: 'Delivery',
    items: [
      { key: 'providers', label: 'Providers', href: '/providers', icon: 'providers' },
      { key: 'senders', label: 'Senders', href: '/senders', icon: 'senders' },
    ],
  },
  { label: 'Analytics', items: [{ key: 'reports', label: 'Reports', href: '/reports', icon: 'reports' }] },
  {
    label: 'Settings',
    items: [
      { key: 'workspace', label: 'Workspace', href: '/settings/workspace', icon: 'workspace' },
      { key: 'team', label: 'Team', href: '/settings/team', icon: 'team' },
      { key: 'api', label: 'API Keys', href: '/settings/api', icon: 'api' },
      { key: 'webhooks', label: 'Webhooks', href: '/settings/webhooks', icon: 'webhooks' },
      { key: 'billing', label: 'Billing', href: '/billing', icon: 'billing' },
      { key: 'audit', label: 'Audit Log', href: '/settings/audit', icon: 'audit' },
    ],
  },
];

export interface ShellWorkspace {
  id: string;
  name: string;
  /** Two letters, e.g. "NV". */
  monogram: string;
  plan: string;
  role: string;
}

export interface ShellUser {
  name: string;
  initials: string;
}

export interface ShellUsage {
  used: number;
  limit: number;
  /** "Renews 1 Oct · 12 days left" */
  renewsLabel: string;
}

export interface ShellBanner {
  tone: Extract<Tone, 'warning' | 'danger' | 'info'>;
  icon: IconName;
  title: string;
  body: string;
  action?: { label: string; href: string } | undefined;
}

export interface LinkProps {
  href: string;
  className?: string | undefined;
  style?: React.CSSProperties | undefined;
  title?: string | undefined;
  'aria-current'?: 'page' | undefined;
  children: ReactNode;
  onClick?: (() => void) | undefined;
}

export interface ShellProps {
  workspace: ShellWorkspace;
  workspaces: ShellWorkspace[];
  onSwitchWorkspace: (id: string) => void;
  user: ShellUser;
  currentPath: string;
  breadcrumb: string;
  Link?: ComponentType<LinkProps>;
  nav?: readonly NavGroup[];
  usage?: ShellUsage | undefined;
  banner?: ShellBanner | null | undefined;
  /** Suspended workspaces: the top bar says so and creation is disabled. */
  readOnly?: boolean;
  /** Viewers cannot create campaigns; the button stays, with the reason. */
  canCreate?: boolean;
  onCreate?: () => void;
  hasAlerts?: boolean;
  onSignOut?: () => void;
  children: ReactNode;
}

function DefaultLink({ href, children, ...rest }: LinkProps) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

/** The brand mark: a 28px indigo square with the send icon (the frame's logo). */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="grid flex-none place-items-center bg-brand-mark text-white"
      style={{ width: size, height: size, borderRadius: size >= 36 ? 10 : 8 }}
    >
      <Icon name="campaigns" size={Math.round(size * 0.54)} strokeWidth={2} />
    </span>
  );
}

const BANNER_LINE: Record<ShellBanner['tone'], string> = {
  warning: '#F59E0B',
  danger: '#DC2626',
  info: '#0EA5E9',
};

export function Shell({
  workspace,
  workspaces,
  onSwitchWorkspace,
  user,
  currentPath,
  breadcrumb,
  Link = DefaultLink,
  nav = NAV,
  usage,
  banner,
  readOnly = false,
  canCreate = true,
  onCreate,
  hasAlerts = false,
  onSignOut,
  children,
}: ShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  const expanded = !collapsed;

  // Close the switcher on an outside click, as the frame's popover does.
  useEffect(() => {
    if (!switcherOpen) return;
    const onDown = (event: MouseEvent) => {
      if (switcherRef.current !== null && !switcherRef.current.contains(event.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [switcherOpen]);

  const createDisabled = readOnly || !canCreate;
  const createTitle = readOnly
    ? 'Workspace is read-only'
    : !canCreate
      ? 'Viewers cannot create campaigns'
      : 'Create campaign';

  const isActive = (item: NavItem): boolean =>
    currentPath === item.href || currentPath.startsWith(`${item.href}/`);

  return (
    <div className="flex min-h-screen w-full items-stretch bg-bg text-body text-text">
      {/* ------------------------------------------------------------ sidebar */}
      <aside
        className="relative z-[2] flex flex-none flex-col bg-sidebar text-sidebar-text"
        style={{ width: collapsed ? 64 : 260 }}
        aria-label="Primary"
      >
        {/* Brand row: 56px, logo + wordmark, collapse toggle. */}
        <div
          className={
            collapsed
              ? 'flex flex-col items-center gap-1.5 pt-3.5 pb-1.5'
              : 'flex h-14 items-center justify-between pl-[18px] pr-3'
          }
        >
          <Link href="/dashboard" className="flex min-w-0 items-center gap-2.5 text-white no-underline">
            <BrandMark />
            {expanded ? (
              <span className="text-card font-semibold leading-heading tracking-heading">Relayd</span>
            ) : null}
          </Link>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={expanded}
            className="grid h-7 w-7 flex-none place-items-center rounded-badge text-sidebar-muted hover:bg-white/[.08] hover:text-white"
          >
            <Icon name="sidebar" size={16} />
          </button>
        </div>

        {/* Workspace switcher: 44px well with monogram, name, plan; popover. */}
        <div ref={switcherRef} className="relative px-3 pt-2 pb-1">
          {expanded ? (
            <button
              type="button"
              onClick={() => setSwitcherOpen((value) => !value)}
              aria-haspopup="listbox"
              aria-expanded={switcherOpen}
              className="flex h-11 w-full items-center gap-2.5 rounded-control border border-sidebar-line bg-sidebar-well px-2.5 text-left text-white hover:bg-white/[.08]"
            >
              <span className="grid h-7 w-7 flex-none place-items-center rounded-badge bg-sidebar-chip text-label font-semibold tracking-monogram">
                {workspace.monogram}
              </span>
              <span className="block min-w-0 flex-1">
                <span className="block truncate text-ui font-medium leading-[1.3]">{workspace.name}</span>
                <span className="block text-label leading-[1.3] text-sidebar-muted">{workspace.plan} plan</span>
              </span>
              <Icon name="chevronUpDown" size={14} strokeWidth={2} className="flex-none text-sidebar-muted" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setSwitcherOpen((value) => !value)}
              title={workspace.name}
              aria-label={`Workspace: ${workspace.name}`}
              className="mx-auto grid h-10 w-10 place-items-center rounded-control border border-sidebar-line bg-sidebar-well text-label font-semibold text-white hover:bg-white/[.08]"
            >
              {workspace.monogram}
            </button>
          )}

          {switcherOpen ? (
            <div
              role="listbox"
              aria-label="Workspaces"
              className="absolute left-3 top-[calc(100%+6px)] z-[60] w-[280px] rounded-card border border-border bg-surface p-1.5 text-text shadow-overlay"
            >
              <div className="px-2.5 pb-1.5 pt-2 text-label font-semibold uppercase tracking-label text-text-3">
                Workspaces
              </div>
              {workspaces.map((candidate) => {
                const current = candidate.id === workspace.id;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    role="option"
                    aria-selected={current}
                    onClick={() => {
                      setSwitcherOpen(false);
                      if (!current) onSwitchWorkspace(candidate.id);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left hover:bg-tint"
                  >
                    <span className="grid h-7 w-7 flex-none place-items-center rounded-badge bg-brand-soft text-label font-semibold text-brand">
                      {candidate.monogram}
                    </span>
                    <span className="block min-w-0 flex-1">
                      <span className="block truncate text-ui font-medium">{candidate.name}</span>
                      <span className="block text-label text-text-2">
                        {candidate.plan} plan · {candidate.role}
                      </span>
                    </span>
                    {current ? <Icon name="check" size={14} strokeWidth={2} className="text-brand" /> : null}
                  </button>
                );
              })}
              <div className="my-1 h-px bg-border" />
              <Link
                href="/workspaces/new"
                className="flex items-center gap-2.5 rounded-control px-2.5 py-2 text-ui font-medium text-brand no-underline hover:bg-tint"
              >
                <Icon name="plus" size={14} strokeWidth={2} />
                Create workspace
              </Link>
            </div>
          ) : null}
        </div>

        {/* Plan usage (option 1c): expanded only. */}
        {expanded && usage !== undefined ? (
          <div className="mx-3 mt-1 rounded-control border border-sidebar-line px-2.5 py-2">
            <div className="flex justify-between text-label text-sidebar-muted">
              <span>Plan usage</span>
              <span className="tabular-nums text-sidebar-text">
                {usage.used.toLocaleString('en-US')} / {usage.limit.toLocaleString('en-US')}
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-2 bg-white/10">
              <div
                className="h-full rounded-2 bg-[#818CF8]"
                style={{ width: `${Math.min(100, (usage.used / Math.max(1, usage.limit)) * 100).toFixed(1)}%` }}
              />
            </div>
            <div className="mt-1 text-label text-sidebar-muted">{usage.renewsLabel}</div>
          </div>
        ) : null}

        {/* Navigation. */}
        <nav className="flex-1 overflow-visible pb-2 pt-1" aria-label="Sections">
          {nav.map((group, index) => (
            <div key={group.label}>
              {expanded ? (
                <div className="px-6 pb-1 pt-3.5 text-label font-semibold uppercase tracking-label text-sidebar-muted">
                  {group.label}
                </div>
              ) : index === 0 ? null : (
                <div className="mx-[18px] my-2.5 h-px bg-sidebar-line" />
              )}
              {group.items.map((item) => {
                const active = isActive(item);
                const base = [
                  'flex h-8 items-center gap-2.5 rounded-control text-ui no-underline',
                  collapsed ? 'mx-3 my-0.5 justify-center px-0' : 'mx-3 my-px px-2.5',
                  active ? 'bg-sidebar-active font-medium text-white' : 'font-normal text-sidebar-text hover:bg-white/[.06]',
                ].join(' ');

                if (item.locked === true) {
                  return (
                    <span
                      key={item.key}
                      className={`${base} cursor-not-allowed opacity-70`}
                      title="Owner only"
                      aria-disabled="true"
                    >
                      <Icon name={item.icon} size={16} />
                      {expanded ? <span className="flex-1 whitespace-nowrap">{item.label}</span> : null}
                      {expanded ? <Icon name="lock" size={12} strokeWidth={2} /> : null}
                    </span>
                  );
                }

                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    className={base}
                    title={collapsed ? item.label : undefined}
                    aria-current={active ? 'page' : undefined}
                  >
                    <Icon name={item.icon} size={16} />
                    {expanded ? <span className="flex-1 whitespace-nowrap">{item.label}</span> : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* User row. */}
        <div
          className={[
            'flex items-center gap-2.5 border-t border-sidebar-line',
            collapsed ? 'justify-center px-0 pb-3.5 pt-2.5' : 'px-3.5 pb-3.5 pt-2.5',
          ].join(' ')}
        >
          <span className="grid h-7 w-7 flex-none place-items-center rounded-control bg-sidebar-chip text-label font-semibold text-white">
            {user.initials}
          </span>
          {expanded ? (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-medium text-white">{user.name}</span>
                <span className="block text-label text-sidebar-muted">{workspace.role}</span>
              </span>
              {onSignOut !== undefined ? (
                <button
                  type="button"
                  onClick={onSignOut}
                  className="rounded-badge px-1.5 py-1 text-label text-sidebar-muted hover:bg-white/[.08] hover:text-white"
                >
                  Sign out
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </aside>

      {/* ------------------------------------------------------------ content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 flex-none items-center gap-3 border-b border-border bg-surface px-8">
          {/* Breadcrumb: monogram chip / workspace / page. */}
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-ui">
            <span className="grid h-[22px] w-[22px] flex-none place-items-center rounded-5 bg-brand-soft text-pill font-semibold text-brand">
              {workspace.monogram}
            </span>
            <span className="truncate text-text-2">{workspace.name}</span>
            <span className="text-text-3">/</span>
            <span className="truncate font-medium text-text" aria-current="page">
              {breadcrumb}
            </span>
          </nav>

          {readOnly ? (
            <span className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-badge bg-danger-soft px-2 text-caption font-medium text-danger-text">
              Read-only
            </span>
          ) : null}

          <div className="flex-1" />

          {/* Search: a 34px well with the shortcut chip. */}
          <button
            type="button"
            className="hidden h-[34px] w-[280px] items-center gap-2 rounded-control border border-border bg-bg pl-2.5 pr-2 text-ui text-text-3 hover:border-text-3 md:flex"
          >
            <Icon name="search" size={14} />
            <span className="flex-1 text-left">Search campaigns, contacts…</span>
            <kbd className="rounded-4 border border-border bg-surface px-[5px] py-px font-mono text-label font-medium text-text-2">⌘K</kbd>
          </button>

          <button
            type="button"
            title="Notifications"
            aria-label="Notifications"
            className="relative grid h-[34px] w-[34px] place-items-center rounded-control border border-border bg-surface text-text-2 hover:bg-tint"
          >
            <Icon name="bell" size={16} />
            {hasAlerts ? (
              <span
                aria-hidden="true"
                className="absolute right-2 top-[7px] h-[7px] w-[7px] rounded-full border-[1.5px] border-surface bg-danger"
              />
            ) : null}
          </button>

          <button
            type="button"
            onClick={createDisabled ? undefined : onCreate}
            disabled={createDisabled}
            title={createTitle}
            className={[
              'inline-flex h-[34px] flex-none items-center gap-1.5 whitespace-nowrap rounded-control pl-2.5 pr-3 text-ui font-medium',
              createDisabled ? 'cursor-not-allowed bg-neutral-soft text-text-3' : 'bg-brand text-on-brand hover:bg-brand-hover',
            ].join(' ')}
          >
            <Icon name="plus" size={14} strokeWidth={2} />
            Create campaign
          </button>
        </header>

        {/* Banner slot (K1): one at a time, highest severity wins. */}
        {banner !== null && banner !== undefined ? (
          <div
            role="status"
            className="flex items-center gap-3 border-b px-8 py-2.5"
            style={{ background: `var(--${banner.tone}-soft)`, borderColor: BANNER_LINE[banner.tone] }}
          >
            <span className="flex-none" style={{ color: `var(--${banner.tone}-text)` }}>
              <Icon name={banner.icon} size={16} strokeWidth={2} />
            </span>
            <div className="min-w-0 flex-1 text-ui text-text">
              <span className="font-semibold">{banner.title}</span> <span className="text-text-2">{banner.body}</span>
            </div>
            {banner.action !== undefined ? (
              <Link href={banner.action.href} className="whitespace-nowrap text-ui font-medium text-brand no-underline">
                {banner.action.label}
              </Link>
            ) : null}
          </div>
        ) : null}

        <main className="mx-auto w-full max-w-[1280px] flex-1 px-8 pb-10 pt-7">{children}</main>
      </div>
    </div>
  );
}
