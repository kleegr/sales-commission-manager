// /api/ledger
//   GET                       -> commission ledger rows visible to the user,
//                                filterable by salesperson / client / status /
//                                date range; each row enriched with derived
//                                timing (release date, hold / clawback reason)
//                                so the response is export-ready.
//   POST ?action=release      -> release held commissions {ids} + recompute  (owner/admin)
//   POST ?action=recompute    -> recompute the whole tenant's ledger          (owner/admin)
//
// The ledger is the authoritative, tenant- and role-scoped commission record.
// Reads are scoped exactly like the rest of the app (owner/admin = all,
// sales_manager = team, self-roles = own). Releasing sets the sticky
// released_override flag and recomputes, so a held line moves to pending and
// stays released across future recomputes. Locked payout rows are never
// re-priced. Tenant comes from the session, never the client.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query, withTransaction } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser, type SessionUser } from "./_lib/auth.js";
import {
  canReleaseCommission,
  canRecomputeLedger,
  commissionReadScope,
  parseLedgerFilters,
  normalizeIdList,
  type LedgerFilters,
} from "./_lib/commission-handlers.js";
import {
  recomputeClientInTx,
  recomputeTenantInTx,
  isManual,
  LOCKED_STATUSES,
} from "./_lib/recompute.js";
import { normalizeTiming, resolveCommissionTiming } from "../src/lib/commission-timing.js";
import { todayISO } from "../src/lib/format.js";
import type { CommissionStatus } from "../src/types/index.js";

