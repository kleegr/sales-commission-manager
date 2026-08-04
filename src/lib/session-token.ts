// ============================================================================
// SESSION TOKEN STORE  (browser)
//
// The second half of the mobile-WebView auth fix. The Kleegr launch response
// (api/_lib/launch-handoff.ts) writes the SCM session token into localStorage
// under `scm_session_token` before navigating into the app; from then on this
// module is the single place that reads, writes and clears it, and
// src/lib/api-auth.ts replays it as `Authorization: Bearer <token>`.
//
// Why localStorage and not the cookie: inside the Smart Productivity iframe our
// own `scm_session` cookie is THIRD-PARTY, and iOS WebKit / Android WebView
// block those outright. localStorage is keyed to THIS origin's document, which
// the WebView does allow, so it survives where the cookie cannot.
//
// Every access is wrapped: Safari Private Browsing, "block all cookies", and
// some embedded WebViews throw on `window.localStorage` access rather than
// returning null. A throw here must degrade to "no token" (the cookie path),
// never to a crashed app shell.
// ============================================================================

/** Must match SESSION_STORAGE_KEY in api/_lib/launch-handoff.ts. */
export const SESSION_TOKEN_KEY = "scm_session_token";

function store(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The session token handed over by the Kleegr launch, or null. */
export function readSessionToken(): string | null {
  try {
    const token = store()?.getItem(SESSION_TOKEN_KEY);
    return token && token.trim() ? token : null;
  } catch {
    return null;
  }
}

export function storeSessionToken(token: string): void {
  try {
    if (token && token.trim()) store()?.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    /* storage unavailable — the cookie transport still applies */
  }
}

/**
 * Drop the stored token. Called on logout, and whenever the server tells us the
 * token is no longer good (a 401 from /api/auth/me), so a dead token cannot sit
 * in localStorage being replayed on every request for the next seven days.
 */
export function clearSessionToken(): void {
  try {
    store()?.removeItem(SESSION_TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
}
