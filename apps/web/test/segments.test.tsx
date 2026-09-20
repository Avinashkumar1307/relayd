// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SegmentNode } from '@relayd/audience/browser';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { configureApi } from '../src/api/client.js';
import {
  SegmentBuilderPage,
  SegmentsPage,
  describeDefinition,
  emptyGroup,
  fromDefinition,
  toDefinition,
} from '../src/routes/audience/segments.js';

const fetchMock = vi.fn();

const OWNER = [
  { workspaceId: 'ws-1', workspaceName: 'Northwind Voyages', workspaceSlug: 'northwind-voyages', role: 'owner' },
];

interface Stub {
  match: (url: string) => boolean;
  respond: (url: string, init?: RequestInit) => { status?: number; body: unknown };
}

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
        JSON.stringify({ error: { code: 'not_found', message: url, requestId: 'req_01J9D5FQ7M2X' } }),
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

function renderPage(ui: ReactNode, path = '/audience/segments') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/audience/segments/:id" element={ui} />
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
  cleanup();
  vi.unstubAllGlobals();
});

/** The definition behind D5a's first row. */
const EU_LEISURE: SegmentNode = {
  op: 'and',
  children: [
    {
      op: 'or',
      children: [
        { op: 'attr', path: 'country', cmp: 'eq', value: 'DE' },
        { op: 'attr', path: 'country', cmp: 'eq', value: 'FR' },
      ],
    },
    { op: 'attr', path: 'last_engaged_at', cmp: 'gt', value: '90' },
    { op: 'not', child: { op: 'has_tag', tagId: 'Business' } },
  ],
};

const segment = (extra: Record<string, unknown> = {}) => ({
  id: 'seg_eu_eng',
  name: 'EU leisure · engaged',
  definition: EU_LEISURE,
  cachedCount: 18_420,
  cachedAt: '2026-09-18T07:12:00.000Z',
  createdAt: '2026-05-04T09:00:00.000Z',
  updatedAt: '2026-09-18T07:12:00.000Z',
  lastUsedLabel: 'Autumn Escapes · 19 Sep',
  ...extra,
});

const vocabulary: Stub[] = [
  { match: (url) => url.endsWith('/audience/tags'), respond: () => ({ body: { data: [] } }) },
  { match: (url) => url.endsWith('/audience/lists'), respond: () => ({ body: { data: [] } }) },
];

const segmentsList = (rows: unknown[]): Stub => ({
  match: (url) => url.endsWith('/audience/segments'),
  respond: () => ({ body: { data: rows } }),
});

const preview = (body: Record<string, unknown>, seen?: { definitions: unknown[] }): Stub => ({
  match: (url) => url.includes('/audience/segments/preview'),
  respond: (_url, init) => {
    seen?.definitions.push((JSON.parse(String(init?.body)) as { definition: unknown }).definition);
    return { body: { data: body } };
  },
});

describe('the segment list (D5a, D5e, D5f)', () => {
  it('says what each segment selects in words, not in JSON', async () => {
    mockApi([segmentsList([segment()]), ...vocabulary]);

    renderPage(<SegmentsPage />);

    expect(await screen.findByText('EU leisure · engaged')).toBeTruthy();
    expect(screen.getByText('Country is any of DE, FR')).toBeTruthy();
    expect(screen.getByText('Last engaged within 90 days')).toBeTruthy();
    expect(screen.getByText('Tag is not Business')).toBeTruthy();
    expect(screen.getByText('18,420')).toBeTruthy();
    expect(screen.getByText('Autumn Escapes · 19 Sep')).toBeTruthy();
    expect(screen.getByText('18 Sep 2026')).toBeTruthy();
  });

  it('offers the builder from the empty state, in the frame’s words', async () => {
    mockApi([segmentsList([]), ...vocabulary]);

    renderPage(<SegmentsPage />);

    expect(await screen.findByText('No segments yet')).toBeTruthy();
    expect(
      screen.getByText(
        'Build a segment from fixed rules such as country, tag, list membership and last engagement. Suppressed contacts are always excluded.',
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'New segment' }).length).toBeGreaterThan(0);
  });

  it('gives support the request id when the list will not load', async () => {
    mockApi(vocabulary);

    renderPage(<SegmentsPage />);

    expect(await screen.findByText("We couldn't load segments")).toBeTruthy();
    expect(screen.getByText('req_01J9D5FQ7M2X')).toBeTruthy();
    expect(
      screen.getByText(
        'Scheduled campaigns keep their saved audience. Send support the request ID if it keeps happening.',
      ),
    ).toBeTruthy();
  });
});

