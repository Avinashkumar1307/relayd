// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { configureApi } from '../src/api/client.js';
import { ContactsPage } from '../src/routes/audience/contacts.js';
import { ListsPage } from '../src/routes/audience/lists.js';
import { TagsPage } from '../src/routes/audience/tags.js';
import { SuppressionsPage } from '../src/routes/audience/suppressions.js';

const fetchMock = vi.fn();

const OWNER = [{ workspaceId: 'ws-1', workspaceName: 'Northwind Voyages', workspaceSlug: 'northwind-voyages', role: 'owner' }];
const VIEWER = [{ workspaceId: 'ws-1', workspaceName: 'Northwind Voyages', workspaceSlug: 'northwind-voyages', role: 'viewer' }];

interface Route {
  match: (url: string) => boolean;
  respond: (url: string, init?: RequestInit) => { status?: number; body: unknown };
}

/**
 * Routes fetch to canned answers.
 *
 * mockImplementation rather than mockResolvedValue: a Response body can only
 * be read once, so a shared instance passes the first assertion and fails
 * every one after it.
 */
function mockApi(routes: Route[], role = OWNER) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('/auth/refresh')) {
      return new Response(JSON.stringify({ data: { accessToken: 't', memberships: role } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const route = routes.find((candidate) => candidate.match(url));
    if (route === undefined) {
      return new Response(
        JSON.stringify({ error: { code: 'not_found', message: url, requestId: 'r' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }

    const result = route.respond(url, init);
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function renderPage(ui: ReactNode, path = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/audience/contacts/:id" element={ui} />
            <Route path="*" element={ui} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  configureApi({ baseUrl: '/api/v1' });
});

afterEach(() => {
  // Vitest does not run RTL's automatic cleanup without `globals`, and a
  // leftover tree makes the next test assert against the previous render.
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The desktop table, scoped.
 *
 * Every list page renders the same rows twice — a stack for the phone and
 * the table above `md` — and jsdom applies no CSS, so both are in the tree.
 * Asserting inside the table is what keeps "one Remove button" meaning one
 * per row rather than one per breakpoint.
 */
function table(name: string) {
  return within(screen.getByRole('table', { name }));
}

function contact(id: string, email: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    email,
    firstName: null,
    lastName: null,
    status: 'subscribed',
    tags: [],
    lists: [],
    lastEngaged: 'Never',
    attributes: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

/** The four requests D1 makes; only `contacts` varies per test. */
function contactsRoutes(contacts: Route): Route[] {
  return [
    {
      match: (url) => url.includes('/stats'),
      respond: () => ({ body: { data: { contacts: 48_213, subscribed: 45_102, suppressed: 2_318, matching: 48_213 } } }),
    },
    { match: (url) => url.includes('/saved-views'), respond: () => ({ body: { data: [] } }) },
    { match: (url) => url.includes('/tags'), respond: () => ({ body: { data: [] } }) },
    { match: (url) => url.includes('/lists'), respond: () => ({ body: { data: [] } }) },
    contacts,
  ];
}

describe('contacts', () => {
  it('shows the contacts the server returned', async () => {
    mockApi(
      contactsRoutes({
        match: (url) => url.includes('/contacts'),
        respond: () => ({ body: { data: [contact('c1', 'amira.khalil@example.ae')], meta: { hasMore: false } } }),
      }),
    );

    renderPage(<ContactsPage />);
    expect(await screen.findByRole('table', { name: 'Contacts' })).toBeTruthy();
    expect(table('Contacts').getByText('amira.khalil@example.ae')).toBeTruthy();

    // The summary line is counted from the server's stats, never from the page.
    expect(
      screen.getByText('48,213 contacts · 45,102 subscribed · 2,318 suppressed and never sent to'),
    ).toBeTruthy();
  });

  it('asks the server to filter, rather than filtering what it already has', async () => {
    // A workspace can hold hundreds of thousands of contacts. A page that
    // filters client-side is a page that downloads all of them first.
    const urls: string[] = [];
    mockApi(
      contactsRoutes({
        match: (url) => url.includes('/contacts'),
        respond: (url) => {
          urls.push(url);
          return { body: { data: [contact('c1', 'a@example.com')], meta: {} } };
        },
      }),
    );

    renderPage(<ContactsPage />);
    await screen.findAllByText('a@example.com');

    await userEvent.click(screen.getByRole('tab', { name: 'Subscribed' }));

    await waitFor(() => {
      expect(urls.some((url) => url.includes('status=subscribed'))).toBe(true);
    });
  });

  it('pages forward with the cursor the server gave it', async () => {
    const urls: string[] = [];
    mockApi(
      contactsRoutes({
        match: (url) => url.includes('/contacts'),
        respond: (url) => {
          urls.push(url);
          return url.includes('cursor=')
            ? { body: { data: [contact('c2', 'second@example.com')], meta: {} } }
            : {
                body: {
                  data: [contact('c1', 'first@example.com')],
                  meta: { hasMore: true, nextCursor: 'CURSOR-1' },
                },
              };
        },
      }),
    );

    renderPage(<ContactsPage />);
    await screen.findAllByText('first@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));

    expect(await screen.findAllByText('second@example.com')).toHaveLength(2);
    expect(urls.some((url) => url.includes('cursor=CURSOR-1'))).toBe(true);
  });

  it('starts again from the first page when the filter changes', async () => {
    // A cursor describes a position in the old result set and means nothing
    // in the new one.
    const urls: string[] = [];
    mockApi(
      contactsRoutes({
        match: (url) => url.includes('/contacts'),
        respond: (url) => {
          urls.push(url);
          return {
            body: { data: [contact('c1', 'a@example.com')], meta: { nextCursor: 'CURSOR-1' } },
          };
        },
      }),
    );

    renderPage(<ContactsPage />);
    await screen.findAllByText('a@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(urls.some((url) => url.includes('cursor='))).toBe(true));

    await userEvent.click(screen.getByRole('tab', { name: 'Subscribed' }));

    await waitFor(() => {
      const last = urls[urls.length - 1] ?? '';
      expect(last).toContain('status=subscribed');
      expect(last).not.toContain('cursor=');
    });
  });

  it('shows the server error rather than an empty table', async () => {
    // An empty table where a request failed is a dashboard lying to its user.
    mockApi(
      contactsRoutes({
        match: (url) => url.includes('/contacts'),
        respond: () => ({
          status: 500,
          body: { error: { code: 'internal_error', message: 'Database unavailable', requestId: 'req-9' } },
        }),
      }),
    );

    renderPage(<ContactsPage />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Database unavailable/u)).toBeTruthy();
    expect(within(alert).getByText(/Your data is safe and sending is unaffected/u)).toBeTruthy();
    expect(within(alert).getByText('req-9')).toBeTruthy();
  });

  it('hides the write controls from a viewer', async () => {
    mockApi(
      contactsRoutes({
        match: (url) => url.includes('/contacts'),
        respond: () => ({ body: { data: [contact('c1', 'a@example.com')], meta: {} } }),
      }),
      VIEWER,
    );

    renderPage(<ContactsPage />);
    await screen.findAllByText('a@example.com');

    expect(screen.queryByRole('button', { name: 'Add contact' })).toBeNull();
    // contact:export is owner/admin only, and + Save view writes.
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Save view' })).toBeNull();
  });

  it('empty is the import prompt, not a bare table', async () => {
    mockApi([
      {
        match: (url) => url.includes('/stats'),
        respond: () => ({ body: { data: { contacts: 0, subscribed: 0, suppressed: 0, matching: 0 } } }),
      },
      { match: (url) => url.includes('/saved-views'), respond: () => ({ body: { data: [] } }) },
      {
        match: (url) => url.includes('/contacts'),
        respond: () => ({ body: { data: [], meta: {} } }),
      },
    ]);

    renderPage(<ContactsPage />);

    expect(await screen.findByText('No contacts yet')).toBeTruthy();
    expect(
      screen.getByText(
        'Import a CSV or XLSX to build your audience. You will map columns and confirm consent before anything is saved.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Import contacts' })).toBeTruthy();
  });

  it('says a suppressed contact cannot be un-suppressed here', async () => {
    // D2b: a complaint is a legal record. The drawer states the reason and
    // offers no way out of it.
    mockApi([
      ...contactsRoutes({
        match: (url) => url.includes('/contacts') && !url.includes('/contacts/c9'),
        respond: () => ({ body: { data: [contact('c9', 'lena.b@example.de')], meta: {} } }),
      }),
      {
        match: (url) => url.includes('/contacts/c9'),
        respond: () => ({
          body: {
            data: contact('c9', 'lena.b@example.de', {
              firstName: 'Lena',
              lastName: 'Bauer',
              status: 'complained',
              country: 'Germany',
              language: 'de-DE',
              consentSource: 'CRM opt-in',
              consentRecorded: '15 Feb 2026',
              suppression: {
                suppressed: true,
                headline: 'Suppressed · complaint · 9 Sep 2026.',
                detail: 'Cannot be removed.',
                removable: false,
              },
              events: [],
            }),
          },
        }),
      },
    ]);

    renderPage(<ContactsPage />, '/audience/contacts/c9');

    expect(await screen.findByText('Suppressed · complaint · 9 Sep 2026.')).toBeTruthy();

    const blocked = screen.getByRole('button', { name: 'Suppressed · cannot remove' });
    expect(blocked.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Suppress manually' })).toBeNull();
  });
});

describe('tags', () => {
  const TAGS = [
    { id: 'tg_dubai', name: 'Dubai', color: 'rgb(14, 165, 233)', contactCount: 12_840, segments: ['UAE leisure'], createdAt: '2026-02-14T09:00:00.000Z' },
    { id: 'tg_dubai_leisure', name: 'dubai-leisure', color: 'rgb(14, 165, 233)', contactCount: 1_206, segments: [], createdAt: '2026-09-03T09:00:00.000Z' },
  ];

  function tagRoutes(): Route[] {
    return [
      { match: (url) => url.includes('/tags/merge-preview'), respond: () => ({ body: { data: { total: 13_412, overlap: 634 } } }) },
      { match: (url) => url.includes('/tags'), respond: () => ({ body: { data: TAGS } }) },
    ];
  }

  it('counts the tags in the summary line and lists the segments using each', async () => {
    mockApi(tagRoutes());

    renderPage(<TagsPage />);

    expect(
      await screen.findByText('Free-form labels on contacts. Merge duplicates to keep segments clean. 2 tags'),
    ).toBeTruthy();
    expect(table('Tags').getByText('12,840')).toBeTruthy();
    expect(table('Tags').getByText('UAE leisure')).toBeTruthy();
  });

  it('will not merge until two tags are selected, and says so', async () => {
    mockApi(tagRoutes());

    renderPage(<TagsPage />);
    await screen.findAllByText('Dubai');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Dubai' }));

    const merge = screen.getByRole('button', { name: 'Merge tags' });
    expect(merge.hasAttribute('disabled')).toBe(true);
    expect(merge.getAttribute('title')).toBe('Pick two or more tags to merge');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select dubai-leisure' }));
    expect(screen.getByRole('button', { name: 'Merge tags' }).hasAttribute('disabled')).toBe(false);
  });

  it('merges into the tag chosen as Keep, and sends the others as the merged ids', async () => {
    const sent: unknown[] = [];
    mockApi([
      {
        match: (url) => url.includes('/tags/merge') && !url.includes('merge-preview'),
        respond: (_url, init) => {
          sent.push(JSON.parse(String(init?.body ?? '{}')));
          return { body: { data: { keepId: 'tg_dubai', contacts: 13_412 } } };
        },
      },
      ...tagRoutes(),
    ]);

    renderPage(<TagsPage />);
    await screen.findAllByText('Dubai');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Dubai' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select dubai-leisure' }));
    await userEvent.click(screen.getByRole('button', { name: 'Merge tags' }));

    expect(await screen.findByText('Merge 2 tags')).toBeTruthy();
    // The result line is the server's preview, not arithmetic done here.
    expect(await screen.findByText(/13,412 contacts \(634 had both\)/u)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Merge into “Dubai”' }));

    await waitFor(() => expect(sent).toEqual([{ keepId: 'tg_dubai', mergeIds: ['tg_dubai_leisure'] }]));
  });

  it('points an empty workspace at the contacts table', async () => {
    mockApi([{ match: (url) => url.includes('/tags'), respond: () => ({ body: { data: [] } }) }]);

    renderPage(<TagsPage />);

    expect(await screen.findByText('No tags yet')).toBeTruthy();
    expect(
      screen.getByText(
        'Tags are created when you add them to a contact, in bulk from the contacts table, or during an import.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to contacts' })).toBeTruthy();
  });

  it('shows the request id when tags fail to load', async () => {
    mockApi([
      {
        match: (url) => url.includes('/tags'),
        respond: () => ({
          status: 500,
          body: { error: { code: 'internal_error', message: 'Upstream timed out', requestId: 'req_01J9D4FQ7M2X' } },
        }),
      },
    ]);

    renderPage(<TagsPage />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("We couldn't load tags")).toBeTruthy();
    expect(within(alert).getByText(/Tags on contacts are intact/u)).toBeTruthy();
    expect(within(alert).getByText('req_01J9D4FQ7M2X')).toBeTruthy();
  });
});

describe('suppressions', () => {
  function suppression(id: string, email: string, reason: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      email,
      reason,
      notes: null,
      source: null,
      addedBy: 'Amazon SES',
      createdAt: '2026-09-05T09:00:00.000Z',
      ...extra,
    };
  }

  it('will not offer to remove a hard bounce', async () => {
    // A bounce is evidence from a mailbox provider. Deleting it to send again
    // is how a workspace loses its sending reputation.
    mockApi([
      {
        match: (url) => url.includes('/suppressions/summary'),
        respond: () => ({ body: { data: { total: 2_318, byReason: [] } } }),
      },
      {
        match: (url) => url.includes('/suppressions'),
        respond: () => ({
          body: {
            data: [
              suppression('s1', 'omar.h@example.ae', 'hard_bounce'),
              suppression('s2', 'lena.b@example.de', 'complaint'),
              suppression('s3', 'test.user@mailinator.com', 'manual', { addedBy: 'Dana Haddad' }),
            ],
          },
        }),
      },
    ]);

    renderPage(<SuppressionsPage />);
    await screen.findAllByText('omar.h@example.ae');

    // One Remove button, on the manual row only.
    expect(table('Suppressions').getAllByRole('button', { name: /^Remove /u })).toHaveLength(1);
    expect(table('Suppressions').getByRole('button', { name: 'Remove test.user@mailinator.com' })).toBeTruthy();

    // And the rule is stated on the page, beside the rows.
    expect(
      screen.getByText(
        'Manual and imported suppressions can be removed by an Admin; complaint and unsubscribe suppressions cannot.',
      ),
    ).toBeTruthy();
  });

  it('counts the whole list in the header, not the page of rows', async () => {
    mockApi([
      {
        match: (url) => url.includes('/suppressions/summary'),
        respond: () => ({
          body: { data: { total: 2_318, byReason: [{ reason: 'unsubscribe', count: 1_462 }] } },
        }),
      },
      {
        match: (url) => url.includes('/suppressions'),
        respond: () => ({ body: { data: [suppression('s1', 'a@example.com', 'unsubscribe')] } }),
      },
    ]);

    renderPage(<SuppressionsPage />);

    expect(
      await screen.findByText(
        '2,318 addresses that are never sent to, even when they appear in a list or segment.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('1,462')).toBeTruthy();
  });

  it('says suppression is still enforced when the page itself fails', async () => {
    mockApi([
      {
        match: (url) => url.includes('/suppressions'),
        respond: () => ({
          status: 503,
          body: { error: { code: 'unavailable', message: 'Upstream unavailable', requestId: 'req_01J9D7FQ7M2X' } },
        }),
      },
    ]);

    renderPage(<SuppressionsPage />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("We couldn't load suppressions")).toBeTruthy();
    expect(within(alert).getByText(/Suppression is still enforced at send time/u)).toBeTruthy();
  });
});

describe('lists', () => {
  const LISTS = [
    { id: 'ls_newsletter_eu', name: 'Newsletter EU', description: 'Monthly newsletter, EU audience', memberCount: 31_240, archived: false, footnote: 'Used by 8 campaigns', growth30d: 4.2, trend: [1, 2, 3], createdAt: '2026-01-03T09:00:00.000Z' },
    { id: 'ls_summer_2025', name: 'Summer 2025 campaign', description: null, memberCount: 6_120, archived: true, footnote: 'Archived 1 Sep 2026', growth30d: -0.4, trend: [3, 2, 1], createdAt: '2025-05-02T09:00:00.000Z' },
  ];

  it('keeps an archived list visible and read-only', async () => {
    // A list a campaign was sent to is part of that campaign's record, so
    // hiding it would hide the answer to "who received this".
    mockApi([{ match: (url) => url.includes('/lists'), respond: () => ({ body: { data: LISTS } }) }]);

    renderPage(<ListsPage />);

    expect(await screen.findByText('Summer 2025 campaign')).toBeTruthy();
    expect(screen.getByText('Archived · read-only')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Summer 2025 campaign' }));

    const rename = await screen.findByRole('menuitem', { name: /Rename/u });
    expect(rename.getAttribute('aria-disabled')).toBe('true');
  });

  it('switches between the card and table layouts', async () => {
    mockApi([{ match: (url) => url.includes('/lists'), respond: () => ({ body: { data: LISTS } }) }]);

    renderPage(<ListsPage />);
    await screen.findAllByText('Newsletter EU');

    expect(screen.queryByRole('table', { name: 'Lists' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Table' }));

    expect(screen.getByRole('table', { name: 'Lists' })).toBeTruthy();
  });
});
