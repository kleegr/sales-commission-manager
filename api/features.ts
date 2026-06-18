// /api/features
//   GET -> the current tenant's feature-access map (any authenticated tenant user)
//   PUT -> set feature overrides for the current tenant            (owner/admin only)
//   PATCH -> alias of PUT (partial update)
//
// The agency/owner controls which product areas a sub-account may use. Flags are
// DB-backed (tenant_feature_access) and STRICTLY tenant-scoped: the tenant_id
// comes from the SESSION, never the client, so there is no cross-tenant write
// vector. Features are ENABLED BY DEFAULT (a tenant with no rows gets the full
// product); a PUT writes explicit overrides. The client reads this to hide /
// block disabled areas, but the server is the source of truth.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser } from "./_lib/auth.js";
import {
  parseBody,
  canManageFeatures,
  normalizeFeatureFlags,
  mergeFeatureRows,
  type FeatureFlags,
} from "./_lib/handlers.js";

const nowISO = () => new Date().toISOString();
const uid = (p: string) =>
  `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** Read the effective (default-on + overrides) flag map for one tenant. */
async function readFlags(tenantId: string): Promise<FeatureFlags> {
  const { rows } = await query<{ feature: string; enabled: boolean }>(
    `SELECT feature, enabled FROM tenant_feature_access WHERE tenant_id = $1`,
    [tenantId],
  );
  return mergeFeatureRows(rows);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const tenantId = user.tenantId;

    if (req.method === "GET") {
      return res.status(200).json({ features: await readFlags(tenantId) });
    }

    if (req.method === "PUT" || req.method === "PATCH") {
      if (!canManageFeatures(user.role)) return res.status(403).json({ error: "forbidden" });
      const parsed = normalizeFeatureFlags(parseBody(req));
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });

      const before = await readFlags(tenantId);
      const ts = nowISO();
      // Upsert each provided feature as an explicit, tenant-scoped override.
      for (const [feature, enabled] of Object.entries(parsed.value)) {
        await query(
          `INSERT INTO tenant_feature_access
             (tenant_id, feature, enabled, updated_at, updated_by_user_id)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id, feature) DO UPDATE SET
             enabled = EXCLUDED.enabled,
             updated_at = EXCLUDED.updated_at,
             updated_by_user_id = EXCLUDED.updated_by_user_id`,
          [tenantId, feature, enabled, ts, user.id],
        );
      }

      const after = await readFlags(tenantId);

      // Best-effort audit trail; never blocks the write.
      try {
        await query(
          `INSERT INTO audit_logs
             (id, tenant_id, user_id, entity_type, entity_id, action, before, after)
           VALUES ($1,$2,$3,'tenant_feature_access',$2,'update',$4::jsonb,$5::jsonb)`,
          [uid("aud"), tenantId, user.id, JSON.stringify(before), JSON.stringify(after)],
        );
      } catch {
        /* ignore audit failure */
      }

      return res.status(200).json({ ok: true, features: after });
    }

    res.setHeader("Allow", "GET, PUT, PATCH");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
