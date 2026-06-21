// ============================================================================
// POST /api/kleegr/webhook
//
// Step 7 — the Kleegr webhook receiver. Kleegr signs every webhook with
// HMAC-SHA256 over the RAW request body and sends it as:
//     X-SP-Signature: sha256=<hex>
//
// Verification FAILS CLOSED:
//   - missing secret (server misconfig) → 500
//   - missing signature                 → 401
//   - invalid signature                 → 401
//   - valid signature                   → process the event, 200
//
// We MUST read the raw bytes for the HMAC, so Vercel's automatic body parsing
// is disabled below and we read the stream ourselves. Events are recorded
// (idempotently, by delivery id) and applied to our tenant-scoped data.
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb } from "../_lib/db.js";
import { ensureSchema } from "../_lib/repository.js";
import { verifyWebhookSignature, isHandledWebhookEvent, KleegrError } from "../_lib/kleegr.js";
import { recordWebhookEvent, applyWebhookEvent, extractSubAccountId, resolveTenantBySubAccount } from "../_lib/kleegr-sync.js";

// Disable Vercel's body parser so we can read the exact bytes Kleegr signed.
export const config = { api: { bodyParser: false } };

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as any) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

function headerValue(req: VercelRequest, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return (v as string | undefined) ?? null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });

  const secret = (process.env.KLEEGR_WEBHOOK_SECRET ?? "").trim();

  let raw: Buffer;
  try {
    raw = await readRawBody(req);
  } catch {
    return res.status(400).json({ error: "unreadable_body" });
  }

  // Verify the signature BEFORE parsing or trusting any field.
  const signature = headerValue(req, "X-SP-Signature");
  try {
    if (!verifyWebhookSignature(raw, signature, secret)) {
      return res.status(401).json({ error: "invalid_signature" });
    }
  } catch (err) {
    if (err instanceof KleegrError && err.code === "config_error") {
      // Missing webhook secret is a server misconfiguration — fail closed at 500.
      return res.status(500).json({ error: "webhook_secret_not_configured" });
    }
    return res.status(401).json({ error: "invalid_signature" });
  }

  // Signature is valid → safe to parse.
  let payload: any;
  try {
    payload = raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch {
    return res.status(400).json({ error: "invalid_json" });
  }

  const eventType = String(payload?.event ?? payload?.type ?? payload?.eventType ?? "").trim();
  const deliveryId =
    typeof payload?.id === "string" ? payload.id :
    typeof payload?.eventId === "string" ? payload.eventId :
    typeof payload?.webhookId === "string" ? payload.webhookId :
    typeof payload?.deliveryId === "string" ? payload.deliveryId : null;

  try {
    await ensureSchema();

    const subAccountId = extractSubAccountId(payload);
    const tenant = subAccountId ? await resolveTenantBySubAccount(subAccountId) : null;

    // Record first (idempotent). A duplicate delivery is acknowledged, not re-applied.
    const recorded = await recordWebhookEvent(tenant?.id ?? null, eventType || "unknown", deliveryId, payload);
    if (recorded.duplicate) {
      return res.status(200).json({ ok: true, duplicate: true, event: eventType });
    }

    if (!eventType || !isHandledWebhookEvent(eventType)) {
      // Acknowledge unknown/undeclared events (avoid retries) but do nothing.
      return res.status(200).json({ ok: true, applied: false, action: "ignored", event: eventType || null });
    }

    const result = await applyWebhookEvent(eventType, payload);
    return res.status(200).json({ ok: true, applied: result.applied, action: result.action, event: eventType });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
