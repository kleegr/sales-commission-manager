// POST /api/auth/logout — destroy the current session and clear the cookie.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "../_lib/db.js";
import { ensureSchema } from "../_lib/repository.js";
import { getSessionTokens, destroySession, clearSessionCookie } from "../_lib/auth.js";
import { csrfOk } from "../_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (!csrfOk(req)) return res.status(403).json({ error: "csrf_check_failed" });
  try {
    await ensureSchema();
    // Revoke EVERY transport the request offered — the Bearer token the
    // embedded client replays from localStorage as well as the cookie —
    // so logging out of the iframe really ends the session.
    for (const token of getSessionTokens(req)) await destroySession(token);
    clearSessionCookie(res);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[scm:error] logout:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return res.status(500).json({ error: "internal_error" });
  }
}
