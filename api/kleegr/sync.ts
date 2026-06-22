// ============================================================================
// POST /api/kleegr/sync
//
// Step 8 — runs the safe, idempotent first sync (subaccount → users → contacts
// → opportunities) for the session's tenant. Admin-only.
//
// Gateway reads require a SHORT-LIVED Kleegr launch token. Per the integration
// rules we never cache or reuse launch tokens, so this endpoint requires a
// FRESH launch token in the Authorization header (Bearer …) — supplied by a
// Kleegr-initiated call/automation. The normal path is automatic: the launch
// flow (/api/kleegr/launch) runs this same sync while it still holds the token.
// The settings UI therefore shows the LAST sync result rather than minting a
// token client-side (which it must never do).
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "../_lib/db.js";
import { ensureSchema, seedIfEmpty } from "../_lib/repository.js";
import { getSessionUser, isAdminRole } from "../_lib/auth.js";
import { runInitialSync } from "../_lib/kleegr-sync.js";

function bearer(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });

  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    if (!isAdminRole(user.role)) return res.status(403).json({ error: "forbidden" });

    const launchToken = bearer(req);
    if (!launchToken) {
      return res.status(400).json({
        error: "launch_token_required",
        message:
          "Gateway reads need a fresh Kleegr launch token (launch tokens are never cached). " +
          "Re-open the app from Kleegr to run a sync, or call this endpoint with a fresh launch token.",
      });
    }

    const summary = await runInitialSync({ launchToken, tenantId: user.tenantId });
    return res.status(200).json({ ok: true, summary });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
