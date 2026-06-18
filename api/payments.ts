// /api/payments
//   GET            -> payments visible to the user (role-scoped via the client)
//   POST           -> add a payment + recompute its client's ledger
//   PATCH ?id=...  -> edit a payment + recompute (blocked if it would corrupt
//                     locked commissions)
//   DELETE ?id=... -> delete/cancel a payment + recompute (blocked when the
//                     payment has locked commissions -> "has_locked_commissions")
//
// Real per-resource database APIs that replace the payments portion of the
// snapshot PUT /api/state. A payment is always tied to a client; its
// salesperson is DERIVED from that client (never trusted from the body). After
// any mutation the server recomputes the client's commission ledger so the
// ledger is authoritative and survives reload — and so a payment write is never
// a "lazy" row insert that leaves the ledger wrong.
//
// Tenant comes from the session; every statement is tenant-scoped. Mutations
// are additionally scoped to the actor's visible salespeople (mirrors
// api/clients.ts): owner/admin = all, sales_manager = their team, self-roles =
// their own clients.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query, withTransaction } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser, type SessionUser } from "./_lib/auth.js";
import {
  canManagePayments,
  commissionReadScope,
  normalizePaymentInput,
  buildPaymentUpdate,
  uid,
} from "./_lib/commission-handlers.js";
import {
  recomputeClientInTx,
  paymentHasLockedCommissions,
} from "./_lib/recompute.js";

const nowISO = () => new Date().toISOString();

