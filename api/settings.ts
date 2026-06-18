// /api/settings
//   GET -> the current tenant's settings (any authenticated tenant user)
//   PUT -> upsert the current tenant's settings           (owner/admin only)
//
// Real per-resource replacement for the settings portion of the snapshot
// PUT /api/state. Single-row-per-tenant upsert, tenant_id from the session.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser } from "./_lib/auth.js";
import { parseBody, canEditSettings, normalizeSettingsInput } from "./_lib/handlers.js";

const nowISO = () => new Date().toISOString();

/** Shape settings into the AppData.settings the front-end already consumes. */
function toAppSettings(row: any) {
  if (!row) {
    return {
      theme: "light",
      companyName: "",
      assumptions: { avgSetupFee: 2500, avgMonthly: 250, closingsPerMonth: 5, monthlyChurnPct: 3, months: 60 },
    };
  }
  return {
    theme: row.theme === "dark" ? "dark" : "light",
    companyName: row.company_name ?? "",
    assumptions: {
      avgSetupFee: Number(row.default_setup_fee),
      avgMonthly: Number(row.default_monthly_subscription),
      closingsPerMonth: Number(row.default_closings_per_month),
      monthlyChurnPct: Number(row.default_churn_rate),
      months: Number(row.projection_months),
    },
  };
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
      const { rows } = await query<any>(`SELECT * FROM settings WHERE tenant_id = $1`, [tenantId]);
      return res.status(200).json({ settings: toAppSettings(rows[0]) });
    }

    if (req.method === "PUT") {
      if (!canEditSettings(user.role)) return res.status(403).json({ error: "forbidden" });
      const parsed = normalizeSettingsInput(parseBody(req));
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const v = parsed.value;
      const ts = nowISO();
      await query(
        `INSERT INTO settings
           (tenant_id, company_name, theme, default_setup_fee, default_monthly_subscription,
            default_closings_per_month, default_churn_rate, projection_months, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
         ON CONFLICT (tenant_id) DO UPDATE SET
           company_name = EXCLUDED.company_name,
           theme = EXCLUDED.theme,
           default_setup_fee = EXCLUDED.default_setup_fee,
           default_monthly_subscription = EXCLUDED.default_monthly_subscription,
           default_closings_per_month = EXCLUDED.default_closings_per_month,
           default_churn_rate = EXCLUDED.default_churn_rate,
           projection_months = EXCLUDED.projection_months,
           updated_at = EXCLUDED.updated_at`,
        [
          tenantId, v.companyName, v.theme, v.defaultSetupFee, v.defaultMonthly,
          v.closingsPerMonth, v.churnPct, v.months, ts,
        ],
      );
      const { rows } = await query<any>(`SELECT * FROM settings WHERE tenant_id = $1`, [tenantId]);
      return res.status(200).json({ ok: true, settings: toAppSettings(rows[0]) });
    }

    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
