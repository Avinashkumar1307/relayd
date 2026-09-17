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

export interface Session {
  accessToken: string;
  memberships: Membership[];
}

interface AuthState {
  status: 'loading' | 'authenticated' | 'anonymous';
  memberships: Membership[];
  currentWorkspaceId: string | null;
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
          setState({ status: 'anonymous', memberships: [], currentWorkspaceId: null });
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
      setState({ status: 'anonymous', memberships: [], currentWorkspaceId: null });
      // Anything cached was fetched as the previous user.
      queryClient.clear();
    }
  }, [queryClient]);

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
    };
  }, [state, login, register, logout, switchWorkspace]);

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
