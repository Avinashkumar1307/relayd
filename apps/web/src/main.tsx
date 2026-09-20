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
