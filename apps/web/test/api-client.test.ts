import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  api,
  configureApi,
  getAccessToken,
  setAccessToken,
  setCurrentWorkspaceId,
} from '../src/api/client.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  configureApi({ baseUrl: '/api/v1' });
  setAccessToken(null);
  setCurrentWorkspaceId(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const unauthorized = () =>
  json(401, { error: { code: 'unauthenticated', message: 'nope', requestId: 'r' } });

describe('token handling', () => {
  it('keeps the access token in memory and out of storage', () => {
    // docs/06: "access token in memory only, never localStorage".
    setAccessToken('secret-access-token');

    expect(getAccessToken()).toBe('secret-access-token');
    expect(JSON.stringify(globalThis.localStorage ?? {})).not.toContain('secret-access-token');
    expect(JSON.stringify(globalThis.sessionStorage ?? {})).not.toContain('secret-access-token');
  });

  it('sends it as a bearer token', async () => {
    setAccessToken('abc');
    fetchMock.mockResolvedValueOnce(json(200, { data: { ok: true } }));

    await api.get('/workspaces/current');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer abc');
  });

  it('sends the workspace header on scoped requests and omits it on unscoped ones', async () => {
    setAccessToken('abc');
    setCurrentWorkspaceId('ws-1');

    // A fresh Response per call: a body can only be read once.
    fetchMock.mockImplementation(async () => json(200, { data: {} }));
    await api.get('/workspaces/current');
    await api.post('/auth/logout', undefined, { unscoped: true });

    const scoped = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    const unscoped = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;

    expect(scoped['x-workspace-id']).toBe('ws-1');
    expect(unscoped['x-workspace-id']).toBeUndefined();
  });

  it('always sends credentials, so the refresh cookie travels', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: {} }));
    await api.get('/x');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).credentials).toBe('include');
  });
});

describe('refresh on 401', () => {
  it('refreshes once and retries the original request', async () => {
    setAccessToken('expired');
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json(200, { data: { accessToken: 'fresh' } }))
      .mockResolvedValueOnce(json(200, { data: { ok: true } }));

    await expect(api.get('/workspaces/current')).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/auth/refresh');
    expect(getAccessToken()).toBe('fresh');
  });

  it('SHARES ONE REFRESH across concurrent 401s', async () => {
    // Six queries on an expired token must not produce six refreshes. Each
    // would rotate the cookie, five would present an already-consumed token,
    // and the server would correctly read that as theft and revoke the whole
    // family — logging the user out for loading a page.
    setAccessToken('expired');

    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/auth/refresh')) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return json(200, { data: { accessToken: 'fresh' } });
      }
      return getAccessToken() === 'fresh' ? json(200, { data: { ok: true } }) : unauthorized();
    });

    await Promise.all([api.get('/a'), api.get('/b'), api.get('/c'), api.get('/d')]);

    const refreshes = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/auth/refresh'),
    );
    expect(refreshes).toHaveLength(1);
  });

  it('does not retry forever when the refresh also fails', async () => {
    setAccessToken('expired');
    fetchMock.mockImplementation(async () => unauthorized());

    await expect(api.get('/x')).rejects.toBeInstanceOf(ApiError);

    // original + refresh attempt, and no more.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAccessToken()).toBeNull();
  });

  it('never tries to refresh a failing auth route', async () => {
    // A failed login is a failed login, not an expired session.
    fetchMock.mockResolvedValueOnce(unauthorized());

    await expect(api.post('/auth/login', {}, { unscoped: true })).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('errors', () => {
  it('carries code, message and requestId from the envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      json(403, {
        error: { code: 'insufficient_permission', message: 'nope', requestId: 'req_1' },
      }),
    );

    const error = await api.get('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: 'insufficient_permission', requestId: 'req_1' });
  });

  it('maps field errors for a form', async () => {
    fetchMock.mockResolvedValueOnce(
      json(400, {
        error: {
          code: 'validation_failed',
          message: 'bad',
          requestId: 'r',
          details: [{ path: 'password', message: 'Too short' }],
        },
      }),
    );

    const error = (await api.post('/x', {}).catch((e: unknown) => e)) as ApiError;
    expect(error.fieldErrors()).toEqual({ password: 'Too short' });
  });

  it('survives a non-JSON error body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('gateway timeout', { status: 504 }));
    const error = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(504);
    expect(error.code).toBe('internal_error');
  });

  it('handles a 204 with no body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.delete('/x')).resolves.toBeUndefined();
  });
});