describe('the segment builder (D5b)', () => {
  it('will not save a segment with no conditions in it', async () => {
    mockApi([segmentsList([]), ...vocabulary]);

    renderPage(<SegmentBuilderPage />, '/audience/segments/new');

    const save = (await screen.findByRole('button', { name: 'Save segment' })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('title')).toBe('Add at least one condition');
  });

  it('recomputes the preview when a value changes', async () => {
    // A count that lags the rules it claims to describe is worse than no
    // count, because it reads as settled.
    const seen = { definitions: [] as unknown[] };
    mockApi([
      preview({ count: 20_580, capped: true, cap: 10_000, subscribedTotal: 45_102, sample: [] }, seen),
      segmentsList([]),
      ...vocabulary,
    ]);

    renderPage(<SegmentBuilderPage />, '/audience/segments/new');

    await userEvent.type(await screen.findByLabelText('Value'), 'DE');

    expect(await screen.findByText('20,580')).toBeTruthy();
    expect(screen.getByText('matching contacts')).toBeTruthy();
    await waitFor(() => expect(seen.definitions.length).toBeGreaterThan(0));
    expect(seen.definitions[seen.definitions.length - 1]).toEqual({
      op: 'attr',
      path: 'country',
      cmp: 'eq',
      value: 'DE',
    });
  });

  it('says the preview is capped rather than pretending it is the audience', async () => {
    mockApi([
      preview({ count: 20_580, capped: true, cap: 10_000, subscribedTotal: 45_102, sample: [] }),
      segmentsList([]),
      ...vocabulary,
    ]);

    renderPage(<SegmentBuilderPage />, '/audience/segments/new');

    await userEvent.type(await screen.findByLabelText('Value'), 'DE');

    expect(
      await screen.findByText(
        'Preview shows up to 10,000 of 20,580. The full audience is computed at launch.',
      ),
    ).toBeTruthy();
  });

  it('saves the name and the definition together', async () => {
    const saved: { body?: unknown } = {};
    mockApi([
      preview({ count: 12, capped: false, cap: 10_000 }),
      {
        match: (url) => url.endsWith('/audience/segments'),
        respond: (_url, init) => {
          if (init?.method !== 'POST') return { body: { data: [] } };
          saved.body = JSON.parse(String(init.body));
          return { body: { data: segment({ id: 'seg_new' }) } };
        },
      },
      ...vocabulary,
    ]);

    renderPage(<SegmentBuilderPage />, '/audience/segments/new');

    await userEvent.type(await screen.findByLabelText('Value'), 'AE');
    await userEvent.clear(screen.getByLabelText('Segment name'));
    await userEvent.type(screen.getByLabelText('Segment name'), 'UAE leisure');
    await userEvent.click(screen.getByRole('button', { name: 'Save segment' }));

    await waitFor(() => expect(saved.body).toBeDefined());
    expect(saved.body).toEqual({
      name: 'UAE leisure',
      definition: { op: 'attr', path: 'country', cmp: 'eq', value: 'AE' },
    });
  });

  it('keeps the rules readable and every control off in a read-only workspace', async () => {
    // K2: the data stays visible, the writes do not.
    mockApi([
      {
        match: (url) => url.includes('/workspaces/current'),
        respond: () => ({
          body: { data: { id: 'ws-1', name: 'Northwind Voyages', slug: 'northwind-voyages', timezone: 'Asia/Dubai', status: 'suspended' } },
        }),
      },
      preview({ count: 12, capped: false, cap: 10_000 }),
      segmentsList([segment()]),
      ...vocabulary,
    ]);

    renderPage(<SegmentBuilderPage />, '/audience/segments/seg_eu_eng');

    const field = (await screen.findAllByLabelText('Field'))[0] as HTMLSelectElement;
    await waitFor(() => expect(field.disabled).toBe(true));
    expect(field.getAttribute('title')).toBe('Workspace is read-only');
    expect(screen.getByLabelText('Segment name').getAttribute('title')).toBe('Workspace is read-only');
    expect((screen.getByRole('button', { name: 'Save segment' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('predicate rows and the AST', () => {
  it('reads a saved definition back into the same words it was written in', () => {
    const groups = fromDefinition(EU_LEISURE);
    expect(groups).not.toBeNull();
    expect(describeDefinition(EU_LEISURE)).toEqual([
      'Country is any of DE, FR',
      'Last engaged within 90 days',
      'Tag is not Business',
    ]);
    // Round trip: what was read back compiles to what was read.
    expect(toDefinition(groups ?? [])).toEqual(EU_LEISURE);
  });

  it('refuses to draw a definition this editor cannot express', () => {
    // A mixed OR ("country DE or tag VIP") has no row shape. Drawing it as
    // something else would let somebody save a narrower audience than they
    // had without being told.
    expect(
      fromDefinition({
        op: 'and',
        children: [
          {
            op: 'or',
            children: [
              { op: 'attr', path: 'country', cmp: 'eq', value: 'DE' },
              { op: 'has_tag', tagId: 'VIP' },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  it('ignores a row with nothing filled in rather than refusing to save', () => {
    expect(toDefinition([emptyGroup()])).toBeNull();
  });
});
