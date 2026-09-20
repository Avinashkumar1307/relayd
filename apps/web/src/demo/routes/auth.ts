import type { Route } from '../state.js';
import { id, nowIso } from '../state.js';
import { invitation, session } from '../data/auth.js';

/**
 * Section B demo routes: authentication, invitations and workspace creation.
 *
 * DEMO ONLY. Every credential path succeeds — the preview is about the
 * screens, not the checks — so login, register and refresh all hand back the
 * same session.
 *
 * ## Reaching the signed-out and failed frames
 *
 * The transport only ever answers 200 and the app's own guards bounce a
 * signed-in visitor away from B1, B2 and B5b, so three of the frames are
 * unreachable in the preview unless the demo can be told to forget the
 * session. It can, on the SPA's own query string, and the flag is read once
 * when this module loads because a preview shot is always a fresh page load:
 *
 *   /login?demo=anon          B1, B2, B5b — no session at all
 *   /verify?token=expired     B3c — the link is past its 24 hours
 *   /verify?token=ok          B3b — the link is good
 *   /verify                   B3a — no link followed yet
 *
 * A token the app does not recognise is the honest failure for an
 * invitation, so `/invite/expired` draws the "no longer valid" card.
 */

function signedOut(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('demo') === 'anon';
  } catch {
    return false;
  }
}

const ANONYMOUS = signedOut();

export const routes: Route[] = [
  { method: 'POST', pattern: /^\/auth\/(login|register)$/u, handler: () => session },

  // Left unrouted under ?demo=anon: the transport then answers the real
  // 404 envelope, AuthProvider treats the failed refresh as "nobody is
  // signed in", and the signed-out frames render.
  ...(ANONYMOUS
    ? []
    : [{ method: 'POST', pattern: /^\/auth\/refresh$/u, handler: () => session }]),

  { method: 'POST', pattern: /^\/auth\/logout$/u, handler: () => ({}) },
  {
    method: 'POST',
    pattern: /^\/auth\/(forgot-password|reset-password|resend-verification)$/u,
    handler: () => ({ ok: true }),
  },
  {
    method: 'POST',
    pattern: /^\/auth\/verify-email$/u,
    handler: (_match, body) => {
      const token = (body as { token?: string } | undefined)?.token ?? '';
      return { verified: token !== 'expired', email: session.user.email };
    },
  },
  {
    method: 'GET',
    pattern: /^\/auth\/sessions$/u,
    handler: () => [
      {
        id: 'sess1',
        userAgent: 'Chrome on Windows',
        ip: '203.0.113.4',
        current: true,
        createdAt: nowIso(),
        lastSeenAt: nowIso(),
      },
    ],
  },

  /* ---- B5 invitations ----------------------------------------------- */

  {
    method: 'GET',
    pattern: /^\/invitations\/([^/]+)$/u,
    handler: (match) => {
      // The transport has no way to answer a status other than 200, so the
      // one failure this page has a frame for is produced the only way it
      // can be: by rejecting the request.
      if (match[1] === 'expired') throw new Error('DEMO: this invitation is no longer valid');
      return invitation;
    },
  },
  { method: 'POST', pattern: /^\/invitations\/accept$/u, handler: () => ({ ok: true }) },
  { method: 'POST', pattern: /^\/invitations\/([^/]+)\/register$/u, handler: () => session },

  /* ---- B6a creating a workspace -------------------------------------- */

  {
    method: 'POST',
    pattern: /^\/workspaces$/u,
    handler: (_match, body) => {
      const input = body as { name?: string; slug?: string; timezone?: string } | undefined;
      return {
        id: id('ws'),
        name: input?.name ?? 'New workspace',
        slug: input?.slug ?? 'new-workspace',
        timezone: input?.timezone ?? 'UTC',
      };
    },
  },
];

/**
 * SPA paths the demo smoke test walks for this section.
 *
 * B1, B2 and B5b are missing on purpose: the smoke test renders with the
 * preview session in place, and the guards send a signed-in visitor from
 * /login and /register to the app. They are shot with `?demo=anon` instead.
 */
export const previewPaths: string[] = [
  '/get-started',
  '/verify',
  '/forgot-password',
  '/reset-password/demo-token',
  '/invite/demo-token',
  '/workspaces/new',
];
