import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { App } from './App.js';
import { AuthProvider } from './auth/AuthProvider.js';
import { configureApi } from './api/client.js';
import { createQueryClient } from './query-client.js';
import { applyTheme, initialTheme } from '@relayd/ui';
import './index.css';

// Same origin in development (Vite proxies) and in production (CloudFront
// routes /api/* to the ALB), so a relative base needs no per-environment build.
configureApi({ baseUrl: '/api/v1' });

// One attribute on <html> drives every token (packages/ui/src/tokens.css).
// Set before the first render so nothing flashes light then dark.
applyTheme(initialTheme());

/**
 * PREVIEW ONLY. With VITE_DEMO=1 a fake backend replaces `window.fetch` and
 * answers from fixtures, so every page can be walked with no API behind it
 * (CLAUDE.md section 16). Off by default, and the import is dynamic so none
 * of it reaches a normal build. Never set this in a deployed environment.
 */
async function installPreviewBackend(): Promise<void> {
  if (import.meta.env.VITE_DEMO !== '1') return;

  const { installDemoServer } = await import('./demo/server.js');
  installDemoServer();

  // ?theme=dark lets scripts/design/shoot-app.py screenshot both themes; a
  // headless browser has no way to set the stored preference.
  const requested = new URLSearchParams(window.location.search).get('theme');
  if (requested === 'light' || requested === 'dark') applyTheme(requested);
}

/**
 * Boot.
 *
 * The await lives in here rather than at the top level on purpose: a
 * top-level await compiles to nothing the build's browser targets accept
 * (es2020 and Safari 14 among them), so `vite build` fails outright on it
 * while the dev server is perfectly happy — the one shape that passes every
 * local check and breaks only in CI. Rendering still waits for the preview
 * backend, which it must: React starts fetching on its first paint, and a
 * fake `fetch` installed after that races the first request.
 */
async function boot(): Promise<void> {
  await installPreviewBackend();

  const container = document.getElementById('root');
  if (container === null) {
    throw new Error('Missing #root element');
  }

  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={createQueryClient()}>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void boot();
