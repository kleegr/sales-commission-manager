// /api/goals — sales goals + motivational milestones (server-owned).
//
//   GET                              -> { goals, milestones } scoped to the role,
//                                       each goal carrying a computed `actual`.
//   POST                             -> create a goal              (owner/admin/manager)
//   PATCH  ?id=...                   -> update a goal              (owner/admin/manager)
//   DELETE ?id=...                   -> delete a goal (+milestones)(owner/admin/manager)
//   POST   ?resource=milestone       -> create a milestone on a goal
//   DELETE ?resource=milestone&id=.. -> delete a milestone
//
// SECURITY: tenant comes from the session, never the client. A sales_manager may
// only target their OWN team / reps; tenant-wide goals are owner/admin only.
// Progress (`actual`) is computed server-side from real data via the SAME pure
// helpers the portal uses (src/lib/goals.ts), so it can never be spoofed and is
// defined in exactly one place. These rows are excluded from the snapshot save.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty, readState } from "./_lib/repository.js";
import { getSessionUser, type SessionUser } from "./_lib/auth.js";
import {
  parseBody,
  uid,
  canManageGoals,
  normalizeGoalInput,
  normalizeMilestoneInput,
  type GoalInput,
} from "./_lib/handlers.js";
import { metricActual, resolveGoalPeriod } from "../src/lib/goals.js";
import type { Goal, Milestone } from "../src/types/index.js";

const nowISO = () => new Date().toISOString();

function rowToGoal(r: any): Goal {
  return {
    id: r.id,
    scopeType: r.scope_type,
    salespersonId: r.salesperson_id ?? null,
    managerUserId: r.manager_user_id ?? null,
    metric: r.metric,
    title: r.title ?? "",
    targetValue: Number(r.target_value),
    period: r.period,
    periodStart: r.period_start ?? null,
    periodEnd: r.period_end ?? null,
    status: r.status,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : "",
  };
}

function rowToMilestone(r: any): Milestone {
  return {
    id: r.id,
    goalId: r.goal_id,
    title: r.title ?? "",
    thresholdValue: Number(r.threshold_value),
    reward: r.reward ?? "",
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : "",
  };
}

/**
 * Enforce who a goal may target. Returns the (possibly adjusted) input or an
 * error. Managers are pinned to their own team/reps; tenant scope is admin-only.
 */
