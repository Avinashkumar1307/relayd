import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Permission, WorkspaceRole } from '@relayd/types';
import { permissionsFor } from '@relayd/types';
import { api, setAccessToken, setCurrentWorkspaceId } from '../api/client.js';

export interface Membership {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  role: WorkspaceRole;
}

/**
 * Who is signed in.
 *
 * The shell's user row, J5 Profile & security and D6c's "Recorded as" line
 * all need a name and an address, and three sections reached for it
 * independently. It lives here so there is one answer.
 *
 * Served on register, login and refresh, alongside the token and the
 * memberships — one response, no second round trip, and no window in which
 * the shell holds a token and has no name to render. `GET /auth/session`
 * answers the same payload without rotating the refresh cookie, for a caller
 * that already has a valid access token.
 *
 * Still optional on the type: everything that reads it degrades to the
 * address or to "you" rather than rendering an empty name, which is what
 * keeps these screens working against a fixture that omits it.
 */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified?: boolean | undefined;
}

export interface Session {
  accessToken: string;
  memberships: Membership[];
  user?: SessionUser;
}

interface AuthState {
  status: 'loading' | 'authenticated' | 'anonymous';
  memberships: Membership[];
  currentWorkspaceId: string | null;
  user: SessionUser | null;
}

interface AuthContextValue extends AuthState {
  current: Membership | null;
  /** Permissions of the current role, for hiding controls a role cannot use. */
  permissions: readonly Permission[];
  can: (permission: Permission) => boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  switchWorkspace: (workspaceId: string) => void;
  /** B3a and B3c: send the verification link again. */
  resendVerification: (email?: string) => Promise<void>;
  /** B5a: join the workspace this token invites to, then adopt the new session. */
  acceptInvitation: (token: string) => Promise<void>;
  /** B6a: create a workspace and make it the current one. */
  createWorkspace: (input: CreateWorkspaceInput) => Promise<void>;
}

export interface CreateWorkspaceInput {
  name: string;
  slug: string;
  timezone: string;
}

export interface RegisterInput {
  email: string;
  name: string;
  password: string;
  workspaceName: string;
  workspaceSlug: string;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const LAST_WORKSPACE_KEY = 'relayd.lastWorkspaceId';

/**
 * Holds the session for the app.
 *
 * The access token is handed to the API client and never stored here or in
 * localStorage (docs/06). What IS persisted is the id of the workspace the
 * user last looked at — a UI preference, not a credential, and useless to
 * anyone who steals it because every request re-checks membership server-side.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    memberships: [],
    currentWorkspaceId: null,
    user: null,
  });

  const adopt = useCallback((session: Session) => {
    setAccessToken(session.accessToken);

    const remembered = readRememberedWorkspace();
    const chosen =
      session.memberships.find((m) => m.workspaceId === remembered)?.workspaceId ??
      session.memberships[0]?.workspaceId ??
      null;

    setCurrentWorkspaceId(chosen);
    setState({
      status: 'authenticated',
      memberships: session.memberships,
      currentWorkspaceId: chosen,
      user: session.user ?? null,
    });
  }, []);

  /**
   * On load, try to trade the refresh cookie for a session.
   *
   * This is what makes a reload not feel like a logout, given the access token
   * deliberately did not survive it.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const session = await api.post<Session>('/auth/refresh', undefined, { unscoped: true });
        if (!cancelled) adopt(session);
      } catch {
        if (!cancelled) {
          setAccessToken(null);
          setState({ status: 'anonymous', memberships: [], currentWorkspaceId: null, user: null });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [adopt]);

  const login = useCallback(
    async (email: string, password: string) => {
      adopt(await api.post<Session>('/auth/login', { email, password }, { unscoped: true }));
    },
    [adopt],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      adopt(await api.post<Session>('/auth/register', input, { unscoped: true }));
    },
    [adopt],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', undefined, { unscoped: true });
    } finally {
      setAccessToken(null);
      setCurrentWorkspaceId(null);
      rememberWorkspace(null);
      setState({ status: 'anonymous', memberships: [], currentWorkspaceId: null, user: null });
      // Anything cached was fetched as the previous user.
      queryClient.clear();
    }
  }, [queryClient]);

  /**
   * Re-read the session from the refresh cookie.
   *
   * Accepting an invitation and creating a workspace both change the set of
   * memberships, and the membership list is what the shell's switcher, the
   * guards and every workspace-scoped request are built from. Re-adopting is
   * how those learn about it without a reload.
   */
  const reload = useCallback(async () => {
    adopt(await api.post<Session>('/auth/refresh', undefined, { unscoped: true }));
  }, [adopt]);

  /**
   * B3a's "Resend".
   *
   * The address is sent when the page has one and left out when it does not:
   * a signed-in caller is identified by the bearer token instead. The server
   * answers 202 either way and throttles on its own clock, so the 30-second
   * countdown in the UI is a courtesy and never the control.
   */
  const resendVerification = useCallback(async (email?: string) => {
    await api.post('/auth/resend-verification', email === undefined ? {} : { email }, {
      unscoped: true,
    });
  }, []);

  const acceptInvitation = useCallback(
    async (token: string) => {
      await api.post('/invitations/accept', { token }, { unscoped: true });
      // The caller is now a member of a workspace it was not a member of a
      // moment ago; nothing cached was fetched with that membership in scope.
      queryClient.clear();
      await reload();
    },
    [queryClient, reload],
  );

  const createWorkspace = useCallback(
    async (input: CreateWorkspaceInput) => {
      // Unscoped deliberately: there is no workspace to name yet, and the
      // access token will not carry the new one until the refresh below.
      const created = await api.post<{ id: string }>('/workspaces', input, { unscoped: true });
      queryClient.clear();
      await reload();
      setCurrentWorkspaceId(created.id);
      rememberWorkspace(created.id);
      setState((previous) => ({ ...previous, currentWorkspaceId: created.id }));
    },
    [queryClient, reload],
  );

  const switchWorkspace = useCallback(
    (workspaceId: string) => {
      setCurrentWorkspaceId(workspaceId);
      rememberWorkspace(workspaceId);
      setState((previous) => ({ ...previous, currentWorkspaceId: workspaceId }));
      // Every cached response was scoped to the workspace we just left.
      queryClient.clear();
    },
    [queryClient],
  );

  const value = useMemo<AuthContextValue>(() => {
    const current =
      state.memberships.find((m) => m.workspaceId === state.currentWorkspaceId) ?? null;
    const permissions = current === null ? [] : permissionsFor(current.role);

    return {
      ...state,
      current,
      permissions,
      can: (permission: Permission) => permissions.includes(permission),
      login,
      register,
      logout,
      switchWorkspace,
      resendVerification,
      acceptInvitation,
      createWorkspace,
    };
  }, [
    state,
    login,
    register,
    logout,
    switchWorkspace,
    resendVerification,
    acceptInvitation,
    createWorkspace,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth must be used inside an AuthProvider');
  }
  return context;
}

/**
 * A UI preference, not a credential. Wrapped because storage throws in private
 * browsing modes and a remembered tab is not worth a blank page.
 */
function readRememberedWorkspace(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_WORKSPACE_KEY) ?? null;
  } catch {
    return null;
  }
}

function rememberWorkspace(workspaceId: string | null): void {
  try {
    if (workspaceId === null) globalThis.localStorage?.removeItem(LAST_WORKSPACE_KEY);
    else globalThis.localStorage?.setItem(LAST_WORKSPACE_KEY, workspaceId);
  } catch {
    // Ignored: remembering the last workspace is a convenience.
  }
}
