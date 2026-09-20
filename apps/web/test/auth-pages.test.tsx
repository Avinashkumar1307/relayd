// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { configureApi } from '../src/api/client.js';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { RegisterPage } from '../src/routes/auth/register.js';
import { VerifyEmailPage } from '../src/routes/auth/verify-email.js';
import { ForgotPasswordPage } from '../src/routes/auth/forgot-password.js';
import { ResetPasswordPage } from '../src/routes/auth/reset-password.js';
import { AcceptInvitationPage } from '../src/routes/auth/accept-invitation.js';
import { CreateWorkspacePage, slugify } from '../src/routes/auth/create-workspace.js';
import { GetStartedPage } from '../src/routes/auth/get-started.js';
import { strengthOf } from '../src/routes/auth/password-strength.js';

/**
 * Section B — register, verify, reset, invitation, workspace, checklist.
 *
 * The rules asserted here are the ones a redesign quietly removes, and each
 * is either a frame's rule or a security control:
 *
 *   B2 and B4b keep their submit disabled until the frame's condition is
 *   met, and say in the tooltip which half is missing;
 *   B4a's sent state never reveals whether an account exists — the same card
 *   and the same sentence whatever the server answered, which is the whole
 *   reason docs/06 makes the endpoint answer 202 either way;
 *   B3a's resend is on a 30-second cooldown and the button says so;
 *   B5b fixes the address to the invitation's and does not offer it as an
 *   input, because accepting with another address is not the same offer;
 *   B6b derives its four steps from the collection endpoints, so a locked
 *   step is locked because of what those endpoints say.
 */

const responses = new Map<string, unknown>();
const sent: { method: string; url: string; body?: unknown }[] = [];

const SESSION = {
  accessToken: 'tok',
  user: { id: 'usr_omar', name: 'Omar Haddad', email: 'omar.h@northwind.travel' },
  memberships: [
    {
      workspaceId: 'ws_nv',
      workspaceName: 'Northwind Voyages',
      workspaceSlug: 'northwind-voyages',
      role: 'owner',
    },
  ],
};

const INVITATION = {
  workspaceName: 'Northwind Voyages',
  workspaceMonogram: 'NV',
  inviterName: 'Farah Al-Mansoori',
  invitedAt: '2026-09-18T06:00:00.000Z',
  expiresAt: '2026-09-25T06:00:00.000Z',
  role: 'editor',
  email: 'omar.h@northwind.travel',
};

