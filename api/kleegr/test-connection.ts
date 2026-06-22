// ============================================================================
// POST /api/kleegr/test-connection
//
// Step 1 (live) — verifies the server-side integration token by calling Kleegr
// GET /api/integration/me. Admin-only. The token is read from the environment
// and never returned to the browser; only the verification verdict + the public
// identity (app/scopes/subAccounts) Kleegr reports back are surfaced.
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "../_lib/db.js";
import { ensureSchema, seedIfEmpty } from "../_lib/repository.js";
import { getSessionUser, isAdminRole } from "../_lib/auth.js";
import { verifyIntegrationToken, readKleegrConfig, KleegrError } from "../_lib/kleegr.js";

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

    const cfg = readKleegrConfig();
    if (!cfg.hasIntegrationToken) {
      return res.status(200).json({ ok: false, code: "config_error", message: "KLEEGR_INTEGRATION_TOKEN is not set", missing: cfg.missing });
    }

    try {
      const identity = await verifyIntegrationToken();
      return res.status(200).json({
        ok: true,
        baseUrl: cfg.baseUrl,
        identity: { app: identity.app, scopes: identity.scopes, subAccounts: identity.subAccounts },
      });
    } catch (err) {
      if (err instanceof KleegrError) {
        return res.status(200).json({ ok: false, code: err.code, httpStatus: err.status, message: err.message });
      }
      return res.status(200).json({ ok: false, code: "error", message: String((err as any)?.message ?? err) });
    }
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
