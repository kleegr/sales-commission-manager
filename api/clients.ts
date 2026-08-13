// /api/clients
//   GET    -> clients visible to the current user (role-scoped)
//   POST   -> create ONE client
//   PATCH  -> update ONE client (?id=)   + recompute its ledger
//   DELETE -> delete ONE client (?id=)   + its payments and unlocked ledger rows
//
// Every write is a targeted single-row statement — this is the endpoint that
// replaced the client portion of the retired `PUT /api/state` snapshot.
//
// A client change is COMMISSION-AFFECTING: its rep decides whose commission a
// payment generates, its status + cancellation date drive holds and clawbacks,
// and its fees are the base amounts. So any write that touches one of those
// fields recomputes the client's ledger inside the same transaction, and a
// delete is refused while the client still has locked (submitted / approved /
// paid) commission lines — that money is in a payout batch and removing it would
// leave the batch pointing at rows that no longer exist.
//
// Owner/admin can assign any salesperson; a sales_manager may only act within
// their own team; a rep/affiliate/partner may only file leads against
// themselves.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query, withTransaction } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser, type SessionUser } from "./_lib/auth.js";
import { csrfOk } from "./_lib/http.js";
import {
  buildClientUpdate,
  normalizeClientInput,
  uid,
} from "./_lib/commission-handlers.js";
import { LOCKED_STATUSES, recomputeClientInTx } from "./_lib/recompute.js";
import { todayISO } from "../src/lib/format.js";

const nowISO = () => new Date().toISOString();

const SELF_ROLES = ["salesperson", "affiliate", "partner"];

function parse(req: VercelRequest): Record<string, unknown> {
  const b = req.body;
  if (b == null) return {};
  if (typeof b === "string") {
    try { return JSON.parse(b || "{}"); } catch { return {}; }
  }
  return b as Record<string, unknown>;
}

/**
 * Resolve the salesperson a write may attach to the client, enforcing scope:
 * a self role is pinned to their own record, a manager to their team, and
 * owner/admin to anyone in the tenant.
 */
async function resolveSalesperson(
  user: SessionUser,
  requested: string | null,
): Promise<{ ok: true; id: string | null } | { ok: false; error: string; status: number }> {
  if (SELF_ROLES.includes(user.role)) return { ok: true, id: user.salespersonId ?? null };
  if (!requested) return { ok: true, id: null };
  const { rows } = await query<any>(
    `SELECT id, manager_user_id FROM salespeople WHERE tenant_id = $1 AND id = $2`,
    [user.tenantId, requested],
  );
  if (rows.length === 0) return { ok: false, error: "invalid_salesperson", status: 400 };
  if (user.role === "sales_manager" && rows[0].manager_user_id !== user.id) {
    return { ok: false, error: "salesperson_not_on_team", status: 403 };
  }
  return { ok: true, id: requested };
}

