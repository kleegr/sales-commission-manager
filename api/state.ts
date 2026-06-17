// /api/state
//   GET -> the CURRENT USER's AppData, scoped to their tenant AND role.
//   PUT -> persist a full AppData snapshot (owner/admin only) for their tenant.
//
// SECURITY: the tenant is taken from the authenticated session, never from the
// client. A query param `?tenant=` is accepted only if it matches the session
// tenant; any mismatch is a 403. Non-admin roles receive a server-filtered
// dataset (their own / their team's rows only) and may NOT write the snapshot
// (which is a replace-all and would otherwise wipe sibling data). Their write
// actions go through dedicated per-resource endpoints (e.g. /api/payouts).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "./_lib/db.js";
import { ensureSchema, readScopedState, writeState, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser, isAdminRole } from "./_lib/auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });

  try {
    await ensureSchema();
    await seedIfEmpty();

    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    // If a tenant is named in the query, it must match the session tenant.
    const requested = req.query.tenant ? String(req.query.tenant).trim() : null;
    if (requested && requested !== user.tenantSlug) {
      return res.status(403).json({ error: "tenant_forbidden" });
    }

    if (req.method === "GET") {
      const data = await readScopedState(user.tenantId, {
        userId: user.id,
        role: user.role,
        salespersonId: user.salespersonId,
      });
      return res.status(200).json({
        tenant: { slug: user.tenantSlug, name: user.tenantName },
        role: user.role,
        data,
      });
    }

    if (req.method === "PUT" || req.method === "POST") {
      if (!isAdminRole(user.role)) {
        return res.status(403).json({ error: "forbidden", hint: "snapshot writes are owner/admin only" });
      }
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
      const data = body.data ?? body;
      if (!data || !Array.isArray(data.salespeople)) {
        return res.status(400).json({ error: "invalid_payload" });
      }
      await writeState(user.tenantId, data);
      return res.status(200).json({ ok: true, tenant: user.tenantSlug });
    }

    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
