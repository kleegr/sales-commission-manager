// /api/payouts
//   GET                        -> payouts visible to the current user + history
//   GET ?resource=balance      -> a rep's reconciled, withdrawable balance
//   POST { action: "submit",              salespersonId, commissionEntryIds, notes }
//   POST { action: "request_withdrawal",  amount?, notes }
//   POST { action: "approve" | "reject" | "mark_paid" | "cancel", payoutId, note }
//
// Real per-resource database workflow with role checks and an append-only
// payout_events history. The tenant always comes from the session.
//
// A withdrawal request is NOT a parallel lifecycle: it produces an ordinary
// payout batch (kind='withdrawal_request') that runs the same approve /
// mark-paid / reject path with the same role checks and separation of duties.
// What the rep sends is a number; which ledger lines back it is decided
// server-side from their reconciled balance.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser } from "./_lib/auth.js";
import { csrfOk } from "./_lib/http.js";
import {
  getBalance,
  listPayouts,
  requestWithdrawal,
  submitPayout,
  transitionPayout,
  PayoutError,
  type PayoutAction,
} from "./_lib/payouts.js";

/** The salespeople a manager may look at (their own team). */
async function visibleSalespeopleIds(tenantId: string, managerUserId: string): Promise<Set<string>> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM salespeople WHERE tenant_id = $1 AND manager_user_id = $2`,
    [tenantId, managerUserId],
  );
  return new Set(rows.map((r) => r.id));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });

  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const actor = { userId: user.id, role: user.role };

    if (req.method === "GET") {
      // ?resource=balance -> the withdrawal card's reconciled balance. A rep is
      // pinned to their own record; an admin/manager may name someone in scope.
      if (String(req.query.resource ?? "") === "balance") {
        const requested = String(req.query.salespersonId ?? "").trim();
        const target = ["owner", "admin", "sales_manager"].includes(user.role)
          ? requested || user.salespersonId
          : user.salespersonId;
        if (!target) return res.status(400).json({ error: "no_salesperson" });
        if (user.role === "sales_manager" && requested) {
          const visible = await visibleSalespeopleIds(user.tenantId, user.id);
          if (!visible.has(requested)) return res.status(403).json({ error: "forbidden" });
        }
        const balance = await getBalance(user.tenantId, target);
        return res.status(200).json({ balance });
      }

      const payouts = await listPayouts(user.tenantId, actor, user.salespersonId);
      return res.status(200).json({ payouts });
    }

    if (req.method === "POST") {
      if (!csrfOk(req)) return res.status(403).json({ error: "csrf_check_failed" });
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
      const action = String(body.action ?? "");

      if (action === "submit") {
        const result = await submitPayout(
          user.tenantId,
          actor,
          user.salespersonId,
          String(body.salespersonId ?? ""),
          Array.isArray(body.commissionEntryIds) ? body.commissionEntryIds.map(String) : [],
          String(body.notes ?? ""),
        );
        return res.status(200).json({ ok: true, payoutId: result.id });
      }

      // A rep asking to be paid from their own available balance. The amount is
      // reconciled server-side and the result is an ordinary payout batch, so
      // the existing approve / reject / mark-paid workflow applies unchanged.
      if (action === "request_withdrawal") {
        const raw = body.amount;
        const amount =
          raw === null || raw === undefined || raw === "" ? null : Number(raw);
        if (amount !== null && !Number.isFinite(amount)) {
          return res.status(400).json({ error: "invalid_amount" });
        }
        const target = String(body.salespersonId ?? "") || user.salespersonId || "";
        const result = await requestWithdrawal(
          user.tenantId, actor, user.salespersonId, target, amount, String(body.notes ?? ""),
        );
        return res.status(200).json({ ok: true, payoutId: result.id, amount: result.amount, partial: result.partial });
      }

      if (["approve", "reject", "mark_paid", "cancel"].includes(action)) {
        await transitionPayout(
          user.tenantId, actor,
          action as Exclude<PayoutAction, "submit">,
          String(body.payoutId ?? ""), String(body.note ?? ""),
        );
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: "unknown_action" });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    if (err instanceof PayoutError) return res.status(err.status).json({ error: err.code });
    console.error("[scm:error] payouts:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return res.status(500).json({ error: "internal_error" });
  }
}
