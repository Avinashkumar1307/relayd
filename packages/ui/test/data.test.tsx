// @vitest-environment jsdom
import { useState, type ComponentProps } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BulkBar, DataTable, type Column } from '../src/Table.js';
import { EmptyState } from '../src/EmptyState.js';
import { ErrorState } from '../src/ErrorState.js';
import { DashboardSkeleton, DetailSkeleton, Skeleton, TableSkeleton } from '../src/Skeleton.js';
import { SEG_ORDER, SegmentedBar, segmentValues } from '../src/SegmentedBar.js';
import { Card, CardHeader, Stat } from '../src/Card.js';
import { PageHeader } from '../src/PageHeader.js';
import { Tabs } from '../src/Tabs.js';

/**
 * The data-display group (design/00 Design System.dc.html — table, states,
 * skeletons, progress; design/D Audience.dc.html D1; design/G
 * Campaigns.dc.html G1; design/K System States.dc.html K4a–K4d).
 *
 * The rules under test are the sheet's own sentences: segment order is
 * fixed and counts always appear in the legend; selecting rows swaps the
 * toolbar for a bulk-action bar; an error carries a request ID in mono and
 * a retry; suppression is never hidden. The class assertions are the
 * structural ones — the measured height, the token that carries a state —
 * not pixel positions.
 */

afterEach(cleanup);

interface Contact {
  id: string;
  email: string;
  status: string;
}

const CONTACTS: Contact[] = [
  { id: 'c1', email: 'amira.khalil@example.ae', status: 'Subscribed' },
  { id: 'c2', email: 'j.moreau@example.fr', status: 'Subscribed' },
  { id: 'c3', email: 's.okafor@example.co.uk', status: 'Unsubscribed' },
];

const COLUMNS: Column<Contact>[] = [
  { key: 'email', header: 'Email', cell: (row) => row.email, width: '45%' },
  { key: 'status', header: 'Status', cell: (row) => row.status, width: '132px' },
  { key: 'created', header: 'Created', cell: () => '12 Mar 2026', width: '110px', sortable: true },
];

function table(props: Partial<ComponentProps<typeof DataTable<Contact>>> = {}) {
  return (
    <DataTable<Contact> columns={COLUMNS} rows={CONTACTS} rowKey={(row) => row.id} label="Contacts" {...props} />
  );
}

