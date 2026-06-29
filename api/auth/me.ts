// GET /api/auth/me — returns the current authenticated user, or 401.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "../_lib/db.js";
import { ensureSchema, seedIfEmpty } from "../_lib/repository.js";
import { getRealSessionUser, getDemoUser, demoModeEnabled } from "../_lib/auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  try {
    await ensureSchema();
    await seedIfEmpty();
    // Resolve the real (cookie-backed) session first so we can tell a genuine
    // login / Kleegr launch apart from a review-mode demo identity.
    const real = await getRealSessionUser(req);
    const user = real ?? (await getDemoUser(req));
    if (!user) return res.status(401).json({ error: "unauthorized", demo: demoModeEnabled() });
    // Only advertise review/demo mode when the ACTIVE session is itself a demo
    // user. A real session (e.g. a verified Kleegr launch) must never surface
    // the review-mode bar, even while DEMO_MODE is globally enabled — that bar
    // appearing on a real launch was part of the "owner saw review mode" report.
    return res.status(200).json({
      demo: !real && demoModeEnabled(),
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
