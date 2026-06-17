// GET /api/tenants -> the list of tenants/locations (powers the tenant switcher
// and demonstrates multi-tenant data separation).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "./_lib/db";
import { ensureSchema, listTenants, seedIfEmpty } from "./_lib/repository";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(200).json({ configured: false, tenants: [] });
  try {
    await ensureSchema();
    await seedIfEmpty();
    const tenants = await listTenants();
    return res.status(200).json({
      configured: true,
      tenants: tenants.map((t) => ({
        slug: t.slug,
        name: t.name,
        ghlLocationId: t.ghl_location_id,
        status: t.status,
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