async function guardScope(user: SessionUser, input: GoalInput): Promise<{ ok: true; value: GoalInput } | { ok: false; error: string }> {
  const isAdmin = user.role === "owner" || user.role === "admin";

  if (input.scopeType === "tenant") {
    if (!isAdmin) return { ok: false, error: "tenant_scope_admin_only" };
    return { ok: true, value: { ...input, salespersonId: null, managerUserId: null } };
  }

  if (input.scopeType === "team") {
    // A manager can only create a goal for their OWN team; admins must name one.
    const managerUserId = isAdmin ? input.managerUserId : user.id;
    if (!managerUserId) return { ok: false, error: "manager_required" };
    return { ok: true, value: { ...input, managerUserId, salespersonId: null } };
  }

  // salesperson scope — verify the rep is in this tenant (and the manager's team)
  const { rows } = await query<any>(
    `SELECT manager_user_id FROM salespeople WHERE tenant_id = $1 AND id = $2`,
    [user.tenantId, input.salespersonId],
  );
  if (rows.length === 0) return { ok: false, error: "invalid_salesperson" };
  if (!isAdmin && rows[0].manager_user_id !== user.id) {
    return { ok: false, error: "salesperson_not_on_team" };
  }
  return { ok: true, value: { ...input, managerUserId: null } };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const tenantId = user.tenantId;
    const isManager = user.role === "sales_manager";
    const isSelf = ["salesperson", "affiliate", "partner"].includes(user.role);
    const resource = String(req.query.resource ?? "");

    // ===================== GET =============================================
    if (req.method === "GET") {
      let sql = `SELECT * FROM goals WHERE tenant_id = $1 AND status = 'active'`;
      const params: any[] = [tenantId];
      if (isManager) {
        sql += ` AND (scope_type = 'tenant'
                   OR (scope_type = 'team' AND manager_user_id = $2)
                   OR (scope_type = 'salesperson' AND salesperson_id IN
                        (SELECT id FROM salespeople WHERE tenant_id = $1 AND manager_user_id = $2)))`;
        params.push(user.id);
      } else if (isSelf) {
        sql += ` AND (scope_type = 'tenant' OR (scope_type = 'salesperson' AND salesperson_id = $2))`;
        params.push(user.salespersonId ?? "__none__");
      }
      sql += ` ORDER BY created_at DESC`;
      const goalRows = (await query<any>(sql, params)).rows;
      const goals = goalRows.map(rowToGoal);

      const goalIds = goals.map((g) => g.id);
      const milestones: Milestone[] = goalIds.length
        ? (await query<any>(`SELECT * FROM milestones WHERE tenant_id = $1 AND goal_id = ANY($2) ORDER BY threshold_value ASC`, [tenantId, goalIds])).rows.map(rowToMilestone)
        : [];

      // Compute each goal's actual from real data (one tenant read + a team map).
      const today = nowISO().slice(0, 10);
      const full = await readState(tenantId);
      const memberRows = (await query<any>(`SELECT id, manager_user_id FROM salespeople WHERE tenant_id = $1`, [tenantId])).rows;
      const managerMembers = new Map<string, Set<string>>();
      for (const m of memberRows) {
        if (!m.manager_user_id) continue;
        const set = managerMembers.get(m.manager_user_id) ?? new Set<string>();
        set.add(m.id);
        managerMembers.set(m.manager_user_id, set);
      }
      const scopeIds = (g: Goal): Set<string> | null => {
        if (g.scopeType === "tenant") return null;
        if (g.scopeType === "team") return managerMembers.get(g.managerUserId ?? "") ?? new Set<string>();
        return new Set(g.salespersonId ? [g.salespersonId] : []);
      };
      const withActual = goals.map((g) => ({ ...g, actual: metricActual(g.metric, full, scopeIds(g), resolveGoalPeriod(g, today)) }));

      return res.status(200).json({ goals: withActual, milestones });
    }

    // All mutations require management rights.
    if (["POST", "PATCH", "DELETE"].includes(req.method ?? "") && !canManageGoals(user.role)) {
      return res.status(403).json({ error: "forbidden" });
    }

    // ===================== milestones =====================================
    if (resource === "milestone") {
      if (req.method === "POST") {
        const parsed = normalizeMilestoneInput(parseBody(req));
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        // The goal must be in this tenant; a manager must own/scope it.
        const { rows } = await query<any>(`SELECT * FROM goals WHERE tenant_id = $1 AND id = $2`, [tenantId, parsed.value.goalId]);
        if (rows.length === 0) return res.status(400).json({ error: "invalid_goal" });
        const g = rowToGoal(rows[0]);
        if (isManager && !(g.scopeType === "team" && g.managerUserId === user.id) &&
            !(g.scopeType === "salesperson")) {
          // managers may only attach to their team/rep goals (tenant goals are admin's)
          if (g.scopeType === "tenant") return res.status(403).json({ error: "forbidden" });
        }
        const id = uid("ms");
        await query(
          `INSERT INTO milestones (id, tenant_id, goal_id, title, threshold_value, reward, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,0)`,
          [id, tenantId, parsed.value.goalId, parsed.value.title, parsed.value.thresholdValue, parsed.value.reward],
        );
        return res.status(201).json({ ok: true, id });
      }
      if (req.method === "DELETE") {
        const id = String(req.query.id ?? "");
        if (!id) return res.status(400).json({ error: "id_required" });
        const { rowCount } = await query(`DELETE FROM milestones WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
        if (rowCount === 0) return res.status(404).json({ error: "not_found" });
        return res.status(200).json({ ok: true, id });
      }
      res.setHeader("Allow", "POST, DELETE");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    // ===================== goals ==========================================
    if (req.method === "POST") {
      const parsed = normalizeGoalInput(parseBody(req));
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const guarded = await guardScope(user, parsed.value);
      if (!guarded.ok) return res.status(403).json({ error: guarded.error });
      const g = guarded.value;
      const id = uid("goal");
      const ts = nowISO();
      await query(
        `INSERT INTO goals
           (id, tenant_id, scope_type, salesperson_id, manager_user_id, metric, title, target_value,
            period, period_start, period_end, status, created_by_user_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13,$13)`,
        [id, tenantId, g.scopeType, g.salespersonId, g.managerUserId, g.metric, g.title, g.targetValue,
         g.period, g.periodStart, g.periodEnd, user.id, ts],
      );
      return res.status(201).json({ ok: true, id });
    }

    if (req.method === "PATCH") {
      const id = String(req.query.id ?? "");
      if (!id) return res.status(400).json({ error: "id_required" });
      const { rows } = await query<any>(`SELECT * FROM goals WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      if (rows.length === 0) return res.status(404).json({ error: "not_found" });
      // A manager may only edit goals they could have created.
      if (isManager) {
        const cur = rowToGoal(rows[0]);
        const ownsTeam = cur.scopeType === "team" && cur.managerUserId === user.id;
        const ownsRep = cur.scopeType === "salesperson"; // re-validated in guardScope below
        if (cur.scopeType === "tenant" || (!ownsTeam && !ownsRep)) {
          return res.status(403).json({ error: "forbidden" });
        }
      }
      const parsed = normalizeGoalInput(parseBody(req));
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const guarded = await guardScope(user, parsed.value);
      if (!guarded.ok) return res.status(403).json({ error: guarded.error });
      const g = guarded.value;
      await query(
        `UPDATE goals SET scope_type = $3, salesperson_id = $4, manager_user_id = $5, metric = $6,
            title = $7, target_value = $8, period = $9, period_start = $10, period_end = $11, updated_at = $12
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id, g.scopeType, g.salespersonId, g.managerUserId, g.metric, g.title, g.targetValue,
         g.period, g.periodStart, g.periodEnd, nowISO()],
      );
      return res.status(200).json({ ok: true, id });
    }

    if (req.method === "DELETE") {
      const id = String(req.query.id ?? "");
      if (!id) return res.status(400).json({ error: "id_required" });
      // CASCADE on milestones removes the goal's milestones.
      const { rowCount } = await query(`DELETE FROM goals WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      if (rowCount === 0) return res.status(404).json({ error: "not_found" });
      return res.status(200).json({ ok: true, id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
