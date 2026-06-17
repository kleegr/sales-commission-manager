// POST /api/seed         -> seed demo tenants only if the DB is empty
// POST /api/seed?reset=1  -> force a full re-seed of the demo tenants
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty, seedAll, listTenants } from "./_lib/repository.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  try {
    await ensureSchema();
    const reset = String(req.query.reset ?? "") === "1";
    if (reset) {
      await seedAll();
    } else {
      await seedIfEmpty();
    }
    const tenants = await listTenants();
    return res.status(200).json({ ok: true, reset, tenants: tenants.map((t) => t.slug) });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