/** Build the tenant-scoped WHERE for the GET, honoring the actor's read scope. */
function scopeClause(user: SessionUser, startIdx: number): { sql: string; params: any[] } {
  const scope = commissionReadScope(user.role);
  if (scope === "all") return { sql: "", params: [] };
  if (scope === "team") {
    return {
      sql: ` AND l.salesperson_id IN (SELECT id FROM salespeople WHERE tenant_id = $1 AND manager_user_id = $${startIdx})`,
      params: [user.id],
    };
  }
  return { sql: ` AND l.salesperson_id = $${startIdx}`, params: [user.salespersonId ?? "__none__"] };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const tenantId = user.tenantId;

    // ---- GET: filtered, role-scoped, enriched ---------------------------
    if (req.method === "GET") {
      const f: LedgerFilters = parseLedgerFilters(req.query as Record<string, unknown>);

      let sql = `SELECT l.* FROM commission_ledger l WHERE l.tenant_id = $1`;
      const params: any[] = [tenantId];
      const scope = scopeClause(user, params.length + 1);
      sql += scope.sql;
      params.push(...scope.params);
      if (f.salespersonId) { params.push(f.salespersonId); sql += ` AND l.salesperson_id = $${params.length}`; }
      if (f.clientId) { params.push(f.clientId); sql += ` AND l.client_id = $${params.length}`; }
      if (f.from) { params.push(f.from); sql += ` AND l.payment_date >= $${params.length}`; }
      if (f.to) { params.push(f.to); sql += ` AND l.payment_date <= $${params.length}`; }
      sql += ` ORDER BY l.due_date DESC`;

      const { rows } = await query<any>(sql, params);

      // Maps needed to re-derive timing per row (mirrors client stampTiming).
      const [{ rows: spRows }, { rows: planRows }, { rows: clientRows }, { rows: countRows }] =
        await Promise.all([
          query<any>(`SELECT id, commission_plan_id FROM salespeople WHERE tenant_id = $1`, [tenantId]),
          query<any>(`SELECT id, timing FROM commission_plans WHERE tenant_id = $1`, [tenantId]),
          query<any>(`SELECT id, status, signup_date, canceled_date FROM clients WHERE tenant_id = $1`, [tenantId]),
          query<any>(
            `SELECT client_id, count(*)::int AS n FROM payments
              WHERE tenant_id = $1 AND payment_type = 'monthly_subscription' AND payment_date <= $2
              GROUP BY client_id`,
            [tenantId, todayISO()],
          ),
        ]);
      const planBySp = new Map(spRows.map((r) => [r.id, r.commission_plan_id]));
      const timingByPlan = new Map(planRows.map((r) => [r.id, r.timing]));
      const clientById = new Map(clientRows.map((r) => [r.id, r]));
      const payCount = new Map(countRows.map((r) => [r.client_id, Number(r.n)]));
      const today = todayISO();

      const enriched = rows.map((e) => {
        const base = {
          id: e.id,
          salespersonId: e.salesperson_id,
          clientId: e.client_id ?? null,
          paymentId: e.payment_id ?? null,
          paymentDate: e.payment_date ?? "",
          paymentType: e.payment_type,
          paymentAmount: Number(e.payment_amount),
          ruleId: e.commission_rule_id ?? null,
          ruleType: e.rule_type,
          ruleLabel: e.commission_rule_used ?? "",
          commissionValueType: e.commission_type,
          commissionValue: Number(e.commission_value),
          commissionAmount: Number(e.commission_amount),
          status: e.status as CommissionStatus,
          dueDate: e.due_date ?? "",
          paidDate: e.paid_date ?? null,
          releasedOverride: !!e.released_override,
          payoutBatchId: e.payout_batch_id ?? null,
          isProjection: !!e.is_projection,
          notes: e.notes ?? "",
          releaseDate: null as string | null,
          holdReason: "",
          clawbackReason: null as string | null,
          earnedDate: e.payment_date ?? "",
          timingTrigger: null as string | null,
        };

        // Salary / non-payment rows carry no payment timing.
        if (!base.paymentId || base.paymentType === "salary") return base;

        const planId = planBySp.get(base.salespersonId) ?? null;
        const timing = normalizeTiming(planId ? timingByPlan.get(planId) : null);
        const client = base.clientId ? clientById.get(base.clientId) : null;
        const r = resolveCommissionTiming({
          timing,
          earnedDate: base.paymentDate,
          asOf: today,
          clientStatus: client?.status ?? null,
          clientSignupDate: client?.signup_date ?? null,
          clientCanceledDate: client?.canceled_date ?? null,
          clientPaymentCount: base.clientId ? payCount.get(base.clientId) ?? 0 : 0,
          releasedOverride: base.releasedOverride,
        });
        base.releaseDate = r.releaseDate;
        base.holdReason = r.reason;
        base.clawbackReason = r.clawbackReason;
        base.earnedDate = r.earnedDate;
        base.timingTrigger = r.trigger;
        // A human-set workflow label stays authoritative; otherwise timing owns it.
        if (!isManual(base.status)) base.status = r.status;
        return base;
      });

      const filtered = f.status ? enriched.filter((e) => e.status === f.status) : enriched;
      return res.status(200).json({ entries: filtered });
    }

    if (req.method === "POST") {
      const action = String(req.query.action ?? "");

      // ---- release held commissions --------------------------------------
      if (action === "release") {
        if (!canReleaseCommission(user.role)) return res.status(403).json({ error: "forbidden" });
        const parsed = normalizeIdList(parse(req));
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });

        const result = await withTransaction(async (c) => {
          // Only release rows that belong to this tenant and are not locked.
          const { rows } = await c.query<any>(
            `SELECT id, client_id FROM commission_ledger
              WHERE tenant_id = $1 AND id = ANY($2::text[])
                AND payment_id IS NOT NULL AND status <> ALL($3::text[])`,
            [tenantId, parsed.value, LOCKED_STATUSES],
          );
          if (rows.length === 0) return { released: 0 };
          const ids = rows.map((r) => r.id);
          await c.query(
            `UPDATE commission_ledger SET released_override = true, updated_at = $1
              WHERE tenant_id = $2 AND id = ANY($3::text[])`,
            [new Date().toISOString(), tenantId, ids],
          );
          const clientIds = Array.from(new Set(rows.map((r) => r.client_id).filter(Boolean)));
          for (const cid of clientIds) await recomputeClientInTx(c, tenantId, cid as string);
          return { released: ids.length };
        });
        return res.status(200).json({ ok: true, ...result });
      }

      // ---- recompute the whole tenant ------------------------------------
      if (action === "recompute") {
        if (!canRecomputeLedger(user.role)) return res.status(403).json({ error: "forbidden" });
        const result = await withTransaction((c) => recomputeTenantInTx(c, tenantId));
        return res.status(200).json({ ok: true, ...result });
      }

      return res.status(400).json({ error: "unknown_action" });
    }

    res.setHeader("Allow", "GET, POST");
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
