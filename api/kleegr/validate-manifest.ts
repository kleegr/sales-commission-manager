// ============================================================================
// POST /api/kleegr/validate-manifest
//
// Step 10 — validates the app manifest via Kleegr's dry run
// (POST /api/agency/apps/import { manifest, dryRun:true }) using the integration
// token. Admin-only. Returns Kleegr's verdict so the settings UI / handoff can
// confirm the manifest is acceptable before a real import.
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "../_lib/db.js";
import { ensureSchema, seedIfEmpty } from "../_lib/repository.js";
import { getSessionUser, isAdminRole } from "../_lib/auth.js";
import { validateManifestDryRun, readKleegrConfig, KleegrError } from "../_lib/kleegr.js";
import { KLEEGR_MANIFEST } from "../_lib/kleegr-manifest.js";

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
      return res.status(200).json({ ok: false, valid: false, code: "config_error", message: "KLEEGR_INTEGRATION_TOKEN is not set" });
    }

    try {
      const result = await validateManifestDryRun(KLEEGR_MANIFEST);
      return res.status(200).json({ ok: result.ok, valid: result.valid, kleegrStatus: result.status, body: result.body });
    } catch (err) {
      if (err instanceof KleegrError) {
        return res.status(200).json({ ok: false, valid: false, code: err.code, httpStatus: err.status, message: err.message });
      }
      return res.status(200).json({ ok: false, valid: false, code: "error", message: String((err as any)?.message ?? err) });
    }
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
