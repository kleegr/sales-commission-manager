// /api/state
//   GET -> the CURRENT USER's AppData, scoped to their tenant AND role.
//
// THE SNAPSHOT WRITE IS GONE (removed in the per-resource refactor).
// `PUT`/`POST /api/state` used to replace an entire tenant transactionally. It
// was the last write path that could not express *who* changed *what*, and it
// was the root of two real defects:
//
//   1. It deleted and re-inserted the whole commission ledger, so ledger ids
//      moved underneath `payout_batch_entries` and previously-created payout
//      batches lost their line linkage.
//   2. Any client holding a stale snapshot could overwrite concurrent work by
//      another admin (last-write-wins across the whole tenant).
//
// Every mutation now has a dedicated, role-checked, single-row endpoint:
//
//   people      -> /api/salespeople   (POST | PATCH | DELETE)
//   plans       -> /api/plans         (POST | PUT | DELETE, + duplicate/reorder)
//   clients     -> /api/clients       (POST | PATCH | DELETE)
//   payments    -> /api/payments      (POST | PATCH | DELETE)
//   settings    -> /api/settings      (PUT)
//   ledger      -> /api/ledger        (POST ?action=release|recompute)
//   payouts     -> /api/payouts       (POST submit|approve|reject|mark_paid|cancel)
//   goals       -> /api/goals         features -> /api/features
//
// A write request here answers 410 Gone with that map, so any older client gets
// an actionable error instead of silently diverging from the database.
//
// SECURITY: the tenant is taken from the authenticated session, never from the
// client. A query param `?tenant=` is accepted only if it matches the session
// tenant; any mismatch is a 403. Non-admin roles receive a server-filtered
// dataset (their own / their team's rows only).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "./_lib/db.js";
import { ensureSchema, readScopedState, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser } from "./_lib/auth.js";
import { deploymentEnvironment, localFallbackAllowed } from "./_lib/runtime-env.js";

/** Where a write for each resource has to go now that the snapshot is gone. */
const RESOURCE_ENDPOINTS = {
  salespeople: "/api/salespeople",
  plans: "/api/plans",
  clients: "/api/clients",
  payments: "/api/payments",
  settings: "/api/settings",
  commissions: "/api/ledger",
  payouts: "/api/payouts",
} as const;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });

  try {
    await ensureSchema();
    await seedIfEmpty();

    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    // If a tenant is named in the query, it must match the session tenant.
    const requested = req.query.tenant ? String(req.query.tenant).trim() : null;
    if (requested && requested !== user.tenantSlug) {
      return res.status(403).json({ error: "tenant_forbidden" });
    }

    if (req.method === "GET") {
      const data = await readScopedState(user.tenantId, {
        userId: user.id,
        role: user.role,
        salespersonId: user.salespersonId,
      });
      const environment = deploymentEnvironment(process.env);
      return res.status(200).json({
        tenant: { slug: user.tenantSlug, name: user.tenantName },
        role: user.role,
        data,
        // Tells the browser store that the database — not localStorage — is the
        // source of truth here, and whether a cached copy may ever stand in for
        // it. See src/lib/storage/fallback-policy.ts.
        mode: {
          serverAuthoritative: true,
          environment,
          localFallback: localFallbackAllowed(process.env),
        },
      });
    }

    if (req.method === "PUT" || req.method === "POST") {
      res.setHeader("Allow", "GET");
      return res.status(410).json({
        error: "snapshot_write_removed",
        hint: "PUT /api/state was removed. Use the per-resource endpoint for the resource you are changing.",
        endpoints: RESOURCE_ENDPOINTS,
      });
    }

    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("[scm:error] state:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return res.status(500).json({ error: "internal_error" });
  }
}
