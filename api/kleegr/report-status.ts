// ============================================================================
// POST /api/kleegr/report-status   { status, detail? }
//
// Step 6 — reports our connection status to Kleegr (POST /api/integration/status
// with the integration token). Admin-only. The sub-account id is taken from the
// SESSION's tenant (never the client), so a caller cannot report on behalf of a
// sub-account they aren't in.
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query } from "../_lib/db.js";
import { ensureSchema, seedIfEmpty } from "../_lib/repository.js";
import { getSessionUser, isAdminRole } from "../_lib/auth.js";
import { reportIntegrationStatus, INTEGRATION_STATUSES, type IntegrationStatus } from "../_lib/kleegr.js";

function parseBody(req: VercelRequest): any {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
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

    const body = parseBody(req);
    const status = (String(body.status ?? "connected") as IntegrationStatus);
    if (!INTEGRATION_STATUSES.includes(status)) {
      return res.status(400).json({ error: "invalid_status", allowed: INTEGRATION_STATUSES });
    }
    const detail = String(body.detail ?? "Sales Commission Manager connected.").slice(0, 500);

    // sub-account id from the session's tenant (authoritative)
    const t = await query<{ kleegr_sub_account_id: string | null }>(
      `SELECT kleegr_sub_account_id FROM tenants WHERE id = $1`,
      [user.tenantId],
    );
    const subAccountId = t.rows[0]?.kleegr_sub_account_id ?? null;
    if (!subAccountId) {
      return res.status(400).json({ error: "not_connected", message: "This workspace is not linked to a Kleegr sub-account yet." });
    }

    const result = await reportIntegrationStatus(status, subAccountId, detail);
    return res.status(200).json({ ok: result.ok, reported: status, subAccountId, kleegrStatus: result.status });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
