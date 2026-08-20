// ============================================================================
// LAUNCH HANDOFF  (Kleegr → Sales Commission Manager, mobile-safe)
//
// The Kleegr launch used to finish with a bare 302 + Set-Cookie. That works in
// a desktop browser and fails on a phone: iOS WebKit and Android WebView block
// THIRD-PARTY cookies inside an iframe, so the `scm_session` cookie set on the
// launch response was dropped before the redirect even landed. The app then
// booted with no credential, /api/auth/me returned 401, and the user was shown
// "Commission Manager — Sign in to your workspace" instead of their dashboard.
//
// So instead of redirecting at the HTTP layer we return a tiny HTML document
// that:
//   1. writes the session token into localStorage (FIRST-party to this origin,
//      and therefore readable/writable inside the iframe), then
//   2. navigates to the workspace with location.replace() so the launch URL —
//      which carries a single-use launch token — never enters history.
//
// The Set-Cookie header is still sent alongside it: direct (non-framed) web
// browsing keeps working exactly as before off the cookie alone, and a desktop
// embed ends up with both transports. See api/_lib/auth.ts for the server side.
//
// This module is pure (string in, string out) so the escaping rules below are
// unit-testable without a live response object — see launch-handoff.test.ts.
// ============================================================================

/** localStorage key holding the SCM session token in the browser. */
export const SESSION_STORAGE_KEY = "scm_session_token";

/**
 * localStorage key holding the Smart Productivity per-sub-account permission
 * policy blob. Written alongside the session token during the launch handoff so
 * the client (src/store/SpPermissionsContext.tsx) can gate the UI. Cleared when
 * no policy is available (null) so a standalone / stale value never lingers.
 */
export const SP_PERMS_STORAGE_KEY = "scm_sp_perms";

/**
 * Embed a value in an inline <script> safely.
 *
 * JSON.stringify alone is NOT enough inside HTML: a literal `</script>` in the
 * data would end the element early, and `<!--` opens an HTML comment that
 * swallows the rest of the block. Escaping `<`, `>` and `&` to their \uXXXX
 * form keeps the JavaScript string value identical while making it impossible
 * for the data to break out of the script element.
 */
export function jsStringLiteral(value: string): string {
  return JSON.stringify(String(value))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Escape a value for an HTML attribute (the <noscript> fallback URL). */
export function htmlAttr(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The handoff document: store the token, then replace the location.
 *
 * `target` must be a SAME-ORIGIN, root-relative path ("/portal?kleegr=connected").
 * Everything is inline — no network round-trip stands between the launch and
 * the dashboard, so the perceived experience is still a redirect.
 *
 * `spPermissions`, when provided, is the Smart Productivity per-sub-account
 * permission policy (already a plain JSON-serializable object). It is written to
 * localStorage['scm_sp_perms'] so the client can gate the UI. Pass `null`
 * (the default) to CLEAR any stale value — this keeps standalone / non-SP
 * launches byte-for-byte unchanged (no blob → the client fails open).
 */
export function renderLaunchHandoff(
  target: string,
  sessionToken: string,
  spPermissions: unknown = null,
): string {
  const jsTarget = jsStringLiteral(target);
  const jsToken = jsStringLiteral(sessionToken);
  const jsKey = jsStringLiteral(SESSION_STORAGE_KEY);
  const jsPermsKey = jsStringLiteral(SP_PERMS_STORAGE_KEY);
  // Serialize the policy to a JS string literal we can re-parse client-side.
  // `null` (or anything that fails to serialize) means "clear the key".
  let permsJson: string | null = null;
  if (spPermissions != null) {
    try {
      permsJson = JSON.stringify(spPermissions);
    } catch {
      permsJson = null;
    }
  }
  const jsPerms = permsJson === null ? "null" : jsStringLiteral(permsJson);
  const attrTarget = htmlAttr(target);

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<title>Opening Sales Commission Manager…</title>` +
    `<style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;display:flex;` +
    `min-height:100vh;align-items:center;justify-content:center;color:#475569;background:#f8fafc}` +
    `.s{width:2rem;height:2rem;border:2px solid #cbd5e1;border-top-color:#2563eb;border-radius:9999px;` +
    `animation:r .8s linear infinite}@keyframes r{to{transform:rotate(360deg)}}</style>` +
    `</head><body>` +
    `<div class="s" role="status" aria-label="Opening Sales Commission Manager"></div>` +
    `<noscript><meta http-equiv="refresh" content="0;url=${attrTarget}">` +
    `<p>JavaScript is required to finish signing in. ` +
    `<a href="${attrTarget}">Continue to Sales Commission Manager</a>.</p></noscript>` +
    `<script>(function(){var t=${jsToken};var p=${jsPerms};` +
    // Third-party-cookie-proof transport. Wrapped: Safari Private Browsing and
    // some WebViews throw on localStorage access, and a throw here must not
    // strand the user on a blank page — the cookie may still carry them
    // through, so we navigate regardless.
    `try{window.localStorage.setItem(${jsKey},t)}catch(e){}` +
    // Write the SP permission policy when present, or CLEAR any stale value so a
    // later standalone / non-SP launch is not gated by yesterday's policy. Its
    // own try/catch so a storage throw here never blocks the session write above.
    `try{if(p===null){window.localStorage.removeItem(${jsPermsKey})}else{window.localStorage.setItem(${jsPermsKey},p)}}catch(e){}` +
    `window.location.replace(${jsTarget})})();</script>` +
    `</body></html>`
  );
}
