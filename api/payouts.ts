// /api/payouts
//   GET                       -> payouts visible to the current user (role-scoped) + history
//   POST { action: "submit",  salespersonId, commissionEntryIds, notes }
//   POST { action: "approve" | "reject" | "mark_paid" | "cancel", payoutId, note }
//
// Real per-resource database workflow with role checks and an append-only
// payout_events history. The tenant always comes from the session.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser } from "./_lib/auth.js";
import {
  listPayouts,
  submitPayout,
  transitionPayout,
  PayoutError,
  type PayoutAction,
} from "./_lib/payouts.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });

  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const actor = { userId: user.id, role: user.role };

    if (req.method === "GET") {
      const payouts = await listPayouts(user.tenantId, actor, user.salespersonId);
      return res.status(200).json({ payouts });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
      const action = String(body.action ?? "") as PayoutAction;

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

      if (["approve", "reject", "mark_paid", "cancel"].includes(action)) {
        await transitionPayout(user.tenantId, actor, action as any, String(body.payoutId ?? ""), String(body.note ?? ""));
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: "unknown_action" });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err: any) {
    if (err instanceof PayoutError) return res.status(err.status).json({ error: err.code });
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
