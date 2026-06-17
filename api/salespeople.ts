// /api/salespeople
//   GET            -> salespeople/affiliates/partners visible to the user (role-scoped)
//   POST           -> create one person            (owner/admin)
//   PATCH ?id=...  -> partial update of one person (owner/admin)
//   DELETE ?id=... -> deactivate (default) or hard-delete with ?hard=1 (owner/admin)
//
// A real per-resource replacement for the salespeople portion of the snapshot
// PUT /api/state. Every statement is scoped by tenant_id (derived from the
// session, never the client) so one tenant can never read or mutate another's
// rows. Mirrors the structure of api/clients.ts.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser } from "./_lib/auth.js";
import {
  parseBody,
  uid,
  canManagePeople,
  readScopeFor,
  normalizeSalespersonInsert,
  buildSalespersonUpdate,
} from "./_lib/handlers.js";

const nowISO = () => new Date().toISOString();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const tenantId = user.tenantId;

    // ---- GET: role-scoped list ------------------------------------------
    if (req.method === "GET") {
      let sql = `SELECT * FROM salespeople WHERE tenant_id = $1`;
      const params: any[] = [tenantId];
      const scope = readScopeFor(user.role);
      if (scope === "team") {
        sql += ` AND manager_user_id = $2`;
        params.push(user.id);
      } else if (scope === "self") {
        sql += ` AND id = $2`;
        params.push(user.salespersonId ?? "__none__");
      }
      sql += ` ORDER BY created_at ASC, name ASC`;
      const { rows } = await query<any>(sql, params);
      return res.status(200).json({ salespeople: rows });
    }

    // ---- POST: create ----------------------------------------------------
    if (req.method === "POST") {
      if (!canManagePeople(user.role)) return res.status(403).json({ error: "forbidden" });
      const parsed = normalizeSalespersonInsert(parseBody(req));
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const v = parsed.value;

      // If a plan is assigned, it must belong to THIS tenant.
      if (v.commissionPlanId) {
        const { rows } = await query<any>(
          `SELECT id FROM commission_plans WHERE tenant_id = $1 AND id = $2`,
          [tenantId, v.commissionPlanId],
        );
        if (rows.length === 0) return res.status(400).json({ error: "invalid_commission_plan" });
      }

      const id = uid("sp");
      const ts = nowISO();
      await query(
        `INSERT INTO salespeople
           (id, tenant_id, name, email, phone, role, referral_code, status, approval_status, source,
            commission_plan_id, weekly_salary, salary_start_date, salary_end_date, company_name, website,
            referral_source, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)`,
        [
          id, tenantId, v.name, v.email, v.phone, v.role, v.referralCode, v.status, v.approvalStatus,
          v.source, v.commissionPlanId, v.weeklySalary, v.salaryStartDate, v.salaryEndDate,
          v.companyName, v.website, v.referralSource, v.notes, ts,
        ],
      );
      return res.status(201).json({ ok: true, id });
    }

    // ---- PATCH: partial update ------------------------------------------
    if (req.method === "PATCH") {
      if (!canManagePeople(user.role)) return res.status(403).json({ error: "forbidden" });
      const id = String(req.query.id ?? "");
      if (!id) return res.status(400).json({ error: "id_required" });

      const built = buildSalespersonUpdate(parseBody(req));
      if (!built.ok) return res.status(400).json({ error: built.error });

      if (built.value.commission_plan_id) {
        const { rows } = await query<any>(
          `SELECT id FROM commission_plans WHERE tenant_id = $1 AND id = $2`,
          [tenantId, built.value.commission_plan_id],
        );
        if (rows.length === 0) return res.status(400).json({ error: "invalid_commission_plan" });
      }

      const cols = Object.keys(built.value);
      const setSql = cols.map((c, i) => `${c} = $${i + 3}`).join(", ");
      const vals = cols.map((c) => built.value[c]);
      // tenant_id in WHERE => cannot touch another tenant's row even with a guessed id
      const { rowCount } = await query(
        `UPDATE salespeople SET ${setSql} WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId, ...vals],
      );
      if (rowCount === 0) return res.status(404).json({ error: "not_found" });
      return res.status(200).json({ ok: true, id });
    }

    // ---- DELETE: deactivate (default) or hard delete --------------------
    if (req.method === "DELETE") {
      if (!canManagePeople(user.role)) return res.status(403).json({ error: "forbidden" });
      const id = String(req.query.id ?? "");
      if (!id) return res.status(400).json({ error: "id_required" });
      const hard = String(req.query.hard ?? "") === "1";

      if (hard) {
        // Refuse hard-delete if the person still has clients (avoid orphaning data).
        const { rows } = await query<{ n: string }>(
          `SELECT count(*)::text AS n FROM clients WHERE tenant_id = $1 AND salesperson_id = $2`,
          [tenantId, id],
        );
        if (Number(rows[0]?.n ?? 0) > 0) {
          return res.status(409).json({ error: "has_clients", hint: "deactivate instead" });
        }
        const { rowCount } = await query(
          `DELETE FROM salespeople WHERE id = $1 AND tenant_id = $2`,
          [id, tenantId],
        );
        if (rowCount === 0) return res.status(404).json({ error: "not_found" });
        return res.status(200).json({ ok: true, id, deleted: true });
      }

      const { rowCount } = await query(
        `UPDATE salespeople SET status = 'inactive', updated_at = $3 WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId, nowISO()],
      );
      if (rowCount === 0) return res.status(404).json({ error: "not_found" });
      return res.status(200).json({ ok: true, id, deactivated: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
