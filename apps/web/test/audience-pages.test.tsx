// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { configureApi } from '../src/api/client.js';
import { ContactsPage } from '../src/routes/audience/contacts.js';
import { SuppressionsPage } from '../src/routes/audience/collections.js';
import { ImportsPage, guessMapping } from '../src/routes/audience/imports.js';

const fetchMock = vi.fn();

const OWNER = [{ workspaceId: 'ws-1', workspaceName: 'Acme', workspaceSlug: 'acme', role: 'owner' }];
const VIEWER = [{ workspaceId: 'ws-1', workspaceName: 'Acme', workspaceSlug: 'acme', role: 'viewer' }];

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

function renderPage(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider>{ui}</AuthProvider>
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

function contact(id: string, email: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    email,
    firstName: null,
    lastName: null,
    status: 'subscribed',
    attributes: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('contacts', () => {
  it('shows the contacts the server returned', async () => {
    mockApi([
      {
        match: (url) => url.includes('/audience/contacts'),
        respond: () => ({ body: { data: [contact('c1', 'a@example.com')], meta: { hasMore: false } } }),
      },
    ]);

    renderPage(<ContactsPage />);
    expect(await screen.findByText('a@example.com')).toBeTruthy();
  });

  it('asks the server to filter, rather than filtering what it already has', async () => {
    // A workspace can hold hundreds of thousands of contacts. A page that
    // filters client-side is a page that downloads all of them first.
    const urls: string[] = [];
    mockApi([
      {
        match: (url) => url.includes('/audience/contacts'),
        respond: (url) => {
          urls.push(url);
          return { body: { data: [], meta: {} } };
        },
      },
    ]);

    renderPage(<ContactsPage />);
    await screen.findByText('No contacts yet');

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'bounced');

    await waitFor(() => {
      expect(urls.some((url) => url.includes('status=bounced'))).toBe(true);
    });
  });

  it('pages forward with the cursor the server gave it', async () => {
    const urls: string[] = [];
    mockApi([
      {
        match: (url) => url.includes('/audience/contacts'),
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
      },
    ]);

    renderPage(<ContactsPage />);
    await screen.findByText('first@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('second@example.com')).toBeTruthy();
    expect(urls.some((url) => url.includes('cursor=CURSOR-1'))).toBe(true);
  });

  it('starts again from the first page when the filter changes', async () => {
    // A cursor describes a position in the old result set and means nothing
    // in the new one.
    const urls: string[] = [];
    mockApi([
      {
        match: (url) => url.includes('/audience/contacts'),
        respond: (url) => {
          urls.push(url);
          return {
            body: { data: [contact('c1', 'a@example.com')], meta: { nextCursor: 'CURSOR-1' } },
          };
        },
      },
    ]);

    renderPage(<ContactsPage />);
    await screen.findByText('a@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(urls.some((url) => url.includes('cursor='))).toBe(true));

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'bounced');

    await waitFor(() => {
      const last = urls[urls.length - 1] ?? '';
      expect(last).toContain('status=bounced');
      expect(last).not.toContain('cursor=');
    });
  });

  it('shows the server error rather than an empty table', async () => {
    // An empty table where a request failed is a dashboard lying to its user.
    mockApi([
      {
        match: (url) => url.includes('/audience/contacts'),
        respond: () => ({
          status: 500,
          body: { error: { code: 'internal_error', message: 'Database unavailable', requestId: 'req-9' } },
        }),
      },
    ]);

    renderPage(<ContactsPage />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Database unavailable')).toBeTruthy();
    expect(within(alert).getByText(/req-9/u)).toBeTruthy();
  });

  it('hides the write controls from a viewer', async () => {
    mockApi(
      [
        {
          match: (url) => url.includes('/audience/contacts'),
          respond: () => ({ body: { data: [contact('c1', 'a@example.com')], meta: {} } }),
        },
      ],
      VIEWER,
    );

    renderPage(<ContactsPage />);
    await screen.findByText('a@example.com');

    expect(screen.queryByRole('button', { name: 'Add contact' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('suppressions', () => {
  it('will not offer to remove a hard bounce', async () => {
    // A bounce is evidence from a mailbox provider. Deleting it to send again
    // is how a workspace loses its sending reputation.
    mockApi([
      {
        match: (url) => url.includes('/audience/suppressions'),
        respond: () => ({
          body: {
            data: [
              { id: 's1', email: 'bounced@example.com', reason: 'hard_bounce', notes: null, createdAt: '2026-01-01T00:00:00.000Z' },
              { id: 's2', email: 'manual@example.com', reason: 'manual', notes: null, createdAt: '2026-01-01T00:00:00.000Z' },
            ],
          },
        }),
      },
    ]);

    renderPage(<SuppressionsPage />);
    await screen.findByText('bounced@example.com');

    // One Remove button, on the manual row only.
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);
    expect(screen.getByText('Permanent')).toBeTruthy();
  });
});

describe('imports', () => {
  const job = (extra: Record<string, unknown> = {}) => ({
    id: 'job-1',
    originalFilename: 'contacts.csv',
    fileType: 'csv',
    status: 'processing',
    columnMapping: null,
    totalRows: 200,
    processedRows: 50,
    createdCount: 50,
    updatedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    ...extra,
  });

  it('shows progress against the known total', async () => {
    mockApi([
      { match: (url) => url.endsWith('/audience/imports'), respond: () => ({ body: { data: [job()] } }) },
    ]);

    renderPage(<ImportsPage />);

    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
  });

  it('says so rather than showing 0% before the total is known', async () => {
    // totalRows is null until the file has been counted. Showing 0% for a job
    // that is working reads as broken.
    mockApi([
      {
        match: (url) => url.endsWith('/audience/imports'),
        respond: () => ({ body: { data: [job({ totalRows: null, processedRows: 1200 })] } }),
      },
    ]);

    renderPage(<ImportsPage />);

    expect(await screen.findByText(/1,200 rows so far/u)).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('offers the failed rows only when there are some', async () => {
    mockApi([
      {
        match: (url) => url.endsWith('/audience/imports'),
        respond: () => ({
          body: { data: [job({ status: 'completed', failedCount: 0, completedAt: '2026-01-02T00:00:00.000Z' })] },
        }),
      },
    ]);

    renderPage(<ImportsPage />);
    await screen.findByText('contacts.csv');
    expect(screen.queryByRole('button', { name: 'Failed rows' })).toBeNull();
  });

  it('neutralises a formula in the failed-row download', async () => {
    // This file is made of values the importer rejected — the most
    // attacker-influenced data we hold — and it is opened in Excel by
    // definition.
    const created: Blob[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (blob: Blob) => {
        created.push(blob);
        return 'blob:test';
      },
      revokeObjectURL: () => undefined,
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    mockApi([
      {
        match: (url) => url.endsWith('/errors'),
        respond: () => ({
          body: {
            data: [
              {
                rowNumber: 4,
                columnName: 'first_name',
                errorCode: 'email_invalid',
                message: 'This does not look like an email address',
                rawValue: '=cmd|/c calc',
              },
            ],
          },
        }),
      },
      {
        match: (url) => url.endsWith('/audience/imports'),
        respond: () => ({ body: { data: [job({ status: 'completed', failedCount: 1 })] } }),
      },
    ]);

    renderPage(<ImportsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Failed rows' }));

    await waitFor(() => expect(created).toHaveLength(1));
    // jsdom's Blob has no .text(); FileReader is the portable way in.
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(created[0] as Blob);
    });

    expect(text).toContain("'=cmd|/c calc");
    expect(text).not.toMatch(/(^|,)=cmd/mu);
  });
});

describe('the mapping guess', () => {
  it('recognises the header names files actually use', () => {
    expect(guessMapping(['Email Address', 'First Name', 'Surname'])).toEqual({
      'Email Address': 'email',
      'First Name': 'firstName',
      Surname: 'lastName',
    });
  });

  it('does not guess from a header that merely contains the word', () => {
    // "emailed_at" is a date, not an address. A wrong guess applied silently
    // is worse than no guess at all.
    expect(guessMapping(['emailed_at', 'name_of_pet'])).toEqual({});
  });

  it('keeps the first of two columns claiming the same field', () => {
    expect(guessMapping(['email', 'email_address'])).toEqual({ email: 'email' });
  });
});