/** Is this client inside the caller's read/write scope? */
async function clientInScope(
  user: SessionUser,
  clientId: string,
): Promise<{ found: boolean; inScope: boolean; salespersonId: string | null }> {
  const { rows } = await query<any>(
    `SELECT c.id, c.salesperson_id, s.manager_user_id
       FROM clients c
       LEFT JOIN salespeople s ON s.id = c.salesperson_id AND s.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [user.tenantId, clientId],
  );
  const row = rows[0];
  if (!row) return { found: false, inScope: false, salespersonId: null };
  const spId: string | null = row.salesperson_id ?? null;
  if (["owner", "admin"].includes(user.role)) return { found: true, inScope: true, salespersonId: spId };
  if (user.role === "sales_manager") {
    return { found: true, inScope: row.manager_user_id === user.id, salespersonId: spId };
  }
  return { found: true, inScope: !!spId && spId === user.salespersonId, salespersonId: spId };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const tenantId = user.tenantId;

    // ---- GET: role-scoped list -------------------------------------------
    if (req.method === "GET") {
      let sql = `SELECT * FROM clients WHERE tenant_id = $1`;
      const params: any[] = [tenantId];
      if (user.role === "sales_manager") {
        sql += ` AND salesperson_id IN (SELECT id FROM salespeople WHERE tenant_id = $1 AND manager_user_id = $2)`;
        params.push(user.id);
      } else if (SELF_ROLES.includes(user.role)) {
        sql += ` AND salesperson_id = $2`;
        params.push(user.salespersonId ?? "__none__");
      }
      sql += ` ORDER BY created_at DESC`;
      const { rows } = await query<any>(sql, params);
      return res.status(200).json({ clients: rows });
    }

    // ---- POST: create ONE client -----------------------------------------
    if (req.method === "POST") {
      if (!csrfOk(req)) return res.status(403).json({ error: "csrf_check_failed" });
      if (!["owner", "admin", "sales_manager", ...SELF_ROLES].includes(user.role)) {
        return res.status(403).json({ error: "forbidden" });
      }
      const parsed = normalizeClientInput(parse(req), todayISO());
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const v = parsed.value;

      const sp = await resolveSalesperson(user, v.salespersonId);
      if (!sp.ok) return res.status(sp.status).json({ error: sp.error });

      const id = uid("cl");
      const ts = nowISO();
      await withTransaction(async (c) => {
        await c.query(
          `INSERT INTO clients
             (id, tenant_id, salesperson_id, company_name, contact_name, email, phone, signup_date,
              setup_fee_amount, monthly_subscription_amount, status, canceled_date, notes, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
          [id, tenantId, sp.id, v.companyName, v.contactName, v.email, v.phone, v.signupDate,
           v.setupFee, v.monthlySubscription, v.status, v.canceledDate, v.notes, ts],
        );
        // A brand-new client has no payments yet, but recomputing is what keeps
        // "the ledger always reflects the current rows" true without exception.
        await recomputeClientInTx(c, tenantId, id);
      });
      return res.status(201).json({ ok: true, id });
    }

    // ---- PATCH: update ONE client + recompute ----------------------------
    if (req.method === "PATCH") {
      if (!csrfOk(req)) return res.status(403).json({ error: "csrf_check_failed" });
      const id = String(req.query.id ?? "");
      if (!id) return res.status(400).json({ error: "id_required" });

      const scope = await clientInScope(user, id);
      if (!scope.found) return res.status(404).json({ error: "not_found" });
      if (!scope.inScope) return res.status(403).json({ error: "forbidden" });

      const built = buildClientUpdate(parse(req), todayISO());
      if (!built.ok) return res.status(400).json({ error: built.error });

      // Reassignment is an owner/admin/manager action, and the destination rep
      // must be in the caller's scope.
      if (built.value.reassignedTo !== undefined) {
        if (SELF_ROLES.includes(user.role)) {
          return res.status(403).json({ error: "cannot_reassign" });
        }
        const sp = await resolveSalesperson(user, built.value.reassignedTo);
        if (!sp.ok) return res.status(sp.status).json({ error: sp.error });
        built.value.set.salesperson_id = sp.id;
      }

      await withTransaction(async (c) => {
        const set = built.value.set;
        const cols = Object.keys(set);
        const setSql = cols.map((col, i) => `${col} = $${i + 3}`).join(", ");
        await c.query(
          `UPDATE clients SET ${setSql} WHERE id = $1 AND tenant_id = $2`,
          [id, tenantId, ...cols.map((col) => set[col])],
        );
        // Keep the denormalized salesperson on the client's payments in step,
        // so the ledger and the payment history never disagree about whose
        // client this is.
        if (built.value.reassignedTo !== undefined) {
          await c.query(
            `UPDATE payments SET salesperson_id = $3, updated_at = $4
              WHERE tenant_id = $1 AND client_id = $2`,
            [tenantId, id, set.salesperson_id ?? null, nowISO()],
          );
        }
        if (built.value.commissionAffecting.length > 0) {
          await recomputeClientInTx(c, tenantId, id);
        }
      });
      return res.status(200).json({ ok: true, id });
    }

    // ---- DELETE: blocked while locked commissions exist -------------------
    if (req.method === "DELETE") {
      if (!csrfOk(req)) return res.status(403).json({ error: "csrf_check_failed" });
      if (!["owner", "admin"].includes(user.role)) {
        return res.status(403).json({ error: "forbidden" });
      }
      const id = String(req.query.id ?? "");
      if (!id) return res.status(400).json({ error: "id_required" });

      const scope = await clientInScope(user, id);
      if (!scope.found) return res.status(404).json({ error: "not_found" });

      const { rows: locked } = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM commission_ledger
          WHERE tenant_id = $1 AND client_id = $2 AND status = ANY($3::text[])`,
        [tenantId, id, LOCKED_STATUSES],
      );
      if (Number(locked[0]?.n ?? 0) > 0) {
        return res.status(409).json({
          error: "has_locked_commissions",
          hint: "This client has commissions in a payout batch. Cancel or complete the payout first.",
        });
      }

      await withTransaction(async (c) => {
        await c.query(`DELETE FROM commission_ledger WHERE tenant_id = $1 AND client_id = $2`, [tenantId, id]);
        await c.query(`DELETE FROM payments WHERE tenant_id = $1 AND client_id = $2`, [tenantId, id]);
        await c.query(`DELETE FROM clients WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      });
      return res.status(200).json({ ok: true, id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("[scm:error] clients:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return res.status(500).json({ error: "internal_error" });
  }
}
