// ============================================================================
// /api/agency  (GET)
//
// Per-sub-account rollups for the agency / super-admin overview: revenue,
// commission liability vs paid, payout status, document counts, feature access,
// and last activity — plus a cross-tenant summary.
//
// ACCESS MODEL (tenant isolation preserved):
//   - Requires a session; ONLY owner/admin may read agency rollups (403 else).
//   - In REVIEW/DEMO mode (the trusted, no-login review context) the response
//     spans ALL tenants — the same cross-tenant visibility the review bar
//     already grants by letting a reviewer hop between sub-accounts.
//   - Under REAL auth there is no cross-tenant principal, so the response is
//     scoped to the caller's OWN tenant only. Financial aggregates are never
//     exposed across tenants outside trusted review mode; the public
//     /api/health (counts only) remains the unauthenticated surface.
//
// The tenant id set is decided HERE; repository.agencyAggregates only ever sees
// ids the caller is allowed to read, so there is no cross-tenant leak.
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "./_lib/db.js";
import {
  ensureSchema,
  seedIfEmpty,
  listTenants,
  getTenantBySlug,
  agencyAggregates,
  type TenantRow,
} from "./_lib/repository.js";
import { getSessionUser, isAdminRole, demoModeEnabled } from "./_lib/auth.js";
import { readTenantFlags } from "./_lib/feature-access.js";
import { assembleRollup, summarizeAgency, type TenantMeta } from "./_lib/agency-core.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    await ensureSchema();
    await seedIfEmpty();

    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    if (!isAdminRole(user.role)) {
      return res.status(403).json({ error: "forbidden", hint: "agency overview is owner/admin only" });
    }

    const demo = demoModeEnabled();

    // Decide the visible tenant set. All tenants only in trusted review mode;
    // otherwise strictly the caller's own tenant.
    let tenantRows: TenantRow[];
    if (demo) {
      tenantRows = await listTenants();
    } else {
      const own = await getTenantBySlug(user.tenantSlug);
      tenantRows = own ? [own] : [];
    }

    const tenantIds = tenantRows.map((t) => t.id);
    const [aggs, flags] = await Promise.all([
      agencyAggregates(tenantIds),
      Promise.all(tenantRows.map((t) => readTenantFlags(t.id))),
    ]);

    const aggById = new Map(aggs.map((a) => [a.tenantId, a]));
    const rollups = tenantRows.map((t, i) => {
      const meta: TenantMeta = {
        tenantId: t.id,
        slug: t.slug,
        name: t.name,
        status: t.status,
        ghlLocationId: t.ghl_location_id,
      };
      return assembleRollup(meta, aggById.get(t.id)!, flags[i]);
    });

    return res.status(200).json({
      scope: demo ? "agency" : "tenant",
      demo,
      viewer: { tenant: user.tenantSlug, role: user.role },
      summary: summarizeAgency(rollups),
      tenants: rollups,
      generatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
