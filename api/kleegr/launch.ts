// ============================================================================
// POST/GET /api/kleegr/launch   (public launch URL: /kleegr/launch via rewrite)
//
// Step 2 — the Kleegr launch flow. Kleegr opens this URL with a short-lived
// launch token (as ?token=… or Authorization: Bearer …). We:
//   1. extract the launch token
//   2. verify it with Kleegr (POST /api/plugins/verify)
//   3. validate the claims (valid, aud, exp, sp_user_id, sub_account_id)
//   4. map the Kleegr role → our role
//   5. upsert the tenant (sub-account) + user, then create OUR OWN session
//   6. (best effort) run a small first sync + report 'connected' to Kleegr
//   7. redirect into the correct workspace
//
// The launch token is used ONCE (verify + the immediate gateway sync) and is
// NEVER cached, reused, persisted, or sent to the browser. We mint our own
// short cookie session instead.
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "../_lib/db.js";
import { ensureSchema } from "../_lib/repository.js";
import { createSession, setSessionCookie } from "../_lib/auth.js";
import {
  verifyLaunchToken,
  mapKleegrRole,
  reportIntegrationStatus,
  readKleegrConfig,
  type AppRole,
} from "../_lib/kleegr.js";
import { upsertTenantForSubAccount, upsertUserForClaims, runInitialSync } from "../_lib/kleegr-sync.js";

function extractLaunchToken(req: VercelRequest): string | null {
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  if (typeof q === "string" && q) return q;
  if (Array.isArray(q) && typeof q[0] === "string" && q[0]) return q[0];
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  if (req.body) {
    const b = typeof req.body === "string" ? safeJson(req.body) : req.body;
    if (b && typeof b === "object" && typeof (b as any).token === "string") return (b as any).token;
  }
  return null;
}
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function homePathFor(role: AppRole): string {
  if (role === "owner") return "/agency";
  if (role === "admin" || role === "sales_manager") return "/";
  return "/portal";
}

/** A minimal, dependency-free HTML page for launch failures (no session yet). */
function sendLaunchError(res: VercelResponse, status: number, reason: string): void {
  const safe = reason.replace(/[<>&]/g, "");
  res.status(status).setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Launch failed</title>` +
      `<div style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#0f172a">` +
      `<h1 style="font-size:1.25rem">Couldn't open Sales Commission Manager</h1>` +
      `<p style="color:#475569">The Kleegr launch could not be verified (<code>${safe}</code>). ` +
      `Please re-open the app from your Kleegr sub-account. If this keeps happening, contact your administrator.</p>` +
      `</div>`,
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return sendLaunchError(res, 503, "database_not_configured");

  const cfg = readKleegrConfig();
  if (!cfg.hasIntegrationToken) return sendLaunchError(res, 500, "integration_not_configured");

  try {
    await ensureSchema();

    const launchToken = extractLaunchToken(req);
    if (!launchToken) return sendLaunchError(res, 400, "missing_launch_token");

    // 2 + 3. verify with Kleegr and validate claims (never trust the client)
    const verified = await verifyLaunchToken(launchToken);
    if (!verified.ok || !verified.claims) {
      return sendLaunchError(res, 401, verified.reason ?? "invalid_launch_token");
    }
    const claims = verified.claims;

    // 4. role mapping. An agency-level placement maps agency_admin → owner;
    //    a sub-account placement maps it → admin. Default: sub-account.
    const placement = String((req.query as any)?.placement ?? (claims.raw as any)?.placement ?? "").toLowerCase();
    const context = placement === "agency" ? "agency" : "sub_account";
    const mappedRole = mapKleegrRole(claims.role, context);

    // 5. upsert tenant + user, then mint our own session
    const tenant = await upsertTenantForSubAccount({
      subAccountId: claims.sub_account_id,
      locationId: claims.location_id,
      name: null,
    });
    const user = await upsertUserForClaims(tenant.id, claims, mappedRole);

    const sessionToken = await createSession(user.id, tenant.id);
    setSessionCookie(res, sessionToken, { crossSite: true });

    // 6. best-effort first sync (uses the launch token, then discards it) and
    //    status report. Neither blocks the launch: failures are swallowed so a
    //    transient gateway hiccup never prevents the user from entering the app.
    try {
      await runInitialSync({ launchToken, tenantId: tenant.id });
    } catch {
      /* sync is best-effort; per-resource failures are already isolated */
    }
    try {
      await reportIntegrationStatus("connected", claims.sub_account_id, "Sales Commission Manager connected.");
    } catch {
      /* status reporting is best-effort */
    }

    // 7. redirect into the correct workspace for this role
    const target = `${homePathFor(mappedRole)}?kleegr=connected`;
    res.status(302).setHeader("Location", target);
    return res.end();
  } catch (err: any) {
    return sendLaunchError(res, 500, String(err?.message ?? err).slice(0, 120));
  }
}
