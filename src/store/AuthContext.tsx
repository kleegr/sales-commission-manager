// ============================================================================
// AUTH CONTEXT  (client)
//
// Talks to /api/auth/*. Exposes the current user, plus login()/logout().
// The rest of the app is only mounted once a user is present (see main.tsx),
// so components can assume `useAuth().user` is non-null inside the app shell.
// ============================================================================

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Role } from "../lib/roles";
import { clearSessionToken, readSessionToken, storeSessionToken } from "../lib/session-token";
import { detectEmbedded } from "../lib/useEmbedded";
import { clearDemoPrefs, storeDemoPrefs } from "../lib/demo-prefs";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  tenantSlug: string;
  tenantName: string;
  salespersonId: string | null;
}

interface AuthCtx {
  user: AuthUser | null;
  loading: boolean;
  /** True when the server is in review/demo mode (login not required). */
  demo: boolean;
  login: (email: string, password: string, tenant?: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  /** Re-fetch the current user from the server. */
  refresh: () => Promise<void>;
  /** Review mode: switch the viewed tenant + role, then reload the session. */
  setDemo: (tenantSlug: string, role: Role) => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

function setDemoCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=2592000; SameSite=Lax`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [demo, setDemoFlag] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { headers: { accept: "application/json" } });
      const body = await res.json().catch(() => ({}));
      setDemoFlag(!!body?.demo);
      if (res.ok) {
        setUser(body.user as AuthUser);
      } else {
        // The server rejected everything this request offered. If a launch
        // token is sitting in localStorage it is dead (expired or revoked) —
        // drop it, so it stops being replayed on every later request and can
        // never shadow a fresh cookie session established by a manual login.
        if (res.status === 401 && readSessionToken()) clearSessionToken();
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setDemo = useCallback<AuthCtx["setDemo"]>(
    async (tenantSlug, role) => {
      setDemoCookie("scm_demo_tenant", tenantSlug);
      setDemoCookie("scm_demo_role", role);
      // Mirror into localStorage so the choice survives inside the iframe,
      // where those cookies are third-party and get blocked; api-auth.ts
      // replays it as the x-demo-* headers the server also accepts.
      storeDemoPrefs(tenantSlug, role);
      await refresh();
    },
    [refresh],
  );

  const login = useCallback<AuthCtx["login"]>(async (email, password, tenant) => {
    try {
      // Tell the server when we are framed: inside the Kleegr/GHL iframe on a
      // phone the cookie it sets is third-party and the WebView drops it, so
      // the response has to carry the session token as well or every later
      // /api call is unauthenticated (Documents/Goals 401, and /api/state 401
      // masked by the local-storage fallback on the Dashboard).
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, tenant, embedded: detectEmbedded() }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        // Adopt the fresh token when the server handed one over (embedded
        // login); otherwise this login rides the cookie it just set, so retire
        // any token left from an earlier Kleegr launch — the two transports
        // must never disagree about who is signed in.
        const token = typeof body.token === "string" ? body.token.trim() : "";
        if (token) storeSessionToken(token);
        else clearSessionToken();
        setUser(body.user as AuthUser);
        return { ok: true };
      }
      return { ok: false, error: body.error ?? `error_${res.status}` };
    } catch {
      return { ok: false, error: "network_error" };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      // The interceptor still attaches the Bearer token here, so the server can
      // revoke the embedded session as well as the cookie one.
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    clearSessionToken();
    clearDemoPrefs();
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, loading, demo, login, logout, refresh, setDemo }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
