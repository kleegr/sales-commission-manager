// /api/business-profile — the AI Business Setup profile (one row per tenant).
//
//   GET -> { profile }   (any authenticated tenant user; null if not set yet)
//   PUT -> upsert         (owner/admin only)
//
// SECURITY: tenant ALWAYS from the session, never the client. The merge-relevant
// answers are stored as first-class columns; the rest live in a JSONB `profile`
// column. There are no hard-required fields, so a profile saves progressively and
// works with or without AI. Tenant-scoped, so no cross-sub-account leak.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser } from "./_lib/auth.js";
import { normalizeBusinessProfile, businessProfileColumns, rowToBusinessProfile, canManageBusinessProfile } from "./_lib/documents-core.js";

const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    if (req.method === "GET") {
      const { rows } = await query<any>(`SELECT * FROM business_profiles WHERE tenant_id = $1`, [user.tenantId]);
      return res.status(200).json({ profile: rows[0] ? rowToBusinessProfile(rows[0]) : null });
    }

    if (req.method === "PUT" || req.method === "PATCH") {
      if (!canManageBusinessProfile(user.role)) return res.status(403).json({ error: "forbidden" });
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
      const norm = normalizeBusinessProfile(body && typeof body === "object" ? body : {});
      if (!norm.ok) return res.status(400).json({ error: norm.error });

      const { columns, profile } = businessProfileColumns(norm.value);

      // Best-effort audit of the previous value; never blocks the write.
      let before: any = null;
      try {
        const prev = await query<any>(`SELECT * FROM business_profiles WHERE tenant_id = $1`, [user.tenantId]);
        before = prev.rows[0] ? rowToBusinessProfile(prev.rows[0]) : null;
      } catch {
        /* ignore */
      }

      await query(
        `INSERT INTO business_profiles
           (tenant_id, business_name, logo_url, website, industry, address, contact_email, contact_phone, brand_tone, profile, updated_at, updated_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, now(), $11)
         ON CONFLICT (tenant_id) DO UPDATE SET
           business_name = EXCLUDED.business_name,
           logo_url      = EXCLUDED.logo_url,
           website       = EXCLUDED.website,
           industry      = EXCLUDED.industry,
           address       = EXCLUDED.address,
           contact_email = EXCLUDED.contact_email,
           contact_phone = EXCLUDED.contact_phone,
           brand_tone    = EXCLUDED.brand_tone,
           profile       = EXCLUDED.profile,
           updated_at    = now(),
           updated_by_user_id = EXCLUDED.updated_by_user_id`,
        [
          user.tenantId,
          columns.business_name,
          columns.logo_url,
          columns.website,
          columns.industry,
          columns.address,
          columns.contact_email,
          columns.contact_phone,
          columns.brand_tone,
          JSON.stringify(profile),
          user.id,
        ],
      );

      try {
        await query(
          `INSERT INTO audit_logs (id, tenant_id, user_id, entity_type, entity_id, action, before, after)
           VALUES ($1,$2,$3,'business_profile',$2,'upsert',$4::jsonb,$5::jsonb)`,
          [uid("aud"), user.tenantId, user.id, JSON.stringify(before), JSON.stringify(norm.value)],
        );
      } catch {
        /* audit is best-effort */
      }

      const { rows } = await query<any>(`SELECT * FROM business_profiles WHERE tenant_id = $1`, [user.tenantId]);
      return res.status(200).json({ ok: true, profile: rows[0] ? rowToBusinessProfile(rows[0]) : norm.value });
    }

    res.setHeader("Allow", "GET, PUT, PATCH");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
