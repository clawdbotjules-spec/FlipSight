"use client";

/**
 * JWT auth context: token in localStorage, /auth/me hydration, and a guard
 * that bounces unauthenticated visitors to /login (client-side — the app is
 * fully client-rendered behind the login wall).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, getToken, setToken } from "@/lib/api";

interface Me {
  user: { id: string; email: string; role: string };
  org: { id: string; name: string };
}

interface AuthState {
  ready: boolean;
  token: string | null;
  me: Me | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, orgName?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setTokenState] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    const stored = getToken();
    setTokenState(stored);
    if (!stored) {
      setReady(true);
      return;
    }
    api<Me>("/auth/me", { token: stored })
      .then((data) => setMe(data))
      .catch(() => {
        setToken(null);
        setTokenState(null);
      })
      .finally(() => setReady(true));
  }, []);

  const applyToken = useCallback(async (newToken: string) => {
    setToken(newToken);
    setTokenState(newToken);
    const data = await api<Me>("/auth/me", { token: newToken });
    setMe(data);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api<{ token: string }>("/auth/login", {
        method: "POST",
        body: { email, password },
        token: null,
      });
      await applyToken(res.token);
    },
    [applyToken],
  );

  const register = useCallback(
    async (email: string, password: string, orgName?: string) => {
      const res = await api<{ token: string }>("/auth/register", {
        method: "POST",
        body: { email, password, orgName },
        token: null,
      });
      await applyToken(res.token);
    },
    [applyToken],
  );

  const logout = useCallback(() => {
    setToken(null);
    setTokenState(null);
    setMe(null);
  }, []);

  const value = useMemo(
    () => ({ ready, token, me, login, register, logout }),
    [ready, token, me, login, register, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/**
 * Wrap protected pages. Children render OPTIMISTICALLY — including in the
 * server-rendered HTML — so the shell paints immediately and data fetches
 * start with hydration instead of after an /auth/me round-trip. Logged-out
 * visitors are redirected client-side; a stale token 401s on its first API
 * call, which clears it and lands on /login.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { ready, token } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const loggedOut = ready && !token;
  useEffect(() => {
    if (loggedOut) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [loggedOut, router, pathname]);

  if (loggedOut) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="pulse-dot text-sm text-faint">redirecting to login…</div>
      </div>
    );
  }
  return <>{children}</>;
}
