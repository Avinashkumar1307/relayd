// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { configureApi } from '../src/api/client.js';
import { TemplatesPage } from '../src/routes/templates/list.js';
import { TemplateEditorPage } from '../src/routes/templates/editor.js';

/**
 * Section F, tested on the frames' rules rather than on pixels.
 *
 * What the tests hold onto: the card carries the *newest* version's state, a
 * published version cannot be edited or republished, a merge tag is inserted
 * literally and never interpolated in the app, the lint strip reports what
 * F2a's strip reports, and a missing permission disables the action and says
 * why instead of hiding the reason.
 */

const fetchMock = vi.fn();
const OWNER = [{ workspaceId: 'ws-1', workspaceName: 'Acme', workspaceSlug: 'acme', role: 'owner' }];
const VIEWER = [{ workspaceId: 'ws-1', workspaceName: 'Acme', workspaceSlug: 'acme', role: 'viewer' }];

interface Stub {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => { status?: number; body: unknown };
}

const calls: { url: string; method: string; body: unknown }[] = [];

function mockApi(routes: Stub[], role = OWNER) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });

    if (url.includes('/auth/refresh')) {
      return new Response(
        JSON.stringify({
          data: {
            accessToken: 't',
            memberships: role,
            user: { id: 'u1', name: 'Dana Haddad', email: 'dana@northwind.travel' },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    const route = routes.find((candidate) => candidate.match(url, init));
    const result = route?.respond(url, init) ?? { body: { data: [] } };

    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function renderAt(ui: ReactNode, path = '/templates/t1') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/templates" element={ui} />
            <Route path="/templates/:id" element={ui} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  calls.length = 0;
  configureApi({ baseUrl: '/api/v1' });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------- fixtures -- */

const HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<body>',
  '  <img src="logo.png" width="120">',
  '  <p>Hi {{first_name|"there"}}, your {{loyalty_tier|"Member"}} fares are open.</p>',
  '  <a href="{{unsubscribe_url}}">Unsubscribe</a>',
  '</body>',
  '</html>',
].join('\n');

const TEMPLATE = {
  id: 't1',
  name: 'Autumn escapes',
  category: 'campaign',
  currentVersionId: 'v6',
  state: 'draft',
  versionCount: 7,
  editedLabel: 'Edited 2 min ago by Dana Haddad',
  archived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z',
};

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v7',
    templateId: 't1',
    version: 7,
    subject: 'Autumn escapes from {{home_airport|"DXB"}}',
    preheader: 'Gold fares to Santorini open today.',
    htmlSource: HTML,
    htmlCompiled: HTML,
    textBody: 'Autumn escapes.',
    variables: [{ field: 'first_name', default: 'there', required: false }],
    publishedAt: null,
    createdAt: '2026-09-19T00:00:00.000Z',
    savedLabel: 'Saved 2 min ago',
    ...overrides,
  };
}

const PUBLISHED_V6 = version({
  id: 'v6',
  version: 6,
  publishedAt: '2026-09-15T14:20:00.000Z',
  publishedLabel: 'Published 15 Sep 2026, 14:20 by Farah Al-Mansoori',
  campaigns: [{ id: 'cmp_8f3k2a', name: 'Autumn Escapes: Dubai to Santorini', status: 'sending' }],
});

function editorStubs(versions: unknown[] = [version(), PUBLISHED_V6], extra: Stub[] = []): Stub[] {
  return [
    ...extra,
    {
      match: (url, init) => url.includes('/preview') && (init?.method ?? 'GET') === 'POST',
      respond: () => ({
        body: {
          data: {
            subject: 'Autumn escapes from DXB',
            html: '<p>Hi Amira</p>',
            text: 'Hi Amira',
            preheader: 'Gold fares to Santorini open today.',
            fromName: 'Northwind Voyages',
            fromEmail: 'hello@northwind.travel',
            templateVersionId: 'v7',
            version: 7,
            published: false,
          },
        },
      }),
    },
    {
      match: (url, init) => url.includes('/templates/t1/versions') && (init?.method ?? 'GET') === 'POST',
      respond: () => ({ body: { data: version({ id: 'v8', version: 8 }) } }),
    },
    {
      match: (url) => /\/templates\/t1(\?|$)/u.test(url),
      respond: () => ({ body: { data: { template: TEMPLATE, versions } } }),
    },
  ];
}

/* --------------------------------------------------------------- F1 grid -- */

describe('F1 — the template grid', () => {
  it('shows the newest version’s state and the version count on each card', async () => {
    mockApi([
      {
        match: (url) => url.endsWith('/templates'),
        respond: () => ({
          body: {
            data: [
              TEMPLATE,
              {
                ...TEMPLATE,
                id: 't2',
                name: 'Monthly newsletter',
                state: 'published',
                versionCount: 1,
                editedLabel: 'Edited 8 Sep by Julien Moreau',
              },
            ],
          },
        }),
      },
    ]);

    renderAt(<TemplatesPage />, '/templates');

    const first = (await screen.findByText('Autumn escapes')).closest('li') as HTMLElement;
    expect(within(first).getByText('Draft')).toBeTruthy();
    expect(within(first).getByText('7 versions')).toBeTruthy();
    expect(within(first).getByText('Edited 2 min ago by Dana Haddad')).toBeTruthy();

    const second = screen.getByText('Monthly newsletter').closest('li') as HTMLElement;
    expect(within(second).getByText('Published')).toBeTruthy();
    // Singular, not "1 versions".
    expect(within(second).getByText('1 version')).toBeTruthy();
  });

  it('separates active from archived', async () => {
    mockApi([
      {
        match: (url) => url.endsWith('/templates'),
        respond: () => ({
          body: { data: [TEMPLATE, { ...TEMPLATE, id: 't9', name: 'Eid 2025 offers', archived: true }] },
        }),
      },
    ]);

    renderAt(<TemplatesPage />, '/templates');
    await screen.findByText('Autumn escapes');

    expect(screen.queryByText('Eid 2025 offers')).toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: /Archived/u }));

    expect(screen.getByText('Eid 2025 offers')).toBeTruthy();
    expect(screen.queryByText('Autumn escapes')).toBeNull();
  });

  it('offers one action from the empty state, in the frame’s words', async () => {
    mockApi([{ match: (url) => url.endsWith('/templates'), respond: () => ({ body: { data: [] } }) }]);

    renderAt(<TemplatesPage />, '/templates');

    expect(await screen.findByText('No templates yet')).toBeTruthy();
    expect(
      screen.getByText(
        /Start from a blank HTML template or paste your own\. Merge tags with fallbacks, an unsubscribe link and a plain-text version are checked before publishing\./u,
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /New template/u }).length).toBeGreaterThan(0);
  });

  it('shows the request id when the list fails', async () => {
    mockApi([
      {
        match: (url) => url.endsWith('/templates'),
        respond: () => ({
          status: 500,
          body: {
            error: { code: 'internal', message: 'Upstream failed', requestId: 'req_01J9F1FT4K8Q' },
          },
        }),
      },
    ]);

    renderAt(<TemplatesPage />, '/templates');

    expect(await screen.findByText("We couldn't load templates")).toBeTruthy();
    expect(screen.getByText(/Published versions used by campaigns are unaffected/u)).toBeTruthy();
    expect(screen.getByText('req_01J9F1FT4K8Q')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('hides create from a viewer and says why archiving is refused', async () => {
    mockApi(
      [{ match: (url) => url.endsWith('/templates'), respond: () => ({ body: { data: [TEMPLATE] } }) }],
      VIEWER,
    );

    renderAt(<TemplatesPage />, '/templates');
    await screen.findByText('Autumn escapes');

    expect(screen.queryByRole('button', { name: /New template/u })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Autumn escapes' }));

    const archive = screen.getByRole('menuitem', { name: 'Archive' });
    expect(archive.getAttribute('aria-disabled')).toBe('true');
    expect(archive.getAttribute('title')).toBe('Your role cannot change templates');
  });
});

/* ------------------------------------------------------------- F2 editor -- */

describe('F2 — the editor', () => {
  it('loads the author’s own markup, not the compiled output', async () => {
    mockApi(editorStubs([version({ htmlSource: '<p>ORIGINAL</p>', htmlCompiled: '<p>COMPILED</p>' })]));

    renderAt(<TemplateEditorPage />);

    const html = (await screen.findByLabelText('Template HTML')) as HTMLTextAreaElement;
    expect(html.value).toContain('ORIGINAL');
    expect(html.value).not.toContain('COMPILED');
  });

  it('reports the frame’s three checks under the source', async () => {
    mockApi(editorStubs());

    renderAt(<TemplateEditorPage />);

    expect(await screen.findByText('Unsubscribe link present')).toBeTruthy();
    expect(screen.getByText('All merge tags have fallbacks')).toBeTruthy();
    // The `<img>` on line 4 of the fixture carries no alt.
    expect(screen.getByText(/1 image without alt text · line 4/u)).toBeTruthy();
  });

  it('warns when a merge tag has no fallback', async () => {
    mockApi(editorStubs([version({ htmlSource: '<p>Hi {{company}}</p>' })]));

    renderAt(<TemplateEditorPage />);

    expect(await screen.findByText(/1 merge tag without a fallback · company/u)).toBeTruthy();
    // And the unsubscribe link, which this markup does not have.
    expect(screen.getByText('Unsubscribe link missing')).toBeTruthy();
  });

  it('inserts a merge tag literally, fallback and all', async () => {
    mockApi(editorStubs([version({ htmlSource: '<p>Nothing here yet.</p>' })]));

    renderAt(<TemplateEditorPage />);

    const html = (await screen.findByLabelText('Template HTML')) as HTMLTextAreaElement;

    await userEvent.click(screen.getByRole('button', { name: /Insert merge tag/u }));
    await userEvent.click(screen.getByRole('menuitem', { name: /first_name/u }));

    // Written into the source, not rendered: the app never interpolates.
    expect(html.value).toContain('{{first_name|"there"}}');
  });

  it('refuses to change or republish a published version', async () => {
    mockApi(editorStubs([PUBLISHED_V6]));

    renderAt(<TemplateEditorPage />);

    const html = (await screen.findByLabelText('Template HTML')) as HTMLTextAreaElement;
    expect(html.readOnly).toBe(true);
    expect(screen.getByText(/is published and immutable/u)).toBeTruthy();

    const publish = screen.getByRole('button', { name: 'Publish v6' });
    expect(publish.hasAttribute('disabled')).toBe(true);
    expect(publish.getAttribute('title')).toBe('Published versions are immutable');
  });

  it('saves a draft by posting a new version', async () => {
    mockApi(editorStubs());

    renderAt(<TemplateEditorPage />);
    await screen.findByLabelText('Template HTML');

    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      expect(
        calls.some((call) => call.method === 'POST' && call.url.includes('/templates/t1/versions')),
      ).toBe(true);
    });
  });

  it('shows the version history and restores an older version as a new draft', async () => {
    mockApi(editorStubs());

    renderAt(<TemplateEditorPage />);
    await screen.findByLabelText('Template HTML');

    expect(screen.queryByText('Version history', { selector: 'span' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Version history/u }));

    expect(screen.getByText('2 versions')).toBeTruthy();
    expect(screen.getByText('Published 15 Sep 2026, 14:20 by Farah Al-Mansoori')).toBeTruthy();
    // The campaign that sent it, so "immutable" has a reason on screen.
    expect(screen.getByText('Autumn Escapes: Dubai to Santorini')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Restore as new draft' }));

    await waitFor(() => {
      expect(
        calls.some((call) => call.method === 'POST' && call.url.includes('/templates/t1/versions')),
      ).toBe(true);
    });
  });

  it('says where the unsubscribe link is, on the settings tab', async () => {
    mockApi(editorStubs());

    renderAt(<TemplateEditorPage />);
    await screen.findByLabelText('Template HTML');

    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    expect(screen.getByText('Merge tags work here too. Campaigns can override the subject.')).toBeTruthy();
    expect(screen.getByText(/Present in HTML · line 6/u)).toBeTruthy();
    expect(screen.getByText('RFC 8058 one-click, added at send time')).toBeTruthy();
    expect(screen.getAllByText('Always on').length).toBe(2);
  });

  it('previews as a named contact and switches to the mobile width', async () => {
    mockApi(editorStubs());

    renderAt(<TemplateEditorPage />);

    const frame = (await screen.findByTitle('Email preview')) as HTMLIFrameElement;
    await waitFor(() => {
      expect(frame.getAttribute('srcdoc')).toContain('Hi Amira');
    });
    // Sandboxed with no `allow-same-origin`: an opaque origin, per docs/06.
    expect(frame.getAttribute('sandbox')).toBe('');

    const mobile = screen.getByRole('button', { name: 'Mobile' });
    await userEvent.click(mobile);
    expect(mobile.getAttribute('aria-pressed')).toBe('true');
  });
});
