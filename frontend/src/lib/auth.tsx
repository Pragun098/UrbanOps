"use client";

/**
 * Auth state for the whole app. The JWT lives in localStorage; on load it is
 * validated against GET /auth/me. Any 401 from the API logs the user out.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, onUnauthorized, setApiToken, type Role, type User } from "./api";

const STORAGE_KEY = "urbanops-token";

type Status = "loading" | "authenticated" | "anonymous";

type AuthContextValue = {
  status: Status;
  user: User | null;
  token: string | null;
  login: (email: string, password: string) => Promise<User>;
  register: (name: string, email: string, password: string) => Promise<User>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

type AuthResponse = { token: string; user: User };

const readToken = () => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const writeToken = (token: string | null) => {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode): session-only login */
  }
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ status: Status; user: User | null; token: string | null }>({
    status: "loading",
    user: null,
    token: null,
  });

  const applySession = useCallback((token: string | null, user: User | null) => {
    setApiToken(token);
    writeToken(token);
    setState({ status: token && user ? "authenticated" : "anonymous", user, token });
  }, []);

  const logout = useCallback(() => applySession(null, null), [applySession]);

  // Validate any stored token once on startup.
  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      const stored = readToken();
      if (!stored) {
        if (!cancelled) applySession(null, null);
        return;
      }
      setApiToken(stored);
      try {
        const { user } = await api<{ user: User }>("/auth/me");
        if (!cancelled) applySession(stored, user);
      } catch {
        if (!cancelled) applySession(null, null);
      }
    };
    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [applySession]);

  useEffect(() => {
    onUnauthorized(logout);
    return () => onUnauthorized(null);
  }, [logout]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api<AuthResponse>("/auth/login", { method: "POST", body: { email, password } });
      applySession(res.token, res.user);
      return res.user;
    },
    [applySession]
  );

  const register = useCallback(
    async (name: string, email: string, password: string) => {
      const res = await api<AuthResponse>("/auth/register", { method: "POST", body: { name, email, password } });
      applySession(res.token, res.user);
      return res.user;
    },
    [applySession]
  );

  const value = useMemo(() => ({ ...state, login, register, logout }), [state, login, register, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

export const isStaff = (role?: Role) => role === "dispatcher" || role === "admin";

/** Where each role lands after login. */
export const homeFor = (role?: Role) => (isStaff(role) ? "/" : "/my-reports");
