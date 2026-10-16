import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, getMe, login as apiLogin, logout as apiLogout, setUnauthorizedHandler, type AuthUser, type UserRole } from './api';

// Mirrors backend/app/auth.py's ranking: viewer < technician < admin.
const RANK: Record<UserRole, number> = { viewer: 0, technician: 1, admin: 2 };

export function atLeast(user: AuthUser | null, role: UserRole): boolean {
  return user !== null && RANK[user.role] >= RANK[role];
}

type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut'; notice: string | null }
  | { status: 'signedIn'; user: AuthUser };

interface AuthContextValue {
  state: AuthState;
  /** Rejects with an ApiError (401 "Wrong username or password.") on failure. */
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Owns "who is signed in". The session itself is an HttpOnly cookie the
 * browser keeps; this asks the backend who it belongs to (GET /auth/me) on
 * load, and drops back to the sign-in screen the moment any request is
 * answered 401 (the session expired or was ended elsewhere).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((user) => {
        if (!cancelled) setState({ status: 'signedIn', user });
      })
      .catch((e: unknown) => {
        // 401 is the normal "not signed in"; anything else (backend down)
        // also lands on the sign-in screen, where the login attempt will
        // surface the real error.
        if (!cancelled) setState({ status: 'signedOut', notice: e instanceof ApiError && e.status === 0 ? e.message : null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() =>
      setState((s) => (s.status === 'signedIn' ? { status: 'signedOut', notice: 'Your session ended. Please sign in again.' } : s)),
    );
    return () => setUnauthorizedHandler(null);
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    const user = await apiLogin(username, password);
    setState({ status: 'signedIn', user });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      setState({ status: 'signedOut', notice: null });
    }
  }, []);

  const value = useMemo(() => ({ state, signIn, signOut }), [state, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** The signed-in user, or null (screens are only rendered while signed in; null never reaches them). */
export function useUser(): AuthUser | null {
  const { state } = useAuth();
  return state.status === 'signedIn' ? state.user : null;
}

/** True when the signed-in user has at least `role`. */
export function useCan(role: UserRole): boolean {
  return atLeast(useUser(), role);
}
