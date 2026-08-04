// POST /api/auth/logout — destroy the current session and clear the cookie.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "../_lib/db.js";
import { ensureSchema } from "../_lib/repository.js";
import { getSessionTokens, destroySession, clearSessionCookie } from "../_lib/auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  try {
    await ensureSchema();
    // Revoke EVERY transport the request offered — the Bearer token the
    // embedded client replays from localStorage as well as the cookie —
    // so logging out of the iframe really ends the session.
    for (const token of getSessionTokens(req)) await destroySession(token);
    clearSessionCookie(res);
    return res.status(200).json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
