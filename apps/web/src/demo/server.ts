import { ROUTES } from './routes/index.js';

/**
 * A fake backend for the UI preview.
 *
 * DEMO ONLY — loaded only when `VITE_DEMO=1`.
 *
 * It replaces `window.fetch` and answers `/api/v1/*` from the route table
 * in `routes/`. Everything else falls through to the real fetch, so Vite's
 * own requests still work. This file is only the transport now: the routes
 * live one file per section, the fixtures one file per section under
 * `data/`, and the in-memory store in `state.ts`.
 *
 * ## The paths and shapes here are read off the client, not guessed
 *
 * That matters more than it sounds. The first version of this file invented
 * `/billing/overview` and `{ contacts: [...] }` — both plausible, both
 * wrong — and the pages rendered their empty and error states instead of
 * the screens. `apps/web/test/demo-smoke.test.tsx` renders every page
 * against this server and fails on any unrouted request, which is what
 * catches that.
 *
 * Two envelope shapes exist and they are not interchangeable:
 *   most routes answer `{ data }`
 *   paged routes answer `{ data, meta }` — marked `paged: true` on the route
 *
 * Mutations apply to in-memory copies, so the flow is clickable: creating a
 * list adds a row, revoking a key greys it out, launching a campaign moves
 * it to `sending`. Reload and it all goes back.
 */

function respond(value: unknown, status = 200, paged = false): Response {
  const envelope =
    status >= 400 ? value : paged ? { data: value, meta: { hasMore: false } } : { data: value };

  return new Response(JSON.stringify(envelope), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function installDemoServer(): void {
  const real = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();

    if (!url.includes('/api/v1')) return real(input as RequestInfo, init);

    const path = new URL(url, window.location.origin).pathname.replace(/^\/api\/v1/u, '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;

    for (const route of ROUTES) {
      if (route.method !== method) continue;

      const match = route.pattern.exec(path);
      if (match === null) continue;

      // A little latency, so loading states are visible rather than flashing
      // past. This is a preview of the flow, and a spinner nobody ever sees
      // is a spinner nobody has checked.
      await new Promise((resolve) => setTimeout(resolve, 80));

      return respond(route.handler(match, body), 200, route.paged === true);
    }

    // Anything unrouted answers with the real error envelope, so an
    // unhandled screen shows the application's own error state rather than a
    // blank page. `demo-smoke.test.tsx` fails on any of these.
    return respond(
      {
        error: {
          code: 'not_found',
          message: `DEMO: no fixture for ${method} ${path}`,
          requestId: 'demo-request',
        },
      },
      404,
    );
  };
}