describe('DataTable', () => {
  it('is a real table, named, with one header cell per column', () => {
    // A grid of divs cannot say "row 4 of 8, column Status"; the frames draw
    // a grid, but what is on screen is a table.
    render(table());
    const grid = screen.getByRole('table', { name: 'Contacts' });

    expect(within(grid).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Email',
      'Status',
      'Created',
    ]);
    expect(within(grid).getAllByRole('row')).toHaveLength(CONTACTS.length + 1);
  });

  it('carries each column width into a <col> so the frame layout survives', () => {
    const { container } = render(table());
    const widths = Array.from(container.querySelectorAll('col')).map((col) => col.style.width);

    expect(widths).toEqual(['45%', '132px', '110px']);
  });

  it('selects one row, and the header box selects the page', async () => {
    const onSelectionChange = vi.fn();
    render(table({ selectedKeys: [], onSelectionChange, selectionLabel: (row) => `Select ${row.email}` }));

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select j.moreau@example.fr' }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(['c2']);

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(['c1', 'c2', 'c3']);
  });

  it('shows the header box as indeterminate while only some rows are picked', () => {
    render(table({ selectedKeys: ['c1'], onSelectionChange: vi.fn() }));
    const all = screen.getByRole('checkbox', { name: 'Select all rows' });

    expect((all as HTMLInputElement).indeterminate).toBe(true);
    expect((all as HTMLInputElement).checked).toBe(false);
  });

  it('clears only this page when the header box is unticked', async () => {
    const onSelectionChange = vi.fn();
    // "page-9" is a row selected on another page: it has to survive.
    render(table({ selectedKeys: ['c1', 'c2', 'c3', 'page-9'], onSelectionChange }));

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(['page-9']);
  });

  it('has no checkbox column at all without a selection handler', () => {
    render(table());
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('announces sort with aria-sort and flips direction on the active column', async () => {
    const onSortChange = vi.fn();
    const { rerender } = render(table({ onSortChange }));

    const created = screen.getByRole('columnheader', { name: /Created/ });
    expect(created.getAttribute('aria-sort')).toBe('none');
    // Only sortable columns claim a sort state.
    expect(screen.getByRole('columnheader', { name: 'Email' }).hasAttribute('aria-sort')).toBe(false);

    await userEvent.click(within(created).getByRole('button'));
    expect(onSortChange).toHaveBeenLastCalledWith('created', 'desc');

    rerender(table({ onSortChange, sort: { key: 'created', direction: 'desc' } }));
    expect(screen.getByRole('columnheader', { name: /Created/ }).getAttribute('aria-sort')).toBe('descending');

    await userEvent.click(within(screen.getByRole('columnheader', { name: /Created/ })).getByRole('button'));
    expect(onSortChange).toHaveBeenLastCalledWith('created', 'asc');
  });

  it('sticks the header only when asked', () => {
    const { container, rerender } = render(table());
    expect(container.querySelector('thead')?.className).not.toContain('sticky');

    rerender(table({ stickyHeader: true, maxHeight: 300 }));
    expect(container.querySelector('thead')?.className).toContain('sticky');
  });

  it('shows the empty slot with no rows, and the loading slot over it', () => {
    const { rerender } = render(table({ rows: [], empty: <p>No contacts yet</p> }));
    expect(screen.getByText('No contacts yet')).toBeTruthy();

    rerender(table({ rows: [], empty: <p>No contacts yet</p>, loading: <p>Loading</p> }));
    expect(screen.queryByText('No contacts yet')).toBeNull();
    expect(screen.getByText('Loading')).toBeTruthy();
  });

  it('swaps the toolbar for the bulk bar, as the sheet says it must', () => {
    const { rerender } = render(table({ toolbar: <span>Status Any</span> }));
    expect(screen.getByText('Status Any')).toBeTruthy();

    rerender(
      table({
        toolbar: <span>Status Any</span>,
        bulkBar: <BulkBar count={2} actions={[]} onClear={vi.fn()} />,
      }),
    );
    expect(screen.queryByText('Status Any')).toBeNull();
    expect(screen.getByText('2 selected')).toBeTruthy();
  });

  it('renders the footer slot for server-side pagination', () => {
    render(table({ footer: <span>1–25 of 1,240</span> }));
    expect(screen.getByText('1–25 of 1,240')).toBeTruthy();
  });

  it('mutes a suppressed row instead of hiding it', () => {
    const { container } = render(table({ rowMuted: (row) => row.status === 'Unsubscribed' }));
    const rows = container.querySelectorAll('tbody tr');

    expect(rows[2]?.className).toContain('text-text-2');
    expect(rows[0]?.className).toContain('text-text');
    // Never hidden: the row is still there and still says why.
    expect(screen.getByText('Unsubscribed')).toBeTruthy();
  });

  it('marks a selected row with the brand-soft token', () => {
    const { container } = render(table({ selectedKeys: ['c1'], onSelectionChange: vi.fn() }));
    const first = container.querySelector('tbody tr');

    expect(first?.className).toContain('bg-brand-soft');
    expect(first?.getAttribute('data-selected')).toBe('');
  });

  it('does not fire the row click when the checkbox is clicked', async () => {
    const onRowClick = vi.fn();
    render(table({ onRowClick, selectedKeys: [], onSelectionChange: vi.fn() }));

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select row c1' }));
    expect(onRowClick).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText('amira.khalil@example.ae'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });
});

describe('BulkBar', () => {
  it('is a toolbar, counts the selection and clears it', async () => {
    const onClear = vi.fn();
    const suppress = vi.fn();
    render(
      <BulkBar
        count={2}
        onClear={onClear}
        actions={[
          { key: 'tag', label: 'Add tag', onClick: vi.fn() },
          { key: 'suppress', label: 'Suppress', onClick: suppress, danger: true },
        ]}
      />,
    );

    const bar = screen.getByRole('toolbar', { name: '2 selected' });
    expect(within(bar).getByText('2 selected')).toBeTruthy();

    // A destructive bulk action is a danger *label*, not a filled red button:
    // red fill would read as the primary thing to do with a selection.
    const danger = screen.getByRole('button', { name: 'Suppress' });
    expect(danger.className).toContain('text-danger-text');
    expect(danger.className).toContain('bg-surface');
    expect(danger.className).toContain('h-7.5');

    await userEvent.click(danger);
    expect(suppress).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('EmptyState', () => {
  it('is one icon, one sentence, one action', () => {
    render(
      <EmptyState
        icon="imports"
        title="No contacts yet"
        description="Import a CSV or XLSX to build your audience."
        action={<button type="button">Import contacts</button>}
      />,
    );

    expect(screen.getByText('No contacts yet').className).toContain('text-card');
    expect(screen.getByRole('button', { name: 'Import contacts' })).toBeTruthy();
  });

  it('has the sheet’s two sizes: 56px in a table, 72px as a page', () => {
    const { container, rerender } = render(<EmptyState icon="imports" title="Empty" size="table" />);
    expect(container.firstElementChild?.className).toContain('py-14');

    rerender(<EmptyState icon="imports" title="Empty" size="page" />);
    expect(container.firstElementChild?.className).toContain('py-18');
  });
});

describe('ErrorState', () => {
  it('states what failed, shows the request id in mono and offers a retry', async () => {
    const onRetry = vi.fn();
    render(<ErrorState requestId="req_01J9K4ERR7Q2M8" meta="HTTP 502" onRetry={onRetry} />);

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Something went wrong on our side')).toBeTruthy();

    const id = screen.getByText('req_01J9K4ERR7Q2M8');
    expect(id.tagName).toBe('CODE');
    expect(id.parentElement?.className).toContain('font-mono');
    expect(within(alert).getByText('HTTP 502')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('copies the request id and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<ErrorState requestId="req_abc" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy request ID' }));

    expect(writeText).toHaveBeenCalledWith('req_abc');
    expect(screen.getByRole('button', { name: 'Request ID copied' }).textContent).toBe('Copied');
  });

  it('survives a browser with no clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });

    render(<ErrorState requestId="req_abc" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy request ID' }));

    expect(screen.getByText('req_abc')).toBeTruthy();
  });

  it('drops the chip entirely when there is no request id', () => {
    render(<ErrorState title="Could not load" description="Try again." />);
    expect(screen.queryByRole('button', { name: 'Copy request ID' })).toBeNull();
  });
});

describe('Skeleton', () => {
  it('shimmers through the token and is hidden from the accessibility tree', () => {
    const { container } = render(<Skeleton width={120} height={14} radius={6} />);
    const shape = container.firstElementChild as HTMLElement;

    expect(shape.className).toContain('animate-shimmer');
    expect(shape.getAttribute('aria-hidden')).toBe('true');
    expect(shape.style.width).toBe('120px');
    expect(shape.style.height).toBe('14px');
    expect(shape.style.borderRadius).toBe('6px');
    // K's `sk()`: one gradient, sized 200% so the keyframes can slide it.
    expect(shape.style.backgroundSize).toBe('200% 100%');
  });

  it('renders as many rows as the saved page size, under one live region', () => {
    const { container } = render(<TableSkeleton rows={5} />);

    expect(screen.getByRole('status', { name: 'Loading table' })).toBeTruthy();
    // The tinted header strip plus the five body rows.
    expect(container.querySelectorAll('.border-b.border-border.py-3\\.25')).toHaveLength(5);
  });

  it('gives the dashboard and detail pages one status each', () => {
    render(
      <>
        <DashboardSkeleton />
        <DetailSkeleton />
      </>,
    );

    expect(screen.getByRole('status', { name: 'Loading dashboard' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy();
  });
});

describe('SegmentedBar', () => {
  const COUNTS = { delivered: 29876, pending: 16000, queued: 595, sending: 1240, soft: 214, hard: 100, complaint: 8, uncertain: 180 };

  it('folds the raw counts into relayd-ui’s six buckets', () => {
    expect(segmentValues(COUNTS)).toEqual({
      delivered: 29876,
      pending: 16595,
      sending: 1240,
      soft: 214,
      danger: 108,
      uncertain: 180,
    });
  });

  it('keeps the fixed segment order and prints every count in the legend', () => {
    render(<SegmentedBar counts={COUNTS} total={48213} label="Autumn Escapes" />);

    expect(SEG_ORDER.map((seg) => seg.key)).toEqual([
      'delivered',
      'pending',
      'sending',
      'soft',
      'danger',
      'uncertain',
    ]);
    // "Counts always appear in the legend" — and formatted as relayd-ui does.
    expect(screen.getByText('29,876')).toBeTruthy();
    expect(screen.getByText('16,595')).toBeTruthy();
    expect(screen.getByText('108')).toBeTruthy();
    expect(screen.getByText('Hard bounce / complaint / failed')).toBeTruthy();
  });

  it('omits an empty bucket but never the uncertain footnote', () => {
    const { container, rerender } = render(<SegmentedBar counts={{ delivered: 100 }} total={100} />);
    expect(container.querySelectorAll('[title]')).toHaveLength(1);
    expect(screen.queryByText(/Not billed/)).toBeNull();

    rerender(<SegmentedBar counts={{ delivered: 90, uncertain: 10 }} total={100} />);
    expect(screen.getByText(/Delivery uncertain: the provider may have accepted these/)).toBeTruthy();
  });

  it('draws the uncertain segment hatched and dashed, never as a flat fill', () => {
    const { container } = render(<SegmentedBar counts={{ delivered: 90, uncertain: 10 }} total={100} legend={false} />);
    const segments = Array.from(container.querySelectorAll<HTMLElement>('[title]'));
    const uncertain = segments[1];

    expect(uncertain?.getAttribute('title')).toBe('Delivery uncertain: 10');
    expect(uncertain?.style.background).toContain('repeating-linear-gradient');
    expect(uncertain?.style.outline).toContain('dashed');
    expect(segments[0]?.className).toContain('bg-success');
  });

  it('is 12px with a legend and 8px without', () => {
    const { container, rerender } = render(<SegmentedBar counts={{ delivered: 1 }} total={1} />);
    expect(screen.getByRole('img').className).toContain('h-3');

    rerender(<SegmentedBar counts={{ delivered: 1 }} total={1} size="sm" legend={false} />);
    expect(screen.getByRole('img').className).toContain('h-2');
    expect(container.textContent).toBe('');
  });

  it('names itself for a screen reader instead of leaving a bare bar', () => {
    render(<SegmentedBar counts={{ delivered: 90, soft: 10 }} total={100} legend={false} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Delivered 90, Soft bounce 10');
  });
});

describe('Card, CardHeader and Stat', () => {
  it('is the frame’s surface: border, 12px radius, 16/18 padding', () => {
    const { container } = render(<Card>Body</Card>);
    const card = container.firstElementChild as HTMLElement;

    expect(card.className).toContain('bg-surface');
    expect(card.className).toContain('border-border');
    expect(card.className).toContain('rounded-card');
    expect(card.className).toContain('px-4.5');
  });

  it('drops its padding and clips when the content runs to the edge', () => {
    const { container } = render(<Card flush>Table</Card>);
    const card = container.firstElementChild as HTMLElement;

    expect(card.className).toContain('overflow-hidden');
    expect(card.className).not.toContain('px-4.5');
  });

  it('titles a card at 16/600 with its actions beside it', async () => {
    const onClick = vi.fn();
    render(
      <CardHeader
        title="Sending activity"
        description="Last 30 days"
        actions={<button type="button" onClick={onClick}>Export</button>}
      />,
    );

    expect(screen.getByText('Sending activity').className).toContain('text-card');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('puts the stat value at text-title with tabular figures and tones the delta', () => {
    render(<Stat label="Click rate" value="3.8%" delta="+0.4 pts vs Aug" deltaTone="success" />);

    expect(screen.getByText('3.8%').className).toContain('text-title');
    expect(screen.getByText('3.8%').className).toContain('tabular-nums');
    expect(screen.getByText('+0.4 pts vs Aug').className).toContain('text-success-text');
  });
});

describe('PageHeader', () => {
  it('is an h1 at text-title with a description and actions', () => {
    render(
      <PageHeader
        title="Campaigns"
        description="Every send, with its state and what happens next."
        actions={<button type="button">Create campaign</button>}
      />,
    );

    const heading = screen.getByRole('heading', { level: 1, name: 'Campaigns' });
    expect(heading.className).toContain('text-title');
    expect(heading.className).toContain('tracking-heading');
    expect(screen.getByRole('button', { name: 'Create campaign' })).toBeTruthy();
  });

  it('aligns to the top once a back link sits above the title, and takes a badge', () => {
    const { container } = render(
      <PageHeader title="Autumn Escapes" back={<a href="/campaigns">Campaigns</a>} badge={<span>Sending</span>} />,
    );

    expect(container.firstElementChild?.className).toContain('items-start');
    expect(screen.getByText('Sending')).toBeTruthy();
  });

  it('renders the tabs slot under the header', () => {
    render(<PageHeader title="Templates" tabs={<div data-testid="tabs" />} />);
    expect(screen.getByTestId('tabs')).toBeTruthy();
  });
});

function TabHarness({ variant = 'page' as const }) {
  const [value, setValue] = useState('all');
  return (
    <Tabs
      label="Campaign states"
      variant={variant}
      value={value}
      onChange={setValue}
      items={[
        { key: 'all', label: 'All', count: 24 },
        { key: 'sending', label: 'Sending', count: 3 },
        { key: 'drafts', label: 'Drafts', count: 5 },
      ]}
    />
  );
}

describe('Tabs', () => {
  it('is a tablist with one selected tab and one tab stop', () => {
    render(<TabHarness />);

    const tabs = within(screen.getByRole('tablist', { name: 'Campaign states' })).getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]?.getAttribute('tabindex')).toBe('0');
    expect(tabs[1]?.getAttribute('tabindex')).toBe('-1');
  });

  it('shows counts in text-3 beside the label, not as a pill', () => {
    render(<TabHarness />);
    expect(screen.getByText('24').className).toContain('text-text-3');
  });

  it('moves and selects with the arrow keys, and wraps at the ends', async () => {
    render(<TabHarness />);
    const tabs = screen.getAllByRole('tab');

    tabs[0]?.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /Sending/ }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Sending/ }));

    await userEvent.keyboard('{ArrowLeft}');
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: /Drafts/ }).getAttribute('aria-selected')).toBe('true');

    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: /All/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('underlines the active tab in brand and sits 44px tall inside a card', () => {
    render(<TabHarness variant="card" />);
    const [active, inactive] = screen.getAllByRole('tab');

    expect(active?.className).toContain('border-brand');
    expect(active?.className).toContain('h-11');
    expect(inactive?.className).toContain('border-transparent');
    expect(inactive?.className).toContain('text-text-2');
  });

  it('selects on click', async () => {
    render(<TabHarness />);
    await userEvent.click(screen.getByRole('tab', { name: /Drafts/ }));
    expect(screen.getByRole('tab', { name: /Drafts/ }).getAttribute('aria-selected')).toBe('true');
  });
});
