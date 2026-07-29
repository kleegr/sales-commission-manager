// GET /api/health
// A SAFE, public liveness probe: is the database configured and reachable?
//
// SECURITY: this endpoint is unauthenticated and MUST NOT expose any tenant /
// customer data. It previously returned every tenant's slug, name, GHL location
// id and per-table row counts — a public customer directory. It now returns only
// coarse status. Per-tenant diagnostics are available ONLY to an authenticated
// owner/admin, and ONLY for their OWN tenant (tenant isolation preserved), so
// this can never be used to enumerate the customer base.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, connectionEnvVar, query } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty, getTenantBySlug, tenantCounts } from "./_lib/repository.js";
import { getSessionUser, isAdminRole, demoModeEnabled } from "./_lib/auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) {
    return res.status(200).json({
      ok: false,
      database: { configured: false },
      message:
        "No DATABASE_URL / POSTGRES_URL is set. Add the Neon connection string to the Vercel project env (or .env) and redeploy.",
    });
  }

  try {
    await ensureSchema();
    // Seeding plants the demo/acme sample tenants — a demo/review action ONLY.
    // Never seed a real production database from a public health probe.
    // (A follow-up also makes seedIfEmpty a no-op at the source when demo mode is
    // off; gating here keeps this PR self-contained.)
    let seededOnThisRequest = false;
    if (demoModeEnabled()) {
      const seed = await seedIfEmpty();
      seededOnThisRequest = seed.seeded;
    }

    const { rows: ver } = await query<{ version: string }>("SELECT version()");

    const body: Record<string, unknown> = {
      ok: true,
      database: {
        configured: true,
        envVar: connectionEnvVar,
        engine: ver[0]?.version?.split(" on ")[0] ?? "postgres",
        seededOnThisRequest,
      },
      generatedAt: new Date().toISOString(),
    };

    // Row-count diagnostics for the caller's OWN tenant only, admins only.
    // Never a cross-tenant list — that is what leaked before.
    const user = await getSessionUser(req);
    if (user && isAdminRole(user.role)) {
      const own = await getTenantBySlug(user.tenantSlug);
      if (own) {
        body.tenant = { slug: own.slug, name: own.name, counts: await tenantCounts(own.id) };
      }
    }

    return res.status(200).json(body);
  } catch (err) {
    console.error("[scm:error] health:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return res.status(500).json({
      ok: false,
      database: { configured: true, envVar: connectionEnvVar },
      error: "internal_error",
    });
  }
}
