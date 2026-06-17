// /api/clients
//   GET  -> clients visible to the current user (role-scoped)
//   POST -> create ONE client (single-row INSERT, not a snapshot replace-all)
//
// Demonstrates a real per-resource database write. Owner/admin can assign any
// salesperson; a sales_manager may only assign to their own team.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser } from "./_lib/auth.js";

const nowISO = () => new Date().toISOString();
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    if (req.method === "GET") {
      let sql = `SELECT * FROM clients WHERE tenant_id = $1`;
      const params: any[] = [user.tenantId];
      if (user.role === "sales_manager") {
        sql += ` AND salesperson_id IN (SELECT id FROM salespeople WHERE tenant_id = $1 AND manager_user_id = $2)`;
        params.push(user.id);
      } else if (["salesperson", "affiliate", "partner"].includes(user.role)) {
        sql += ` AND salesperson_id = $2`;
        params.push(user.salespersonId ?? "__none__");
      }
      sql += ` ORDER BY created_at DESC`;
      const { rows } = await query<any>(sql, params);
      return res.status(200).json({ clients: rows });
    }

    if (req.method === "POST") {
      const SELF_ROLES = ["salesperson", "affiliate", "partner"];
      if (!["owner", "admin", "sales_manager", ...SELF_ROLES].includes(user.role)) {
        return res.status(403).json({ error: "forbidden" });
      }
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
      const companyName = String(body.companyName ?? "").trim();
      if (!companyName) return res.status(400).json({ error: "company_name_required" });

      let salespersonId: string | null = body.salespersonId ? String(body.salespersonId) : null;

      if (SELF_ROLES.includes(user.role)) {
        // A rep/affiliate/partner can only file a lead against THEIR OWN record.
        salespersonId = user.salespersonId ?? null;
      } else if (salespersonId) {
        // validate the salesperson is in this tenant (and the manager's team)
        const { rows } = await query<any>(
          `SELECT id, manager_user_id FROM salespeople WHERE tenant_id = $1 AND id = $2`,
          [user.tenantId, salespersonId],
        );
        if (rows.length === 0) return res.status(400).json({ error: "invalid_salesperson" });
        if (user.role === "sales_manager" && rows[0].manager_user_id !== user.id) {
          return res.status(403).json({ error: "salesperson_not_on_team" });
        }
      }

      const id = uid("cl");
      const ts = nowISO();
      await query(
        `INSERT INTO clients
           (id, tenant_id, salesperson_id, company_name, contact_name, email, phone, signup_date,
            setup_fee_amount, monthly_subscription_amount, status, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
        [
          id, user.tenantId, salespersonId, companyName,
          String(body.contactName ?? ""), String(body.email ?? ""), String(body.phone ?? ""),
          String(body.signupDate ?? ts.slice(0, 10)),
          Number(body.setupFee ?? 0), Number(body.monthlySubscription ?? 0),
          String(body.status ?? "active"), String(body.notes ?? ""), ts,
        ],
      );
      return res.status(201).json({ ok: true, id });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
