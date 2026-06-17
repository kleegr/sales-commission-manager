// /api/state?tenant=<slug>
//   GET -> the tenant's full AppData snapshot (assembled from normalized tables)
//   PUT -> persist a full AppData snapshot for the tenant (transactional replace)
//
// This is the adapter that lets the existing localStorage-shaped front-end run
// on Postgres without touching the UI or the commission engine: the client's
// ApiStore simply GETs and PUTs AppData here, and this function does the
// relational read/write, tenant-scoped.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "./_lib/db.js";
import { ensureSchema, getTenantBySlug, readState, writeState, seedIfEmpty } from "./_lib/repository.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) {
    return res.status(503).json({ error: "database_not_configured" });
  }

  const slug = String(req.query.tenant ?? "demo").trim() || "demo";

  try {
    await ensureSchema();
    await seedIfEmpty(); // guarantees the default tenants exist on a cold DB

    const tenant = await getTenantBySlug(slug);
    if (!tenant) {
      return res.status(404).json({ error: "tenant_not_found", slug });
    }

    if (req.method === "GET") {
      const data = await readState(tenant.id);
      return res.status(200).json({ tenant: { slug: tenant.slug, name: tenant.name }, data });
    }

    if (req.method === "PUT" || req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
      const data = body.data ?? body;
      if (!data || !Array.isArray(data.salespeople)) {
        return res.status(400).json({ error: "invalid_payload", hint: "expected an AppData object or { data: AppData }" });
      }
      await writeState(tenant.id, data);
      return res.status(200).json({ ok: true, tenant: tenant.slug });
    }

    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
