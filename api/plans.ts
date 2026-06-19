// /api/plans
//   GET                         -> the tenant's commission plans (with rules)
//   POST                        -> create a plan                       (owner/admin)
//   POST ?action=duplicate&id=  -> duplicate a plan + its rules        (owner/admin)
//   POST ?action=reorder        -> set plan sort order {orderedIds}    (owner/admin)
//   PUT  ?id=                   -> replace a plan's fields + ALL rules  (owner/admin)
//   DELETE ?id=                 -> delete (default) or ?deactivate=1    (owner/admin)
//
// Real per-resource database APIs that replace the plans portion of the snapshot
// PUT /api/state. The PUT replaces the plan's editable fields, its full ordered
// rules array (covering add/edit/delete/reorder rules and the setup-fee /
// signup-bonus / monthly-residual / salary rule saves) and its timing / hold /
// release / clawback settings in ONE transaction — then recomputes the ledger
// for every client whose salesperson is on the plan, so a rate change flows
// through to commissions immediately. Locked payout rows are preserved.
//
// Every statement is scoped by tenant_id (from the session, never the client).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query, withTransaction } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser } from "./_lib/auth.js";
import {
  canManagePlans,
  normalizePlanInput,
  normalizeOrderedIds,
  uid,
} from "./_lib/commission-handlers.js";
import { recomputePlanInTx, recomputeClientInTx } from "./_lib/recompute.js";
import type { Rule } from "../src/types/index.js";

const nowISO = () => new Date().toISOString();

/** Map a Rule to the typed commission_rules columns (mirrors repository.ts). */
function ruleColumns(rule: Rule) {
  switch (rule.type) {
    case "setup_fee":
      return { calc: rule.mode, value: rule.value, startMonth: null, endMonth: null, forever: false, weekly: null, salStart: null, salEnd: null, maxWeeks: null };
    case "signup_bonus":
      return { calc: "fixed", value: rule.amount, startMonth: null, endMonth: null, forever: false, weekly: null, salStart: null, salEnd: null, maxWeeks: null };
    case "monthly_residual":
      return { calc: rule.valueType, value: rule.value, startMonth: rule.startMonth, endMonth: rule.endMonth, forever: rule.continueForever, weekly: null, salStart: null, salEnd: null, maxWeeks: null };
    case "salary":
      return { calc: "fixed", value: 0, startMonth: null, endMonth: null, forever: false, weekly: rule.weeklyAmount, salStart: rule.startDate, salEnd: rule.endDate, maxWeeks: rule.maxWeeks };
  }
}

async function insertRule(
  c: any,
  tenantId: string,
  planId: string,
  rule: Rule,
  sortOrder: number,
  ts: string,
): Promise<void> {
  const col = ruleColumns(rule);
  await c.query(
    `INSERT INTO commission_rules
       (id, tenant_id, commission_plan_id, rule_type, calculation_type, value, start_month, end_month,
        continues_forever, weekly_salary_amount, salary_start_date, salary_end_date, max_weeks,
        sort_order, is_active, metadata, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)`,
    [rule.id, tenantId, planId, rule.type, col.calc, col.value, col.startMonth, col.endMonth, col.forever,
     col.weekly, col.salStart, col.salEnd, col.maxWeeks, sortOrder, true, JSON.stringify(rule), ts, ts],
  );
}

/** Next sort_order for a tenant's plans. */
async function nextSort(tenantId: string): Promise<number> {
  const { rows } = await query<{ m: number | null }>(
    `SELECT max(sort_order) AS m FROM commission_plans WHERE tenant_id = $1`,
    [tenantId],
  );
  return (rows[0]?.m ?? -1) + 1;
}

