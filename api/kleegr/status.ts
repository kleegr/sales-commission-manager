// ============================================================================
// GET /api/kleegr/status   (also the manifest's statusEndpoint)
//
// Steps 4/5 — the read side of the integration. Powers the settings UI and lets
// Kleegr poll our status. Returns:
//   - config presence (which env vars are set — NEVER their values)
//   - manifest info (appKey/version/scopes/webhookEvents) + declared resources
//   - when a session is present: the tenant-scoped connection summary
//     (sub-account id, location id, connection status, connected user, last
//     sync, imported/linked counts)
//
// No secrets are ever returned. Live server↔Kleegr token verification is a
// separate explicit action (POST /api/kleegr/test-connection).
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "../_lib/db.js";
import { ensureSchema, seedIfEmpty } from "../_lib/repository.js";
import { getSessionUser } from "../_lib/auth.js";
import { readKleegrConfig, APP_KEY, APP_NAME, APP_VERSION } from "../_lib/kleegr.js";
import { KLEEGR_MANIFEST } from "../_lib/kleegr-manifest.js";
import { readKleegrStatusSummary } from "../_lib/kleegr-sync.js";

/** Map manifest readonly scopes → the gateway resources we actually declare. */
function declaredResources(): string[] {
  const map: Record<string, string> = {
    "locations.readonly": "subaccount",
    "users.readonly": "users",
    "contacts.readonly": "contacts",
    "opportunities.readonly": "opportunities",
  };
  return KLEEGR_MANIFEST.scopes.map((s) => map[s] ?? s);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });

  const cfg = readKleegrConfig();
  const base = {
    ok: true,
    app: { appKey: APP_KEY, appName: APP_NAME, appVersion: APP_VERSION },
    config: {
      baseUrl: cfg.baseUrl,
      hasIntegrationToken: cfg.hasIntegrationToken,
      hasWebhookSecret: cfg.hasWebhookSecret,
      missing: cfg.missing,
      ready: cfg.ok,
    },
    manifest: {
      present: true,
      appKey: KLEEGR_MANIFEST.appKey,
      appVersion: KLEEGR_MANIFEST.appVersion,
      scopes: KLEEGR_MANIFEST.scopes,
      webhookEvents: KLEEGR_MANIFEST.webhookEvents,
    },
    availableResources: declaredResources(),
  };

  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);

    if (!user) {
      // External/unauthenticated poll: health + config only (no tenant data).
      return res.status(200).json({ ...base, authenticated: false });
    }

    const summary = await readKleegrStatusSummary(user.tenantId, user.email);
    return res.status(200).json({
      ...base,
      authenticated: true,
      workspace: { tenantSlug: user.tenantSlug, tenantName: user.tenantName, role: user.role },
      connection: summary,
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
}
