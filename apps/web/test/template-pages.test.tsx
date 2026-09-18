// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { configureApi } from '../src/api/client.js';
import { TemplateEditorPage, TemplatesPage } from '../src/routes/templates/templates.js';

const fetchMock = vi.fn();
const OWNER = [{ workspaceId: 'ws-1', workspaceName: 'Acme', workspaceSlug: 'acme', role: 'owner' }];
const VIEWER = [{ workspaceId: 'ws-1', workspaceName: 'Acme', workspaceSlug: 'acme', role: 'viewer' }];

interface Route_ {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => { status?: number; body: unknown };
}

function mockApi(routes: Route_[], role = OWNER) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('/auth/refresh')) {
      return new Response(JSON.stringify({ data: { accessToken: 't', memberships: role } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
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
  configureApi({ baseUrl: '/api/v1' });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    templateId: 't1',
    version: 1,
    subject: 'Hi {{ first_name | there }}',
    preheader: null,
    htmlSource: '<p>Hello {{ first_name | there }}</p>',
    htmlCompiled: '<p>Hello {{ first_name | there }}</p>',
    textBody: 'Hello {{ first_name | there }}',
    variables: [{ field: 'first_name', default: 'there', required: false }],
    publishedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const TEMPLATE = {
  id: 't1',
  name: 'Welcome',
  category: null,
  currentVersionId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function editorRoutes(v = version(), overrides: Route_[] = []) {
  return [
    ...overrides,
    {
      match: (url: string) => url.includes('/templates/t1') && !url.includes('/versions'),
      respond: () => ({ body: { data: { template: TEMPLATE, versions: [v] } } }),
    },
  ];
}

describe('the template list', () => {
  it('distinguishes a published template from a draft-only one', async () => {
    mockApi([
      {
        match: (url) => url.endsWith('/templates'),
        respond: () => ({
          body: {
            data: [
              TEMPLATE,
              { ...TEMPLATE, id: 't2', name: 'Newsletter', currentVersionId: 'v9' },
            ],
          },
        }),
      },
    ]);

    renderAt(<TemplatesPage />, '/templates');

    expect(await screen.findByText('Welcome')).toBeTruthy();

    // Scoped to the rows: "Published" is also the column heading.
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0] as HTMLElement).getByText('Draft only')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Published')).toBeTruthy();
  });

  it('hides create and delete from a viewer', async () => {
    mockApi(
      [{ match: (url) => url.endsWith('/templates'), respond: () => ({ body: { data: [TEMPLATE] } }) }],
      VIEWER,
    );

    renderAt(<TemplatesPage />, '/templates');
    await screen.findByText('Welcome');

    expect(screen.queryByRole('link', { name: 'New template' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('the editor', () => {
  it('loads the author’s own markup, not the compiled output', async () => {
    // The author must be able to edit back what they wrote.
    mockApi(
      editorRoutes(version({ htmlSource: '<p>ORIGINAL</p>', htmlCompiled: '<p>COMPILED</p>' })),
    );

    renderAt(<TemplateEditorPage />);

    const html = (await screen.findByLabelText('HTML')) as HTMLTextAreaElement;
    expect(html.value).toContain('ORIGINAL');
    expect(html.value).not.toContain('COMPILED');
  });

  it('says a published version cannot be changed', async () => {
    mockApi(editorRoutes(version({ publishedAt: '2026-01-02T00:00:00.000Z' })));

    renderAt(<TemplateEditorPage />);

    expect(await screen.findByText(/cannot be changed/u)).toBeTruthy();
    // And offers the only thing that is possible.
    expect(screen.getByRole('button', { name: 'Save as new version' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('offers publish only for a draft', async () => {
    mockApi(editorRoutes());

    renderAt(<TemplateEditorPage />);

    expect(await screen.findByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeTruthy();
  });

  it('inserts a merge tag with a fallback', async () => {
    // A tag with no fallback is how a campaign goes out saying "Hi ,".
    //
    // Asserted on what was appended, not on the whole value: the starting
    // markup already contains this tag, so `toContain` would pass whatever
    // the button inserted.
    mockApi(editorRoutes(version({ htmlSource: '<p>Nothing here yet.</p>' })));

    renderAt(<TemplateEditorPage />);

    const html = (await screen.findByLabelText('HTML')) as HTMLTextAreaElement;
    const before = html.value;

    await userEvent.click(screen.getByRole('button', { name: 'First name' }));

    expect(html.value.slice(before.length)).toBe('{{ first_name | there }}');
  });

  it('warns about a tag with no fallback', async () => {
    mockApi(editorRoutes(version({ variables: [{ field: 'company', default: '', required: true }] })));

    renderAt(<TemplateEditorPage />);

    expect(await screen.findByText(/no fallback/u)).toBeTruthy();
  });

  it('sends the text part only once the author has edited it', async () => {
    // Otherwise every save freezes a generated text part, and it stops
    // tracking the HTML.
    const bodies: unknown[] = [];
    mockApi(
      editorRoutes(version(), [
        {
          match: (url, init) => url.includes('/versions') && init?.method === 'POST',
          respond: (_url, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return { status: 201, body: { data: version() } };
          },
        },
      ]),
    );

    renderAt(<TemplateEditorPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).not.toHaveProperty('text');

    await userEvent.type(screen.getByLabelText('Plain text'), ' edited');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toHaveProperty('text');
  });

  it('hides save and publish from a viewer', async () => {
    mockApi(editorRoutes(), VIEWER);

    renderAt(<TemplateEditorPage />);
    await screen.findByLabelText('HTML');

    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    // Preview is a read, so it stays.
    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy();
  });
});

describe('the preview', () => {
  const preview = {
    subject: 'Hi Sam',
    html: '<p>Hello Sam</p>',
    text: 'Hello Sam',
    templateVersionId: 'v1',
    version: 1,
    published: false,
  };

  function withPreview() {
    return editorRoutes(version(), [
      {
        match: (url: string) => url.includes('/preview'),
        respond: () => ({ body: { data: preview } }),
      },
    ]);
  }

  it('renders inside a sandboxed frame with no same-origin and no scripts', async () => {
    // docs/06: a preview on the app origin is how a malicious template steals
    // sessions. An empty sandbox gives the frame an opaque origin, so it can
    // reach neither our cookies nor our DOM.
    mockApi(withPreview());

    renderAt(<TemplateEditorPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Preview' }));

    const frame = (await screen.findByTitle('Email preview')) as HTMLIFrameElement;

    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain('Hello Sam');
  });

  it('shows the subject outside the frame, where it is escaped by React', async () => {
    mockApi(withPreview());

    renderAt(<TemplateEditorPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Preview' }));

    expect(await screen.findByText('Hi Sam')).toBeTruthy();
  });

  it('switches between desktop and mobile widths', async () => {
    mockApi(withPreview());

    renderAt(<TemplateEditorPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Preview' }));

    const frame = (await screen.findByTitle('Email preview')) as HTMLIFrameElement;
    expect(frame.style.width).toBe('100%');

    await userEvent.click(screen.getByRole('button', { name: 'Mobile' }));
    expect((screen.getByTitle('Email preview') as HTMLIFrameElement).style.width).toBe('375px');
  });

  it('names the version it rendered', async () => {
    // A campaign records this id at launch; the preview is where an author
    // confirms which version they are committing to.
    mockApi(withPreview());

    renderAt(<TemplateEditorPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Preview' }));

    expect(await screen.findByText('v1')).toBeTruthy();
  });

  it('shows the plain-text part too', async () => {
    mockApi(withPreview());

    renderAt(<TemplateEditorPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Preview' }));

    expect(await screen.findByText('Plain text version')).toBeTruthy();
  });
});