/** Resolve whether a client is within the actor's scope (and its salesperson). */
async function clientScope(
  user: SessionUser,
  clientId: string,
): Promise<{ found: boolean; inScope: boolean; salespersonId: string | null }> {
  const { rows } = await query<any>(
    `SELECT id, salesperson_id FROM clients WHERE tenant_id = $1 AND id = $2`,
    [user.tenantId, clientId],
  );
  const c = rows[0];
  if (!c) return { found: false, inScope: false, salespersonId: null };
  const salespersonId: string | null = c.salesperson_id ?? null;

  const scope = commissionReadScope(user.role);
  if (scope === "all") return { found: true, inScope: true, salespersonId };
  if (scope === "self") {
    return { found: true, inScope: !!salespersonId && salespersonId === user.salespersonId, salespersonId };
  }
  // team: the client's salesperson must report to this manager
  if (!salespersonId) return { found: true, inScope: false, salespersonId };
  const { rows: team } = await query<{ id: string }>(
    `SELECT id FROM salespeople WHERE tenant_id = $1 AND id = $2 AND manager_user_id = $3`,
    [user.tenantId, salespersonId, user.id],
  );
  return { found: true, inScope: team.length > 0, salespersonId };
}

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
      let sql = `SELECT p.* FROM payments p WHERE p.tenant_id = $1`;
      const params: any[] = [tenantId];
      const scope = commissionReadScope(user.role);
      if (scope === "team") {
        sql += ` AND p.client_id IN (SELECT id FROM clients WHERE tenant_id = $1
                  AND salesperson_id IN (SELECT id FROM salespeople WHERE tenant_id = $1 AND manager_user_id = $2))`;
        params.push(user.id);
      } else if (scope === "self") {
        sql += ` AND p.client_id IN (SELECT id FROM clients WHERE tenant_id = $1 AND salesperson_id = $2)`;
        params.push(user.salespersonId ?? "__none__");
      }
      sql += ` ORDER BY p.payment_date DESC, p.created_at DESC`;
      const { rows } = await query<any>(sql, params);
      const payments = rows.map((p) => ({
        id: p.id,
        clientId: p.client_id,
        salespersonId: p.salesperson_id ?? null,
        date: p.payment_date ?? "",
        type: p.payment_type,
        amount: Number(p.amount),
        paymentNumber: p.payment_number === null ? null : Number(p.payment_number),
        notes: p.notes ?? "",
        createdAt: p.created_at || "",
      }));
      return res.status(200).json({ payments });
    }

    // ---- POST: create + recompute ---------------------------------------
    if (req.method === "POST") {
      if (!canManagePayments(user.role)) return res.status(403).json({ error: "forbidden" });
      const parsed = normalizePaymentInput(parse(req));
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const v = parsed.value;

      const sc = await clientScope(user, v.clientId);
      if (!sc.found) return res.status(400).json({ error: "invalid_client" });
      if (!sc.inScope) return res.status(403).json({ error: "client_not_in_scope" });

      const id = uid("pay");
      const ts = nowISO();
      await withTransaction(async (c) => {
        await c.query(
          `INSERT INTO payments
             (id, tenant_id, client_id, salesperson_id, payment_date, payment_type, amount, payment_number,
              source, external_payment_id, notes, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [id, tenantId, v.clientId, sc.salespersonId, v.date, v.type, v.amount, v.paymentNumber,
           "manual", null, v.notes, ts, ts],
        );
        await recomputeClientInTx(c, tenantId, v.clientId);
      });
      return res.status(201).json({ ok: true, id });
    }

    // ---- PATCH: edit + recompute (guard locked commissions) -------------
    if (req.method === "PATCH") {
      if (!canManagePayments(user.role)) return res.status(403).json({ error: "forbidden" });
      const id = String(req.query.id ?? "");
      if (!id) return res.status(400).json({ error: "id_required" });

      const { rows } = await query<any>(
        `SELECT id, client_id FROM payments WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      const existing = rows[0];
      if (!existing) return res.status(404).json({ error: "not_found" });
      const oldClientId: string = existing.client_id;

      const sc = await clientScope(user, oldClientId);
      if (!sc.inScope) return res.status(403).json({ error: "forbidden" });

      const built = buildPaymentUpdate(parse(req));
      if (!built.ok) return res.status(400).json({ error: built.error });

      // Refuse a commission-affecting edit when locked commissions exist.
      if (built.value.commissionAffecting.length > 0) {
        if (await paymentHasLockedCommissions(tenantId, id)) {
          return res.status(409).json({ error: "has_locked_commissions" });
        }
      }

      // If the client is changing, the destination must also be in scope, and
      // its salesperson becomes the payment's salesperson.
      let newClientId: string | null = null;
      let newSalespersonId: string | null = null;
      if (built.value.set.client_id && built.value.set.client_id !== oldClientId) {
        newClientId = String(built.value.set.client_id);
        const dsc = await clientScope(user, newClientId);
        if (!dsc.found) return res.status(400).json({ error: "invalid_client" });
        if (!dsc.inScope) return res.status(403).json({ error: "client_not_in_scope" });
        newSalespersonId = dsc.salespersonId;
      }

      await withTransaction(async (c) => {
        const set = { ...built.value.set };
        if (newClientId) set.salesperson_id = newSalespersonId; // keep denormalized sp in sync
        const cols = Object.keys(set);
        const setSql = cols.map((col, i) => `${col} = $${i + 3}`).join(", ");
        const vals = cols.map((col) => set[col]);
        await c.query(
          `UPDATE payments SET ${setSql} WHERE id = $1 AND tenant_id = $2`,
          [id, tenantId, ...vals],
        );
        await recomputeClientInTx(c, tenantId, oldClientId);
        if (newClientId) await recomputeClientInTx(c, tenantId, newClientId);
      });
      return res.status(200).json({ ok: true, id });
    }

    // ---- DELETE: blocked when locked commissions exist ------------------
    if (req.method === "DELETE") {
      if (!canManagePayments(user.role)) return res.status(403).json({ error: "forbidden" });
      const id = String(req.query.id ?? "");
      if (!id) return res.status(400).json({ error: "id_required" });

      const { rows } = await query<any>(
        `SELECT id, client_id FROM payments WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      const existing = rows[0];
      if (!existing) return res.status(404).json({ error: "not_found" });
      const clientId: string = existing.client_id;

      const sc = await clientScope(user, clientId);
      if (!sc.inScope) return res.status(403).json({ error: "forbidden" });

      if (await paymentHasLockedCommissions(tenantId, id)) {
        return res.status(409).json({ error: "has_locked_commissions" });
      }

      await withTransaction(async (c) => {
        // Drop this payment's own ledger rows first (only non-locked remain at
        // this point), then the payment, then recompute the client.
        await c.query(
          `DELETE FROM commission_ledger WHERE tenant_id = $1 AND payment_id = $2`,
          [tenantId, id],
        );
        await c.query(`DELETE FROM payments WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
        await recomputeClientInTx(c, tenantId, clientId);
      });
      return res.status(200).json({ ok: true, id, deleted: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}

function parse(req: VercelRequest): Record<string, unknown> {
  const b = req.body;
  if (b == null) return {};
  if (typeof b === "string") {
    try { return JSON.parse(b || "{}"); } catch { return {}; }
  }
  return b as Record<string, unknown>;
}