/** Read all plans (with rules) for a tenant — same shape readState produces. */
async function listPlans(tenantId: string) {
  const [{ rows: planRows }, { rows: ruleRows }] = await Promise.all([
    query<any>(`SELECT * FROM commission_plans WHERE tenant_id = $1 ORDER BY sort_order ASC, created_at ASC`, [tenantId]),
    query<any>(`SELECT * FROM commission_rules WHERE tenant_id = $1 ORDER BY commission_plan_id, sort_order ASC`, [tenantId]),
  ]);
  const rulesByPlan = new Map<string, Rule[]>();
  for (const r of ruleRows) {
    const list = rulesByPlan.get(r.commission_plan_id) ?? [];
    list.push(r.metadata as Rule);
    rulesByPlan.set(r.commission_plan_id, list);
  }
  return planRows.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description ?? "",
    status: p.status,
    rules: rulesByPlan.get(p.id) ?? [],
    sampleSetupFee: Number(p.sample_setup_fee),
    sampleMonthly: Number(p.sample_monthly),
    timing: p.timing ?? undefined,
    createdAt: p.created_at || "",
  }));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const tenantId = user.tenantId;

    // ---- GET: list plans (non-sensitive config; any authenticated user) ----
    if (req.method === "GET") {
      const plans = await listPlans(tenantId);
      return res.status(200).json({ plans });
    }

    if (req.method === "POST") {
      if (!canManagePlans(user.role)) return res.status(403).json({ error: "forbidden" });
      const action = String(req.query.action ?? "");

      // ---- duplicate ------------------------------------------------------
      if (action === "duplicate") {
        const srcId = String(req.query.id ?? "");
        if (!srcId) return res.status(400).json({ error: "id_required" });
        const newId = await withTransaction(async (c) => {
          const { rows: planRows } = await c.query<any>(
            `SELECT * FROM commission_plans WHERE tenant_id = $1 AND id = $2`,
            [tenantId, srcId],
          );
          const src = planRows[0];
          if (!src) return null;
          const { rows: ruleRows } = await c.query<any>(
            `SELECT * FROM commission_rules WHERE tenant_id = $1 AND commission_plan_id = $2 ORDER BY sort_order ASC`,
            [tenantId, srcId],
          );
          const id = uid("plan");
          const ts = nowISO();
          const sort = (await nextSort(tenantId));
          await c.query(
            `INSERT INTO commission_plans
               (id, tenant_id, name, description, status, sort_order, sample_setup_fee, sample_monthly, timing, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
            [id, tenantId, `${src.name} (copy)`, src.description ?? "", "active", sort,
             Number(src.sample_setup_fee), Number(src.sample_monthly),
             src.timing ? JSON.stringify(src.timing) : null, ts, ts],
          );
          for (let i = 0; i < ruleRows.length; i++) {
            const rule = { ...(ruleRows[i].metadata as Rule), id: uid("rule") };
            await insertRule(c, tenantId, id, rule, i, ts);
          }
          return id;
        });
        if (!newId) return res.status(404).json({ error: "not_found" });
        return res.status(201).json({ ok: true, id: newId });
      }

      // ---- reorder --------------------------------------------------------
      if (action === "reorder") {
        const body = parse(req);
        const parsed = normalizeOrderedIds(body);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        await withTransaction(async (c) => {
          for (let i = 0; i < parsed.value.length; i++) {
            await c.query(
              `UPDATE commission_plans SET sort_order = $1, updated_at = $2 WHERE tenant_id = $3 AND id = $4`,
              [i, nowISO(), tenantId, parsed.value[i]],
            );
          }
        });
        return res.status(200).json({ ok: true });
      }

      // ---- create ---------------------------------------------------------
      const parsed = normalizePlanInput(parse(req), { requireRules: false });
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const v = parsed.value;
      const id = uid("plan");
      const ts = nowISO();
      const sort = await nextSort(tenantId);
      await withTransaction(async (c) => {
        await c.query(
          `INSERT INTO commission_plans
             (id, tenant_id, name, description, status, sort_order, sample_setup_fee, sample_monthly, timing, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
          [id, tenantId, v.name, v.description, "active", sort, v.sampleSetupFee, v.sampleMonthly,
           v.timing ? JSON.stringify(v.timing) : null, ts, ts],
        );
        const rules = v.rules ?? [];
        for (let i = 0; i < rules.length; i++) await insertRule(c, tenantId, id, rules[i], i, ts);
      });
      return res.status(201).json({ ok: true, id });
    }

    // ---- PUT: replace a plan's fields + full rules array, then recompute ---
    if (req.method === "PUT") {
      if (!canManagePlans(user.role)) return res.status(403).json({ error: "forbidden" });
      const id = String(req.query.id ?? "");
      if (!id) return res.status(400).json({ error: "id_required" });
      const parsed = normalizePlanInput(parse(req), { requireRules: true });
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const v = parsed.value;

      const updated = await withTransaction(async (c) => {
        const { rowCount } = await c.query(
          `UPDATE commission_plans
              SET name = $1, description = $2, sample_setup_fee = $3, sample_monthly = $4,
                  timing = $5::jsonb, updated_at = $6
            WHERE tenant_id = $7 AND id = $8`,
          [v.name, v.description, v.sampleSetupFee, v.sampleMonthly,
           v.timing ? JSON.stringify(v.timing) : null, nowISO(), tenantId, id],
        );
        if (rowCount === 0) return false;
        // Replace the rule set wholesale (covers add/edit/delete/reorder).
        await c.query(`DELETE FROM commission_rules WHERE tenant_id = $1 AND commission_plan_id = $2`, [tenantId, id]);
        const rules = v.rules ?? [];
        const ts = nowISO();
        for (let i = 0; i < rules.length; i++) await insertRule(c, tenantId, id, rules[i], i, ts);
        // Recompute the ledger for everyone on this plan.
        await recomputePlanInTx(c, tenantId, id);
        return true;
      });
      if (!updated) return res.status(404).json({ error: "not_found" });
      return res.status(200).json({ ok: true, id });
    }

    // ---- DELETE: deactivate (?deactivate=1) or hard delete + unassign ------
    if (req.method === "DELETE") {
      if (!canManagePlans(user.role)) return res.status(403).json({ error: "forbidden" });
      const id = String(req.query.id ?? "");
      if (!id) return res.status(400).json({ error: "id_required" });

      if (String(req.query.deactivate ?? "") === "1") {
        const { rowCount } = await query(
          `UPDATE commission_plans SET status = 'inactive', updated_at = $1 WHERE tenant_id = $2 AND id = $3`,
          [nowISO(), tenantId, id],
        );
        if (rowCount === 0) return res.status(404).json({ error: "not_found" });
        return res.status(200).json({ ok: true, id, deactivated: true });
      }

      const ok = await withTransaction(async (c) => {
        const { rows: exists } = await c.query(`SELECT id FROM commission_plans WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
        if (exists.length === 0) return false;
        // Capture affected clients BEFORE unassigning (the recompute will then
        // remove their now-unbacked, non-locked commissions).
        const { rows: clientRows } = await c.query<{ id: string }>(
          `SELECT cl.id FROM clients cl
             JOIN salespeople sp ON sp.id = cl.salesperson_id AND sp.tenant_id = cl.tenant_id
            WHERE cl.tenant_id = $1 AND sp.commission_plan_id = $2`,
          [tenantId, id],
        );
        await c.query(
          `UPDATE salespeople SET commission_plan_id = NULL, updated_at = $1 WHERE tenant_id = $2 AND commission_plan_id = $3`,
          [nowISO(), tenantId, id],
        );
        await c.query(`DELETE FROM commission_plans WHERE tenant_id = $1 AND id = $2`, [tenantId, id]); // rules cascade
        for (const r of clientRows) await recomputeClientInTx(c, tenantId, r.id);
        return true;
      });
      if (!ok) return res.status(404).json({ error: "not_found" });
      return res.status(200).json({ ok: true, id, deleted: true });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}

/** Body parse (string or pre-parsed object). */
function parse(req: VercelRequest): Record<string, unknown> {
  const b = req.body;
  if (b == null) return {};
  if (typeof b === "string") {
    try { return JSON.parse(b || "{}"); } catch { return {}; }
  }
  return b as Record<string, unknown>;
}
