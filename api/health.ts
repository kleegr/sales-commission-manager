// GET /api/health
// Single source of truth for "is the database real and working?".
//  - confirms a connection string is configured (and which env var held it)
//  - ensures the schema exists (idempotent)
//  - seeds the two demo tenants on first run (proves a WRITE)
//  - returns Postgres version + per-tenant row counts (proves a READ)
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, connectionEnvVar, query } from "./_lib/db";
import { ensureSchema, seedIfEmpty, listTenants, tenantCounts } from "./_lib/repository";

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
    const seed = await seedIfEmpty();

    const [{ rows: ver }, tenants] = await Promise.all([
      query<{ version: string }>("SELECT version()"),
      listTenants(),
    ]);

    const tenantReport = [];
    for (const t of tenants) {
      tenantReport.push({
        slug: t.slug,
        name: t.name,
        ghlLocationId: t.ghl_location_id,
        counts: await tenantCounts(t.id),
      });
    }

    return res.status(200).json({
      ok: true,
      database: {
        configured: true,
        envVar: connectionEnvVar,
        engine: ver[0]?.version?.split(" on ")[0] ?? "postgres",
        seededOnThisRequest: seed.seeded,
      },
      tenantCount: tenants.length,
      tenants: tenantReport,
      generatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      database: { configured: true, envVar: connectionEnvVar },
      error: String(err?.message ?? err),
    });
  }
}
