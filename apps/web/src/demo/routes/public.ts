import type { Route } from '../state.js';

/**
 * Section A demo routes: the public pages.
 *
 * DEMO ONLY — loaded only when `VITE_DEMO=1`.
 *
 * The public pages fetch nothing. A1 is marketing copy and A2's plan cards
 * are copy too (there is no unauthenticated plans endpoint), so there is no
 * fixture for either.
 *
 * ## `?anon=1`
 *
 * What section A does need is a way to *be* signed out. The preview signs
 * you in — `POST /auth/refresh` always answers with a session — and A1 then
 * redirects to the dashboard, exactly as it should for a signed-in visitor,
 * which leaves the landing page unreachable in the preview and
 * unscreenshottable against its frame.
 *
 * So: load the app with `?anon=1` and refresh fails instead, which is what
 * an anonymous visitor's refresh does. The route is only registered when
 * the flag is present, so with no flag section B's handler answers as
 * before and nothing else in the preview changes. The public pages and the
 * B auth pages are the only screens this is useful for; every authenticated
 * page will bounce to /login while it is on.
 */
const anonymousPreview = (): boolean => {
  try {
    return new URLSearchParams(window.location.search).get('anon') === '1';
  } catch {
    return false;
  }
};

export const routes: Route[] = anonymousPreview()
  ? [
      {
        method: 'POST',
        pattern: /^\/auth\/refresh$/u,
        handler: () => {
          // Rejecting the fetch is what the client sees when there is no
          // refresh cookie; AuthProvider catches it and goes anonymous.
          throw new Error('DEMO: anonymous preview (?anon=1)');
        },
      },
    ]
  : [];

/**
 * SPA paths the demo smoke test walks for this section.
 *
 * "/" renders the dashboard under the smoke test, which signs in: that is
 * the route's authenticated half, and the anonymous half is covered by
 * `apps/web/test/public-pages.test.tsx`.
 */
export const previewPaths: string[] = ['/', '/pricing'];
