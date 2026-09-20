// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { configureApi } from '../src/api/client.js';
import { ImportRunPage, ImportsPage, guessMapping, statusLook } from '../src/routes/audience/imports.js';

const fetchMock = vi.fn();

const OWNER = [
  { workspaceId: 'ws-1', workspaceName: 'Northwind Voyages', workspaceSlug: 'northwind-voyages', role: 'owner' },
];

interface Stub {
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
function mockApi(routes: Stub[], role = OWNER) {
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
        JSON.stringify({ error: { code: 'not_found', message: url, requestId: 'req_01J9D6FQ7M2X' } }),
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

function renderPage(ui: ReactNode, path = '/audience/imports') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/audience/imports/:id" element={ui} />
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

const job = (extra: Record<string, unknown> = {}) => ({
  id: 'job-1',
  originalFilename: 'eu-leisure-sept.csv',
  fileType: 'csv',
  status: 'processing',
  columnMapping: null,
  totalRows: 200,
  processedRows: 50,
  createdCount: 50,
  updatedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  createdAt: '2026-09-20T05:31:00.000Z',
  completedAt: null,
  ...extra,
});

/** A job sitting at stage 2, with the columns the server read out of it. */
const draft = (extra: Record<string, unknown> = {}) =>
  job({
    status: 'mapping',
    totalRows: null,
    processedRows: 0,
    createdCount: 0,
    rowCount: 14_286,
    columnMapping: { email: 'email', first_name: 'firstName', tier: 'loyalty_tier' },
    skippedColumns: ['internal_notes'],
    columns: [
      { name: 'email', samples: ['amira.khalil@example.ae'] },
      { name: 'first_name', samples: ['Amira'] },
      { name: 'tier', samples: ['Gold'] },
      { name: 'utm_source', samples: ['google'] },
      { name: 'internal_notes', samples: ['call back'] },
    ],
    ...extra,
  });

const single = (row: Record<string, unknown>): Stub => ({
  match: (url) => /\/audience\/imports\/[^/]+$/u.test(url),
  respond: () => ({ body: { data: row } }),
});

const list = (rows: Record<string, unknown>[]): Stub => ({
  match: (url) => url.endsWith('/audience/imports'),
  respond: () => ({ body: { data: rows } }),
});

describe('the import run (D6d)', () => {
  it('shows progress against the known total', async () => {
    mockApi([single(job()), list([job()])]);

    renderPage(<ImportRunPage />, '/audience/imports/job-1');

    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
  });

  it('says so rather than showing 0% before the total is known', async () => {
    // totalRows is null until the file has been counted. Showing 0% for a job
    // that is working reads as broken.
    mockApi([single(job({ totalRows: null, processedRows: 1200 })), list([])]);

    renderPage(<ImportRunPage />, '/audience/imports/job-1');

    expect(await screen.findByText(/1,200/u)).toBeTruthy();
    expect(screen.getByText('rows so far')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
  });

  it('offers to leave the page rather than only a spinner', async () => {
    mockApi([single(job({ etaSeconds: 40 })), list([])]);

    renderPage(<ImportRunPage />, '/audience/imports/job-1');

    expect(await screen.findByText('about 40 seconds left · you can leave this page')).toBeTruthy();
  });

  it('offers the failed rows only when there are some', async () => {
    mockApi([
      single(job({ status: 'completed', failedCount: 0, processedRows: 200, completedAt: '2026-09-20T06:00:00.000Z' })),
      list([]),
    ]);

    renderPage(<ImportRunPage />, '/audience/imports/job-1');

    await screen.findByText('Completed');
    expect(screen.queryByRole('button', { name: /Download failed rows/u })).toBeNull();
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
      single(job({ status: 'completed', failedCount: 1, processedRows: 200, completedAt: '2026-09-20T06:00:00.000Z' })),
      list([]),
    ]);

    renderPage(<ImportRunPage />, '/audience/imports/job-1');
    await userEvent.click(await screen.findByRole('button', { name: /Download failed rows/u }));

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

describe('the import list (D6a, D6e, D6f)', () => {
  it('says what a first import will leave behind', async () => {
    mockApi([list([])]);

    renderPage(<ImportsPage />);

    expect(await screen.findByText('No imports yet')).toBeTruthy();
    expect(
      screen.getByText(
        'Your first import will appear here with created, updated, skipped and failed counts and a downloadable failed-rows file.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start an import' })).toBeTruthy();
  });

  it('gives support the request id when history will not load', async () => {
    mockApi([]);

    renderPage(<ImportsPage />);

    expect(await screen.findByText("We couldn't load import history")).toBeTruthy();
    expect(screen.getByText('req_01J9D6FQ7M2X')).toBeTruthy();
  });

  it('keeps the upload in front of the history once there is any', async () => {
    mockApi([list([job({ status: 'completed', failedCount: 0, processedRows: 200 })])]);

    renderPage(<ImportsPage />);

    expect(await screen.findByText('Drop a CSV or XLSX here')).toBeTruthy();
    expect(screen.getByText('Import history')).toBeTruthy();
    expect(screen.getByText('Failed-row files are kept for 30 days')).toBeTruthy();
  });
});

describe('mapping columns (D6b)', () => {
  const routes = (): Stub[] => [single(draft()), list([])];

  it('reads the mapping the server detected, and marks it automatic', async () => {
    mockApi(routes());

    renderPage(<ImportsPage />, '/audience/imports?job=job-1');

    expect(await screen.findByText(/3 of 5 columns mapped automatically/u)).toBeTruthy();
    expect(screen.getByText('email found')).toBeTruthy();
    expect((screen.getByLabelText('Map tier to') as HTMLSelectElement).value).toBe('loyalty_tier');
  });

  it('prompts for a column nobody has answered for, and greys one that was skipped', async () => {
    // Two different states: "we could not guess this" is a question, and
    // "somebody said no" is an answer. D6b draws them differently.
    mockApi(routes());

    renderPage(<ImportsPage />, '/audience/imports?job=job-1');

    const undecided = (await screen.findByLabelText('Map utm_source to')) as HTMLSelectElement;
    expect(undecided.value).toBe('');
    expect(within(undecided).getByText('Choose a field…')).toBeTruthy();

    const skipped = screen.getByLabelText('Map internal_notes to') as HTMLSelectElement;
    expect(skipped.value).toBe('__skip__');
    expect(screen.getByRole('button', { name: 'Include' })).toBeTruthy();
  });

  it('will not continue without a column mapped to email', async () => {
    mockApi(routes());

    renderPage(<ImportsPage />, '/audience/imports?job=job-1');

    const email = (await screen.findByLabelText('Map email to')) as HTMLSelectElement;
    await userEvent.selectOptions(email, '__skip__');

    const next = screen.getByRole('button', { name: 'Continue to consent' }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(next.getAttribute('title')).toBe('Map a column to Email to continue');
    expect(screen.getByText('email not found')).toBeTruthy();
  });
});

describe('the consent gate (D6c)', () => {
  function consentRoutes(started: { body?: unknown }): Stub[] {
    return [
      { match: (url) => url.endsWith('/audience/lists'), respond: () => ({ body: { data: [] } }) },
      { match: (url) => url.endsWith('/audience/tags'), respond: () => ({ body: { data: [] } }) },
      {
        match: (url) => url.endsWith('/mapping'),
        respond: (_url, init) => {
          started.body = JSON.parse(String(init?.body));
          return { body: { data: job() } };
        },
      },
      single(draft()),
      list([]),
    ];
  }

  it('cannot start an import before consent is attested', async () => {
    mockApi(consentRoutes({}));

    renderPage(<ImportsPage />, '/audience/imports?job=job-1&stage=consent');

    const start = (await screen.findByRole('button', { name: 'Start import' })) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.getAttribute('title')).toBe('Confirm consent to continue');
    expect(screen.getByText('Nothing has been saved yet. Closing this page discards the upload.')).toBeTruthy();
  });

  it('still cannot start with the box ticked and no source chosen', async () => {
    // A pre-selected source would be attested by everybody who clicked past
    // this screen, which is the opposite of what an attestation is for.
    mockApi(consentRoutes({}));

    renderPage(<ImportsPage />, '/audience/imports?job=job-1&stage=consent');

    await userEvent.click(
      await screen.findByLabelText('I confirm these contacts gave consent to receive email from this sender'),
    );

    const start = screen.getByRole('button', { name: 'Start import' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.getAttribute('title')).toBe('Choose where these contacts gave consent');
  });

  it('records the declaration and the source with the mapping', async () => {
    const started: { body?: unknown } = {};
    mockApi(consentRoutes(started));

    renderPage(<ImportsPage />, '/audience/imports?job=job-1&stage=consent');

    await userEvent.click(
      await screen.findByLabelText('I confirm these contacts gave consent to receive email from this sender'),
    );
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Consent source/u }), 'signup_form');
    await userEvent.click(screen.getByRole('button', { name: 'Start import' }));

    await waitFor(() => expect(started.body).toBeDefined());
    const sent = started.body as {
      mapping: Record<string, string>;
      options: { consentSource: string; consentDeclaration: string };
    };
    expect(sent.options.consentSource).toBe('signup_form');
    expect(sent.options.consentDeclaration).toContain(
      'I confirm these contacts gave consent to receive email from this sender',
    );
    // The skipped column never reaches the importer.
    expect(sent.mapping['internal_notes']).toBeUndefined();
    expect(sent.mapping['email']).toBe('email');
  });
});

describe('the status vocabulary', () => {
  it('calls out an import that lost a material share of its rows', () => {
    expect(statusLook({ status: 'completed', failedCount: 78, processedRows: 9_700, totalRows: 9_700 }).label).toBe(
      'Completed with errors',
    );
  });

  it('does not shout about a handful of bad addresses in a large file', () => {
    // D6a: 24 failures in 48,402 rows is "Completed"; the count is still red
    // in its own column.
    expect(statusLook({ status: 'completed', failedCount: 24, processedRows: 48_402, totalRows: 48_402 }).label).toBe(
      'Completed',
    );
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
