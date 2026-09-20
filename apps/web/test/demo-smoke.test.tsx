// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { configureApi } from '../src/api/client.js';
import { installDemoServer } from '../src/demo/server.js';

/** Throwaway: does the demo actually render? */

const errors: string[] = [];

beforeAll(() => {
  configureApi({ baseUrl: '/api/v1' });
  installDemoServer();
});

function wrap(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const PAGES = [
  '/dashboard', '/campaigns', '/audience/contacts', '/audience/lists',
  '/audience/tags', '/audience/imports', '/audience/suppressions',
  '/templates', '/providers', '/senders', '/billing', '/billing/plans',
  '/billing/invoices', '/settings/workspace', '/settings/team', '/settings/api',
];

describe('demo renders', () => {
  for (const path of PAGES) {
    it(`renders ${path}`, async () => {
      const view = wrap(path);
      await waitFor(() => {
        expect(document.body.textContent).toBeTruthy();
      }, { timeout: 4000 });
      // Give queries a beat to resolve.
      await new Promise((r) => setTimeout(r, 400));
      const text = view.container.textContent ?? '';
      if (/no fixture for/u.test(text)) errors.push(`${path}: ${/DEMO: no fixture for [A-Z]+ \S+/u.exec(text)?.[0]}`);
      view.unmount();
    });
  }

  it('reports missing fixtures', () => {
    expect(errors).toEqual([]);
  });
});
