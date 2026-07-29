// GET /api/tenants -> the tenant(s) the caller is allowed to see (powers the
// workspace switcher).
//
// SECURITY: this is NOT a public directory of every workspace. It previously
// returned every tenant's slug/name/GHL location id with no auth. Now:
//   - Trusted demo/review mode  -> the demo tenants (so the review bar can hop).
//   - Real auth                 -> the caller's OWN tenant only.
//   - Unauthenticated (prod)    -> 401.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "./_lib/db.js";
import { ensureSchema, listTenants, getTenantBySlug, seedIfEmpty, type TenantRow } from "./_lib/repository.js";
import { getSessionUser, demoModeEnabled } from "./_lib/auth.js";

const shape = (t: TenantRow) => ({
  slug: t.slug,
  name: t.name,
  ghlLocationId: t.ghl_location_id,
  status: t.status,
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(200).json({ configured: false, tenants: [] });
  try {
    await ensureSchema();

    // Trusted review context: list the demo tenants (seed is a no-op otherwise).
    if (demoModeEnabled()) {
      await seedIfEmpty();
      const tenants = await listTenants();
      return res.status(200).json({ configured: true, demo: true, tenants: tenants.map(shape) });
    }

    // Real auth: only ever the caller's own tenant. No public enumeration.
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const own = await getTenantBySlug(user.tenantSlug);
    return res.status(200).json({ configured: true, tenants: own ? [shape(own)] : [] });
  } catch (err) {
    console.error("[scm:error] tenants:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return res.status(500).json({ error: "internal_error" });
  }
}
