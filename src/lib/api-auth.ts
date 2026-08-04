// ============================================================================
// API AUTH INTERCEPTOR  (browser)
//
// Attaches `Authorization: Bearer <session token>` to every same-origin /api
// call the app makes, using the token the Kleegr launch stored in localStorage
// (see session-token.ts and api/_lib/launch-handoff.ts) or that an embedded
// login handed back (see api/auth/login.ts).
//
// It also replays the review-mode tenant/role selection as the `x-demo-*`
// headers the server accepts (see demo-prefs.ts) — for the same reason: the
// cookies that used to carry it are third-party inside the iframe.
//
// WHY A GLOBAL fetch WRAPPER, not a shared client:
// this app has ~47 `fetch("/api/…")` call sites spread across the stores, the
// resource clients, and half a dozen pages. Threading a header through all of
// them would leave any missed one silently unauthenticated inside the iframe —
// the exact class of bug being fixed. Patching `window.fetch` once, before the
// React tree mounts, covers every present and future call site by construction.
//
// The wrapper is deliberately conservative:
//   - it never touches cross-origin requests (the token is ours alone and must
//     not leak to a third party);
//   - it never touches non-/api paths;
//   - it never overwrites an Authorization header a caller set itself;
//   - it skips the two Kleegr endpoints whose Authorization header means a
//     KLEEGR LAUNCH TOKEN rather than an SCM session (/api/kleegr/launch,
//     /api/kleegr/sync);
//   - with no stored token it is a straight pass-through, so standard web
//     browsing keeps running on the cookie exactly as before.
// ============================================================================

import { readSessionToken } from "./session-token";
import { readDemoPrefs } from "./demo-prefs";

/**
 * Endpoints where `Authorization: Bearer …` already means something else — a
 * short-lived Kleegr launch token, never our session token.
 */
const BEARER_EXEMPT_PATHS = ["/api/kleegr/launch", "/api/kleegr/sync"];

/**
 * Should this request carry our session Bearer token?
 *
 * Pure so the rule is unit-testable in Node — see api-auth.test.ts. `origin` is
 * the document origin that a relative URL resolves against.
 */
export function shouldAttachBearer(rawUrl: string, origin: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl, origin);
  } catch {
    return false;
  }
  // Same-origin only: the session token must never travel to a third party.
  if (url.origin !== new URL(origin).origin) return false;
  if (!url.pathname.startsWith("/api/")) return false;
  return !BEARER_EXEMPT_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`));
}

/** The request URL, whatever form fetch() was called with. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** True when the caller already set an Authorization header — we defer to it. */
function hasAuthHeader(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init?.headers && new Headers(init.headers).has("authorization")) return true;
  // A Request built with its own Authorization header, called as fetch(req).
  if (!init?.headers && typeof input !== "string" && !(input instanceof URL)) {
    return input.headers.has("authorization");
  }
  return false;
}

let installed = false;

/**
 * Patch window.fetch. Call ONCE, before the app mounts (see main.tsx).
 * Safe to call again — repeat calls are ignored, so the wrapper can never
 * stack on itself under HMR or StrictMode double-invocation.
 */
export function installApiAuthInterceptor(): void {
  if (installed) return;
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;

  const nativeFetch = window.fetch.bind(window);

  window.fetch = function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let token: string | null = null;
    let demoTenant: string | null = null;
    let demoRole: string | null = null;
    try {
      if (shouldAttachBearer(urlOf(input), window.location.origin)) {
        if (!hasAuthHeader(input, init)) token = readSessionToken();
        // Review mode: the same choice the scm_demo_* cookies carry, replayed
        // as headers because those cookies are blocked inside the iframe.
        const prefs = readDemoPrefs();
        demoTenant = prefs.tenantSlug;
        demoRole = prefs.role;
      }
    } catch {
      token = null;
      demoTenant = null;
      demoRole = null;
    }
    if (!token && !demoTenant && !demoRole) return nativeFetch(input as RequestInfo, init);

    try {
      const isRequest = typeof input !== "string" && !(input instanceof URL);
      // Seed from whichever object actually carries the headers, so nothing the
      // caller set (content-type, accept, …) is lost when we add ours.
      const headers = new Headers(init?.headers ?? (isRequest ? input.headers : {}));
      if (token) headers.set("Authorization", `Bearer ${token}`);
      if (demoTenant) headers.set("x-demo-tenant", demoTenant);
      if (demoRole) headers.set("x-demo-role", demoRole);

      // fetch(Request) with no init: rebuild the Request so its method, body,
      // mode and credentials survive and only the header set changes.
      if (isRequest && !init) return nativeFetch(new Request(input, { headers }));
      return nativeFetch(input as RequestInfo, { ...init, headers });
    } catch {
      // Never let header plumbing break a request outright — fall back to the
      // cookie transport, which still works everywhere outside a WebView.
      return nativeFetch(input as RequestInfo, init);
    }
  } as typeof window.fetch;
}
