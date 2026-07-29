// ============================================================================
// HTTP SECURITY HELPERS  (CSRF + client IP)
//
// CSRF: sessions are cookie-based, and the Kleegr launch issues a SameSite=None
// cookie (sent on cross-site requests), so state-changing requests need a CSRF
// defense. Browsers ALWAYS attach an Origin (or at least a Referer) to cross-site
// POST/PATCH/PUT/DELETE, so a forged cross-site request carries the attacker's
// origin and is rejected. Safe methods are always allowed. Requests with neither
// Origin nor Referer are allowed — those are non-browser/API clients, which
// cannot carry a victim's cookie, so they are not a CSRF vector.
// ============================================================================

import type { VercelRequest } from "@vercel/node";

/** Host portion of a URL string, or "" if it can't be parsed. */
function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * True if a state-changing request is allowed to proceed (CSRF check passes).
 * Callers use: `if (!csrfOk(req)) return res.status(403).json({ error: "csrf_check_failed" });`
 */
export function csrfOk(req: VercelRequest): boolean {
  const method = (req.method || "GET").toUpperCase();
  if (SAFE_METHODS.has(method)) return true;

  const host = String(req.headers.host || "");
  if (!host) return true; // cannot compare; don't hard-fail infra probes

  const origin = String((req.headers.origin as string | undefined) || "");
  if (origin) return hostOf(origin) === host;

  const referer = String((req.headers.referer as string | undefined) || "");
  if (referer) return hostOf(referer) === host;

  // No Origin and no Referer -> not a browser CSRF vector (no ambient cookie).
  return true;
}

/** Best-effort client IP from the standard proxy headers (for rate limiting). */
export function clientIp(req: VercelRequest): string {
  const xff = String((req.headers["x-forwarded-for"] as string | undefined) || "");
  if (xff) return xff.split(",")[0].trim();
  return String((req.headers["x-real-ip"] as string | undefined) || "").trim();
}
