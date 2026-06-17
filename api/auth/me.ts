// GET /api/auth/me — returns the current authenticated user, or 401.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "../_lib/db.js";
import { ensureSchema, seedIfEmpty } from "../_lib/repository.js";
import { getSessionUser } from "../_lib/auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    return res.status(200).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        tenantSlug: user.tenantSlug,
        tenantName: user.tenantName,
        salespersonId: user.salespersonId,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