beforeEach(() => {
  configureApi({ baseUrl: '/api/v1' });
  responses.clear();
  sent.length = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      sent.push({
        method,
        url,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });

      // Longest matching pattern wins, so "/auth/resend-verification" is not
      // answered by a stub registered for "/auth".
      const match = [...responses.entries()]
        .filter(([pattern]) => {
          const [patternMethod, patternPath] = pattern.split(' ');
          return method === patternMethod && url.includes(String(patternPath));
        })
        .sort((a, b) => b[0].length - a[0].length)[0];

      if (match === undefined) {
        return new Response(
          JSON.stringify({ error: { code: 'not_found', message: 'no stub', requestId: 'req_stub' } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }

      const body = match[1];
      if (typeof body === 'object' && body !== null && '__error' in body) {
        const error = body as { __error: { status: number; body: unknown } };
        return new Response(JSON.stringify(error.__error.body), {
          status: error.__error.status,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ data: body }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Nobody is signed in: the refresh cookie buys nothing. */
function anonymous(): void {
  responses.set('POST /auth/refresh', {
    __error: { status: 401, body: { error: { code: 'unauthenticated', message: 'no', requestId: 'r' } } },
  });
}

function signedIn(): void {
  responses.set('POST /auth/refresh', SESSION);
}

function wrap(children: ReactNode, path: string, pattern = (path.split('?')[0] ?? path)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path={pattern} element={children} />
            <Route path="*" element={<div>redirected</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/* ================================================================== */
/* B2 Create your account /register                                    */
/* ================================================================== */

describe('B2 Create your account', () => {
  const STRONG = 'Northwind-2026!';

  it('renders the frame: heading, fields, consent and a disabled submit', async () => {
    anonymous();
    wrap(<RegisterPage />, '/register');

    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeTruthy();
    expect(screen.getByText('Free to start. No card needed.')).toBeTruthy();
    expect(screen.getByLabelText('Full name')).toBeTruthy();
    expect(screen.getByLabelText('Work email')).toBeTruthy();
    expect(screen.getByText("We'll send a verification link here.")).toBeTruthy();
    expect(screen.getByText(/I will only email people who have consented/u)).toBeTruthy();

    const submit = screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute('title')).toBe('Choose a stronger password');
  });

  it('unlocks only when the password is strong and the terms are accepted', async () => {
    anonymous();
    const user = userEvent.setup();
    wrap(<RegisterPage />, '/register');

    await screen.findByRole('heading', { name: 'Create your account' });
    const submit = () => screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement;

    await user.type(screen.getByLabelText('Password'), STRONG);
    // Strong, but the attestation is still unticked — and the tooltip now
    // names that half rather than the password.
    expect(submit().disabled).toBe(true);
    expect(submit().getAttribute('title')).toBe('Accept the terms to continue');

    await user.click(screen.getByRole('checkbox'));
    expect(submit().disabled).toBe(false);
    expect(submit().getAttribute('title')).toBe('Create account');
  });

  it('registers and sends the new account to B3a rather than into the app', async () => {
    anonymous();
    responses.set('POST /auth/register', { ok: true });
    const user = userEvent.setup();
    wrap(<RegisterPage />, '/register');

    await screen.findByRole('heading', { name: 'Create your account' });
    await user.type(screen.getByLabelText('Full name'), 'Dana Haddad');
    await user.type(screen.getByLabelText('Work email'), 'dana@northwind.travel');
    await user.type(screen.getByLabelText('Password'), STRONG);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(sent.some((call) => call.method === 'POST' && call.url.includes('/auth/register'))).toBe(true);
    });

    const call = sent.find((entry) => entry.url.includes('/auth/register'));
    // No workspace is collected here: B6a is where that happens.
    expect(call?.body).toEqual({
      name: 'Dana Haddad',
      email: 'dana@northwind.travel',
      password: STRONG,
    });
    expect(await screen.findByText('redirected')).toBeTruthy();
  });
});

describe('the password meter', () => {
  it('scores the way the export does, and three is the bar the button waits for', () => {
    expect(strengthOf('').score).toBe(0);
    expect(strengthOf('short').ok).toBe(false);
    // Twelve characters, mixed case and a digit: three points, no symbol.
    expect(strengthOf('Northwind2026').score).toBe(3);
    expect(strengthOf('Northwind2026').ok).toBe(true);
    expect(strengthOf('Northwind-2026!').score).toBe(4);
    expect(strengthOf('Northwind-2026!').label).toBe('Strong');
  });
});

/* ================================================================== */
/* B3 Verify email /verify                                             */
/* ================================================================== */

describe('B3 Verify email', () => {
  it('B3a: waits for the link, and puts the resend on a 30-second cooldown', async () => {
    anonymous();
    responses.set('POST /auth/resend-verification', { ok: true });
    const user = userEvent.setup();
    wrap(<VerifyEmailPage />, '/verify?email=dana%40northwind.travel');

    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeTruthy();
    expect(screen.getByText('dana@northwind.travel')).toBeTruthy();
    expect(screen.getByText(/this page updates automatically/u)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Resend email' }));

    await waitFor(() => {
      expect(sent.some((call) => call.url.includes('/auth/resend-verification'))).toBe(true);
    });

    const cooling = await screen.findByRole('button', { name: 'Resend in 30s' });
    expect((cooling as HTMLButtonElement).disabled).toBe(true);
    expect(cooling.getAttribute('title')).toBe('Wait 30s before resending');

    // And it counts down on its own rather than waiting for another render.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resend in 29s' })).toBeTruthy(), {
      timeout: 3000,
    });
  });

  it('B3b: a good token confirms the address and points at the workspace step', async () => {
    anonymous();
    responses.set('POST /auth/verify-email', { verified: true, email: 'dana@northwind.travel' });
    wrap(<VerifyEmailPage />, '/verify?token=good');

    expect(await screen.findByRole('heading', { name: 'Email verified' })).toBeTruthy();
    const next = screen.getByRole('link', { name: 'Create your first workspace' });
    expect(next.getAttribute('href')).toBe('/workspaces/new');
  });

  it('B3c: a rejected token offers a new link, and only once', async () => {
    anonymous();
    responses.set('POST /auth/verify-email', {
      __error: { status: 400, body: { error: { code: 'invalid_token', message: 'expired', requestId: 'r' } } },
    });
    responses.set('POST /auth/resend-verification', { ok: true });
    const user = userEvent.setup();
    wrap(<VerifyEmailPage />, '/verify?token=stale&email=dana%40northwind.travel');

    expect(await screen.findByRole('heading', { name: 'This link has expired' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Send a new link' }));

    const sentButton = await screen.findByRole('button', { name: 'Link sent' });
    expect((sentButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('reads `verified: false` on a 200 as the same answer as a rejection', async () => {
    anonymous();
    responses.set('POST /auth/verify-email', { verified: false });
    wrap(<VerifyEmailPage />, '/verify?token=stale');

    expect(await screen.findByRole('heading', { name: 'This link has expired' })).toBeTruthy();
  });
});

/* ================================================================== */
/* B4a Forgot password — the enumeration control                       */
/* ================================================================== */

describe('B4a Forgot password', () => {
  it('shows the same sent card whether or not the account exists', async () => {
    anonymous();
    // The unknown address: the endpoint answers 202 for both, and even a
    // failure must not be distinguishable here.
    responses.set('POST /auth/forgot-password', {
      __error: { status: 404, body: { error: { code: 'not_found', message: 'no such user', requestId: 'r' } } },
    });
    const user = userEvent.setup();
    wrap(<ForgotPasswordPage />, '/forgot-password');

    await screen.findByRole('heading', { name: 'Reset your password' });
    await user.type(screen.getByLabelText('Email'), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeTruthy();
    expect(screen.getByText(/If an account exists for/u)).toBeTruthy();
    expect(screen.getByText('nobody@example.com')).toBeTruthy();
    // Nothing on the page says the address is unknown.
    expect(screen.queryByText(/no such user/u)).toBeNull();
  });
});

/* ================================================================== */
/* B4b Choose a new password                                           */
/* ================================================================== */

describe('B4b Choose a new password', () => {
  const STRONG = 'Northwind-2026!';

  it('unlocks only when the password is strong and the confirmation matches', async () => {
    anonymous();
    const user = userEvent.setup();
    wrap(<ResetPasswordPage />, '/reset-password/tok_123', '/reset-password/:token');

    await screen.findByRole('heading', { name: 'Choose a new password' });
    const submit = () => screen.getByRole('button', { name: 'Reset password' }) as HTMLButtonElement;
    expect(submit().disabled).toBe(true);

    await user.type(screen.getByLabelText('New password'), STRONG);
    expect(submit().getAttribute('title')).toBe('Confirm the new password');

    await user.type(screen.getByLabelText('Confirm new password'), 'Northwind-2027!');
    expect(screen.getByText("Passwords don't match")).toBeTruthy();
    expect(submit().disabled).toBe(true);

    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('Confirm new password'), STRONG);
    expect(screen.getByText('Passwords match')).toBeTruthy();
    expect(submit().disabled).toBe(false);
  });

  it('accepts ?token= as an alias for the path parameter', async () => {
    anonymous();
    responses.set('POST /auth/reset-password', { ok: true });
    const user = userEvent.setup();
    wrap(<ResetPasswordPage />, '/reset-password?token=tok_from_email');

    await screen.findByRole('heading', { name: 'Choose a new password' });
    await user.type(screen.getByLabelText('New password'), STRONG);
    await user.type(screen.getByLabelText('Confirm new password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Reset password' }));

    await waitFor(() => {
      expect(sent.some((call) => call.url.includes('/auth/reset-password'))).toBe(true);
    });
    expect(sent.find((call) => call.url.includes('/auth/reset-password'))?.body).toEqual({
      token: 'tok_from_email',
      password: STRONG,
    });
  });

  it('refuses a link with no token at all, and offers a new one', async () => {
    anonymous();
    wrap(<ResetPasswordPage />, '/reset-password');

    expect(await screen.findByRole('heading', { name: 'This link is not valid' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Send a new link' }).getAttribute('href')).toBe(
      '/forgot-password',
    );
  });
});

/* ================================================================== */
/* B5 Accept invitation                                                */
/* ================================================================== */

describe('B5 Accept invitation', () => {
  it('B5a: signed in, it names the workspace, the role and what the role can do', async () => {
    signedIn();
    responses.set('GET /invitations/', INVITATION);
    responses.set('POST /invitations/accept', { ok: true });
    const user = userEvent.setup();
    wrap(<AcceptInvitationPage />, '/invite/inv_tok', '/invite/:token');

    expect(await screen.findByRole('heading', { name: 'Join Northwind Voyages' })).toBeTruthy();
    expect(screen.getByText(/Invited by Farah Al-Mansoori · 18 Sep 2026/u)).toBeTruthy();
    expect(screen.getByText('Editor')).toBeTruthy();
    expect(screen.getByText(/Editors build campaigns, templates and segments/u)).toBeTruthy();
    expect(screen.getByText(/This invitation expires 25 Sep 2026/u)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));

    await waitFor(() => {
      expect(sent.some((call) => call.url.includes('/invitations/accept'))).toBe(true);
    });
    expect(sent.find((call) => call.url.includes('/invitations/accept'))?.body).toEqual({
      token: 'inv_tok',
    });
  });

  it('B5b: signed out, the invited address is fixed and not an input', async () => {
    anonymous();
    responses.set('GET /invitations/', INVITATION);
    wrap(<AcceptInvitationPage />, '/invite/inv_tok', '/invite/:token');

    expect(await screen.findByRole('heading', { name: 'Join Northwind Voyages' })).toBeTruthy();
    expect(screen.getByText('Create an account with the invited email to accept.')).toBeTruthy();
    expect(screen.getByText('Fixed by the invitation.')).toBeTruthy();
    // The address is shown, but there is no field to change it.
    expect(screen.getByText('omar.h@northwind.travel')).toBeTruthy();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create account and join' })).toBeTruthy();
  });

  it('a token the server will not recognise says so instead of a form', async () => {
    anonymous();
    responses.set('GET /invitations/', {
      __error: { status: 404, body: { error: { code: 'not_found', message: 'gone', requestId: 'r' } } },
    });
    wrap(<AcceptInvitationPage />, '/invite/gone', '/invite/:token');

    expect(
      await screen.findByRole('heading', { name: 'This invitation is no longer valid' }),
    ).toBeTruthy();
  });
});

/* ================================================================== */
/* B6a Create your workspace                                           */
/* ================================================================== */

describe('B6a Create your workspace', () => {
  it('derives the URL from the name as it is typed', async () => {
    signedIn();
    const user = userEvent.setup();
    wrap(<CreateWorkspacePage />, '/workspaces/new');

    await screen.findByRole('heading', { name: 'Create your workspace' });
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
    expect(screen.getByText('app.relayd.io/your-workspace')).toBeTruthy();

    await user.type(screen.getByLabelText('Workspace name'), 'Northwind Voyages');
    expect(screen.getByText('app.relayd.io/northwind-voyages')).toBeTruthy();
  });

  it('creates the workspace with the derived slug and the chosen zone', async () => {
    signedIn();
    responses.set('POST /workspaces', { id: 'ws_new' });
    const user = userEvent.setup();
    wrap(<CreateWorkspacePage />, '/workspaces/new');

    await screen.findByRole('heading', { name: 'Create your workspace' });
    await user.type(screen.getByLabelText('Workspace name'), 'Northwind Voyages');
    await user.selectOptions(screen.getByLabelText('Timezone'), 'Europe/London');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => {
      expect(sent.some((call) => call.method === 'POST' && call.url.endsWith('/workspaces'))).toBe(true);
    });
    expect(sent.find((call) => call.method === 'POST' && call.url.endsWith('/workspaces'))?.body).toEqual({
      name: 'Northwind Voyages',
      slug: 'northwind-voyages',
      timezone: 'Europe/London',
    });
  });

  it('slugifies the way the export does', () => {
    expect(slugify('Northwind Voyages')).toBe('northwind-voyages');
    expect(slugify('Ben & Jerry')).toBe('ben-and-jerry');
    expect(slugify('  ')).toBe('your-workspace');
  });
});

/* ================================================================== */
/* B6b Onboarding checklist /get-started                               */
/* ================================================================== */

function onboardingStubs(): void {
  responses.set('GET /providers', [
    {
      id: 'prv_ses_eu1',
      providerType: 'ses',
      name: 'eu-west-1 · production',
      status: 'active',
      hasWebhookSecret: true,
      lastVerifiedAt: '2026-03-12T08:20:00.000Z',
      lastError: null,
      quotaSnapshot: null,
      capabilities: {},
      createdAt: '2026-03-12T08:20:00.000Z',
    },
  ]);
  responses.set('GET /senders', [
    {
      id: 'snd_hello',
      providerId: 'prv_ses_eu1',
      identityId: 'idn_1',
      fromEmail: 'hello@northwind.travel',
      fromName: 'Northwind Voyages',
      replyTo: null,
      // Not yet verified: step 2 is the pending one, and step 4 stays locked.
      status: 'paused',
      dailyLimit: null,
      hourlyLimit: null,
      healthScore: 100,
      consecutiveFailures: 0,
      cooldownUntil: null,
      lastSendAt: null,
    },
  ]);
  responses.set('GET /audience/imports', []);
  responses.set('GET /campaigns', { items: [], nextCursor: null });
  responses.set('GET /workspaces/current', {
    id: 'ws_nv',
    name: 'Northwind Voyages',
    slug: 'northwind-voyages',
    timezone: 'Asia/Dubai',
    status: 'active',
    alerts: { newAccountCap: { perDay: 500, endsAt: '2026-09-24T06:00:00.000Z' } },
  });
}

describe('B6b Get started', () => {
  it('derives the four steps from the collection endpoints', async () => {
    signedIn();
    onboardingStubs();
    wrap(<GetStartedPage />, '/get-started');

    expect(
      await screen.findByRole('heading', { name: 'Get Northwind Voyages ready to send' }),
    ).toBeTruthy();
    expect(screen.getByText('Step 2 of 2')).toBeTruthy();

    // One of the four is done: a connection exists and is active.
    expect(await screen.findByText('1 of 4 complete')).toBeTruthy();
    expect(screen.getByText(/Amazon SES · eu-west-1 · production connected 12 Mar/u)).toBeTruthy();
    expect(screen.getByText('Pending DNS')).toBeTruthy();
    expect(screen.getByText('Locked')).toBeTruthy();

    // The frame's rule for step 4: disabled, with the reason in the tooltip.
    const test = screen.getByRole('button', { name: 'Send test' }) as HTMLButtonElement;
    expect(test.disabled).toBe(true);
    expect(test.getAttribute('title')).toBe('Verify a sender first');

    // The cap line names the date the workspace record gives.
    expect(
      screen.getByText('The 500/day new-account cap lifts automatically on 24 Sep.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: /Skip for now/u }).getAttribute('href')).toBe('/dashboard');
  });

  it('says it could not check rather than reporting four untouched steps', async () => {
    signedIn();
    onboardingStubs();
    responses.set('GET /providers', {
      __error: { status: 500, body: { error: { code: 'internal', message: 'boom', requestId: 'req_7f3a' } } },
    });
    wrap(<GetStartedPage />, '/get-started');

    expect(await screen.findByText("We couldn't check your setup")).toBeTruthy();
    expect(screen.getByText('req_7f3a')).toBeTruthy();
    expect(screen.queryByText('Not started')).toBeNull();
  });
});
