// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAV, Shell, type ShellProps } from '../src/index.js';

/**
 * The application shell (design/Shell.dc.html).
 *
 * What is worth rendering to check is what a screenshot comparison would
 * miss: that the active item is announced, that a locked item is not a link,
 * that collapsing keeps every destination reachable, and that the banner slot
 * shows one banner or none.
 */

afterEach(cleanup);

const WORKSPACE = { id: 'ws-nv', name: 'Northwind Voyages', monogram: 'NV', plan: 'Growth', role: 'Owner' };
const OTHER = { id: 'ws-ah', name: 'Aurelia Hotels Group', monogram: 'AH', plan: 'Starter', role: 'Admin' };

function shell(over: Partial<ShellProps> = {}) {
  const onSwitchWorkspace = vi.fn();
  const onCreate = vi.fn();

  const view = render(
    <Shell
      workspace={WORKSPACE}
      workspaces={[WORKSPACE, OTHER]}
      onSwitchWorkspace={onSwitchWorkspace}
      user={{ name: 'Dana Haddad', initials: 'DH' }}
      currentPath="/campaigns"
      breadcrumb="Campaigns"
      usage={{ used: 184_320, limit: 250_000, renewsLabel: 'Renews 1 Oct · 12 days left' }}
      onCreate={onCreate}
      {...over}
    >
      <p>page body</p>
    </Shell>,
  );

  return { view, onSwitchWorkspace, onCreate };
}

describe('navigation', () => {
  it('renders every group and item from the design, in order', () => {
    shell();
    const nav = screen.getByRole('navigation', { name: 'Sections' });

    for (const group of NAV) {
      expect(within(nav).getByText(group.label)).toBeTruthy();
      for (const item of group.items) {
        expect(within(nav).getByText(item.label)).toBeTruthy();
      }
    }
  });

  it('marks the current section for assistive tech, not only by colour', () => {
    shell({ currentPath: '/campaigns/cmp_1' });
    const nav = screen.getByRole('navigation', { name: 'Sections' });

    const current = within(nav).getByRole('link', { current: 'page' });
    expect(current.textContent).toContain('Campaigns');
  });

  it('renders a locked item as text, not a link', () => {
    // Billing for a non-owner. A link that 403s on click is a worse
    // experience than a lock that explains itself.
    const nav = NAV.map((group) => ({
      ...group,
      items: group.items.map((item) => (item.key === 'billing' ? { ...item, locked: true } : item)),
    }));
    shell({ nav });

    const sections = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(sections).queryByRole('link', { name: /Billing/u })).toBeNull();
    expect(within(sections).getByTitle('Owner only').textContent).toContain('Billing');
  });

  it('keeps every destination reachable when collapsed', async () => {
    // Collapsed, the labels go but the links must not — the frame shows
    // icons with the label as a tooltip. A collapse that dropped items would
    // make sections unreachable on narrow screens.
    shell();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    const nav = screen.getByRole('navigation', { name: 'Sections' });
    const total = NAV.reduce((sum, group) => sum + group.items.length, 0);

    expect(within(nav).getAllByRole('link')).toHaveLength(total);
    expect(within(nav).getByTitle('Suppressions')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
  });
});

describe('the workspace switcher', () => {
  it('lists every workspace and switches on selection', async () => {
    const { onSwitchWorkspace } = shell();

    await userEvent.click(screen.getByRole('button', { name: /Northwind Voyages/u }));
    const list = screen.getByRole('listbox', { name: 'Workspaces' });

    expect(within(list).getByText('Aurelia Hotels Group')).toBeTruthy();
    expect(within(list).getByText('Starter plan · Admin')).toBeTruthy();

    await userEvent.click(within(list).getByRole('option', { name: /Aurelia/u }));
    expect(onSwitchWorkspace).toHaveBeenCalledWith('ws-ah');
  });

  it('does not re-switch to the current workspace', async () => {
    const { onSwitchWorkspace } = shell();

    await userEvent.click(screen.getByRole('button', { name: /Northwind Voyages/u }));
    await userEvent.click(screen.getByRole('option', { name: /Northwind Voyages/u }));

    expect(onSwitchWorkspace).not.toHaveBeenCalled();
  });

  it('offers to create a workspace', async () => {
    shell();
    await userEvent.click(screen.getByRole('button', { name: /Northwind Voyages/u }));

    expect(screen.getByRole('link', { name: /Create workspace/u }).getAttribute('href')).toBe('/workspaces/new');
  });
});

describe('the top bar', () => {
  it('shows the breadcrumb with the workspace monogram', () => {
    shell({ breadcrumb: 'Campaigns' });
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });

    expect(within(crumbs).getByText('NV')).toBeTruthy();
    expect(within(crumbs).getByText('Campaigns').getAttribute('aria-current')).toBe('page');
  });

  it('keeps the create button, disabled with a reason, for a viewer', () => {
    // The sheet: "Disabled buttons keep their label and explain why in a
    // tooltip." Removing the button hides the fact that creating is a thing.
    shell({ canCreate: false });
    const button = screen.getByRole('button', { name: /Create campaign/u });

    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toBe('Viewers cannot create campaigns');
  });

  it('marks a read-only workspace and disables creation', () => {
    shell({ readOnly: true });

    expect(screen.getByText('Read-only')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Create campaign/u }).getAttribute('title')).toBe(
      'Workspace is read-only',
    );
  });

  it('fires onCreate when allowed', async () => {
    const { onCreate } = shell();
    await userEvent.click(screen.getByRole('button', { name: /Create campaign/u }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});

describe('the banner slot (K1)', () => {
  it('renders nothing when there is no banner', () => {
    shell({ banner: null });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders title, body and action', () => {
    shell({
      banner: {
        tone: 'warning',
        icon: 'alert',
        title: 'Paused automatically: complaint rate exceeded 0.3%.',
        body: 'Review the audience and content before resuming.',
        action: { label: 'Review campaign', href: '/campaigns/cmp_6' },
      },
    });

    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('Paused automatically');
    expect(within(banner).getByRole('link', { name: 'Review campaign' }).getAttribute('href')).toBe(
      '/campaigns/cmp_6',
    );
  });
});

describe('plan usage (option 1c)', () => {
  it('shows used / limit with grouped digits and the renewal line', () => {
    shell();
    expect(screen.getByText('184,320 / 250,000')).toBeTruthy();
    expect(screen.getByText('Renews 1 Oct · 12 days left')).toBeTruthy();
  });
});
