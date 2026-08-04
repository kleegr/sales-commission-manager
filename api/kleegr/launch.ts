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
//   7. hand off into the correct workspace
//
// The KLEEGR LAUNCH TOKEN is used ONCE (verify + the immediate gateway sync)
// and is NEVER cached, reused, persisted, or sent to the browser. We mint our
// OWN short session and hand that to the browser instead.
//
// Step 7 is a client-side handoff rather than a 302 because mobile WebViews
// block third-party cookies inside the Smart Productivity iframe: the session
// is delivered BOTH as a Set-Cookie (direct web browsing) and via localStorage
// + `Authorization: Bearer` (embedded/mobile). See _lib/launch-handoff.ts.
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "../_lib/db.js";
import { ensureSchema } from "../_lib/repository.js";
import { createSession, setSessionCookie } from "../_lib/auth.js";
import { renderLaunchHandoff } from "../_lib/launch-handoff.js";
import {
  verifyLaunchToken,
  reportIntegrationStatus,
  readKleegrConfig,
  type AppRole,
} from "../_lib/kleegr.js";
import { mapLaunchTokenRole } from "../_lib/kleegr-roles.js";
import {
  upsertTenantForSubAccount,
  upsertUserForClaims,
  ensureSalespersonForUser,
  runInitialSync,
} from "../_lib/kleegr-sync.js";

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

    // 4. role mapping. The launch token's `role` claim is a Smart Productivity
    //    GLOBAL TIER key (agency_admin | subaccount_admin | manager | user |
    //    viewer), NOT a raw GoHighLevel role string — so it is mapped with
    //    mapLaunchTokenRole(), which knows that vocabulary. The previous code
    //    used mapKleegrRole() here, which has no case for `subaccount_admin` or
    //    `viewer`; both fell through to the salesperson default and a
    //    sub-account administrator landed on the limited /portal workspace.
    //    An agency-level placement maps agency_admin → owner; a sub-account
    //    placement maps it → admin. Default: sub-account.
    const placement = String((req.query as any)?.placement ?? (claims.raw as any)?.placement ?? "").toLowerCase();
    const context = placement === "agency" ? "agency" : "sub_account";
    const mappedRole = mapLaunchTokenRole(claims.role, context);

    // 5. upsert tenant + user, then mint our own session
    const tenant = await upsertTenantForSubAccount({
      subAccountId: claims.sub_account_id,
      locationId: claims.location_id,
      name: null,
    });
    const user = await upsertUserForClaims(tenant.id, claims, mappedRole);

    // 5b. A self-scoped role (salesperson/affiliate/partner) is sent to /portal by
    //     homePathFor() below, and that workspace renders ONLY the salespeople row
    //     referenced by users.salesperson_id. Creating the users row was never
    //     enough: the link stayed NULL, readScopedState() filtered the dataset to
    //     the empty set, and the portal rendered "No profile found" on EVERY
    //     launch. Ensure + link the rep record here.
    //
    //     Best effort by design — a failure must not cost the user their launch.
    //     Admin/owner/manager roles are skipped inside (they are not rep-scoped),
    //     so for them this is a no-op.
    try {
      await ensureSalespersonForUser(tenant.id, user, claims, mappedRole);
    } catch (err) {
      console.error(
        "[scm:error] launch salesperson link:",
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
    }

    const sessionToken = await createSession(user.id, tenant.id);
    setSessionCookie(res, sessionToken, { crossSite: true });

    // 6. best-effort profile sync + status report. By DEFAULT this only refreshes
    //    the sub-account profile — it does NOT auto-import contacts/opportunities
    //    or auto-provision other users (that import is gated behind
    //    KLEEGR_SYNC_ENABLED; see runInitialSync). Neither blocks the launch:
    //    failures are swallowed so a transient gateway hiccup never prevents the
    //    user from entering the app.
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

    // 7. hand off into the correct workspace for this role.
    //
    //    NOT a 302. Smart Productivity frames this app on mobile, where iOS
    //    WebKit / Android WebView block third-party cookies: the Set-Cookie
    //    above is silently dropped inside the iframe, and a plain redirect
    //    would land on a dashboard with no credential at all — which is
    //    exactly why the manual "Sign in to your workspace" screen kept
    //    appearing after a successful launch.
    //
    //    Instead we return a one-shot HTML handoff that puts the session token
    //    in localStorage (first-party to THIS origin, so a WebView cannot block
    //    it) and then location.replace()s into the workspace. The client
    //    replays it as `Authorization: Bearer …` on every /api call; see
    //    src/lib/api-auth.ts and getSessionTokens() in api/_lib/auth.ts.
    //
    //    The cookie is still set for direct (non-framed) browsing, so nothing
    //    about the standard web login path changes.
    const target = `${homePathFor(mappedRole)}?kleegr=connected`;
    res.status(200);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // The body carries a live session token — it must never be cached by a
    // CDN, a WebView, or the back/forward cache.
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.send(renderLaunchHandoff(target, sessionToken));
  } catch (err: any) {
    return sendLaunchError(res, 500, String(err?.message ?? err).slice(0, 120));
  }
}
