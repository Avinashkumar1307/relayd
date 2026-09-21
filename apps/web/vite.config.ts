import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The dev server.
 *
 * `api/client.ts` calls `/api/v1/*` on its own origin, in development and in
 * production alike, so that no build carries an environment-specific base
 * URL. In production CloudFront routes that prefix to the ALB. In development
 * the proxy below is what makes the same path work — without it the SPA's
 * calls hit Vite itself and 404, which looks exactly like an API that is down.
 *
 * The target is the port `.env` gives the api process. It is written out
 * rather than read from `process.env`, because `relayd/no-process-env` allows
 * that read only inside `packages/config`, and a Vite config cannot take a
 * parsed runtime value: it runs before the app exists. Running the API
 * somewhere else is an edit to this line.
 *
 * `changeOrigin` is off deliberately: the API sets a refresh cookie, and
 * rewriting the Host header is how that cookie ends up scoped to the wrong
 * origin and silently never sent back.
 */
const API_TARGET = 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
