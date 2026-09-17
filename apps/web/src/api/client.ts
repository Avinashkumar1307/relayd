/**
 * The HTTP client for the dashboard.
 *
 * Two rules from docs/06 section 15 shape all of this:
 *
 *   "access token in memory only, never localStorage" — so the token lives in
 *   a module-scoped variable and dies with the tab. An XSS that can read
 *   localStorage gets a long-lived credential; one that can only read a
 *   closure gets whatever is in memory at that instant, and nothing after a
 *   reload.
 *
 *   "Refresh in HttpOnly Secure SameSite=Lax cookie" — so refreshing is a
 *   request with credentials and no token handling on this side at all. The
 *   browser holds the long-lived credential where script cannot reach it.
 */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: { path: string; message: string }[];
    requestId: string;
    docsUrl?: string;
  };
}

/** A failed request, carrying the server's error envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { path: string; message: string }[],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field errors keyed by path, for wiring into a form. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const detail of this.details ?? []) out[detail.path] = detail.message;
    return out;
  }
}

/** In memory, deliberately. Never persisted. */
let accessToken: string | null = null;

/** Set after login, register or refresh. */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

let currentWorkspaceId: string | null = null;

export function setCurrentWorkspaceId(id: string | null): void {
  currentWorkspaceId = id;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Skip the workspace header on routes that have no workspace. */
  unscoped?: boolean;
  signal?: AbortSignal;
}

let baseUrl = '/api/v1';

export function configureApi(options: { baseUrl: string }): void {
  baseUrl = options.baseUrl.replace(/\/+$/u, '');
}

/**
 * A single in-flight refresh, shared by every request that hits a 401.
 *
 * Without this, a dashboard that fires six queries on mount produces six
 * concurrent refreshes on an expired token. Each rotates the refresh cookie,
 * five of them present a token that has just been consumed, and the server
 * correctly reads that as theft and revokes the whole family — logging the
 * user out for doing nothing but loading a page.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) {
        accessToken = null;
        return false;
      }
      const body = (await response.json()) as { data: { accessToken: string } };
      accessToken = body.data.accessToken;
      return true;
    } catch {
      accessToken = null;
      return false;
    } finally {
      // Cleared in a microtask so concurrent callers all observe the same
      // promise before it is reset.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();

  return refreshInFlight;
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | undefined;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = undefined;
  }

  return new ApiError(
    response.status,
    body?.error.code ?? 'internal_error',
    body?.error.message ?? response.statusText,
    body?.error.details,
    body?.error.requestId,
  );
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken !== null) headers['authorization'] = `Bearer ${accessToken}`;
  if (!options.unscoped && currentWorkspaceId !== null) {
    headers['x-workspace-id'] = currentWorkspaceId;
  }

  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

/**
 * Performs a request, refreshing once on a 401 and retrying.
 *
 * Exactly once: if the retry also 401s, the session is genuinely gone and
 * looping would turn an expired login into an infinite request storm.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await send(path, options);

  if (response.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshAccessToken()) {
      response = await send(path, options);
    }
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;

  const body = (await response.json()) as { data: T };
  return body.data;
}

export const api = {
  get: <T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
};
