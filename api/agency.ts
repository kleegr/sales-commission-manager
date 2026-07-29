// ============================================================================
// /api/agency  (GET)
//
// Per-sub-account rollups for the agency / super-admin overview: revenue,
// commission liability vs paid, payout status, document counts, feature access,
// and last activity — plus a cross-tenant summary.
//
// ACCESS MODEL (real agency principal — tenant isolation preserved):
//   - Requires a session; ONLY owner/admin may read agency rollups (403 else).
//   - Cross-tenant visibility is derived from the caller's VERIFIED tenant's
//     agency_id — never from demo mode. An OWNER whose tenant belongs to an
//     agency sees every sub-account under THAT agency (filtered by agency_id);
//     an admin, or an owner whose tenant has no agency, sees only their OWN
//     tenant. There is no code path that returns every tenant in the database.
//
// The tenant id set is decided HERE; repository.agencyAggregates only ever sees
// ids the caller is allowed to read, so there is no cross-tenant leak.
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query } from "./_lib/db.js";
import {
  ensureSchema,
  getTenantBySlug,
  agencyAggregates,
  type TenantRow,
} from "./_lib/repository.js";
import { getSessionUser, isAdminRole } from "./_lib/auth.js";
import { readTenantFlags } from "./_lib/feature-access.js";
import { assembleRollup, summarizeAgency, type TenantMeta } from "./_lib/agency-core.js";
import { resolveAgencyScope } from "./_lib/agency-scope.js";

/** Every tenant under one agency (the ONLY cross-tenant query, always filtered). */
async function tenantsForAgency(agencyId: string): Promise<TenantRow[]> {
  const { rows } = await query<TenantRow>(
    `SELECT id, name, slug, ghl_location_id, agency_id, status
       FROM tenants WHERE agency_id = $1 ORDER BY created_at ASC, name ASC`,
    [agencyId],
  );
  return rows;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    await ensureSchema();

    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    if (!isAdminRole(user.role)) {
      return res.status(403).json({ error: "forbidden", hint: "agency overview is owner/admin only" });
    }

    // Resolve the caller's agency from their VERIFIED tenant, then decide scope.
    const own = await getTenantBySlug(user.tenantSlug);
    const agencyId = own?.agency_id ?? null;
    const scope = resolveAgencyScope(user.role, agencyId);

    const tenantRows: TenantRow[] =
      scope === "agency" && agencyId
        ? await tenantsForAgency(agencyId)
        : own
          ? [own]
          : [];

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
      scope,
      agencyId,
      viewer: { tenant: user.tenantSlug, role: user.role },
      summary: summarizeAgency(rollups),
      tenants: rollups,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[scm:error] agency:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return res.status(500).json({ error: "internal_error" });
  }
}
