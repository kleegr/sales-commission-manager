import {createHash} from 'node:crypto';
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
import { trackerInstalled, database } from '../_lib/tracker-common.js';
import { normalizeWebhookRow, queueTrackerEvent, autoImportEvent } from '../_lib/tracker-sync.js';
import { hasDb } from "../_lib/db.js";
import { ensureSchema } from "../_lib/repository.js";
import { verifyWebhookSignature, isHandledWebhookEvent, normalizeWebhookEvent, KleegrError } from "../_lib/kleegr.js";
import { recordWebhookEvent, applyWebhookEvent, extractSubAccountId, resolveTenantBySubAccount } from "../_lib/kleegr-sync.js";
import { parseInvoicePaidEvent, applyInvoicePaidEvent } from "../_lib/ghl-invoicing.js";

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

  const eventTypeRaw = String(payload?.event ?? payload?.type ?? payload?.eventType ?? "").trim();
  // Accept both `location.*` and the legacy `subaccount.*` webhook namings.
  const eventType = normalizeWebhookEvent(eventTypeRaw);
  const explicitId =
    typeof payload?.id === "string" ? payload.id :
    typeof payload?.eventId === "string" ? payload.eventId :
    typeof payload?.webhookId === "string" ? payload.webhookId :
    typeof payload?.deliveryId === "string" ? payload.deliveryId : null;

  try {
    await ensureSchema();

    const subAccountId = extractSubAccountId(payload);
    const tenant = subAccountId ? await resolveTenantBySubAccount(subAccountId) : null;

    // An event with no explicit id must still dedupe: derive a DETERMINISTIC
    // fallback id from (tenant, event type, exact signed payload bytes) so a
    // retried delivery of the same event maps to the same id.
    const deliveryId = explicitId ??
      `derived_${createHash("sha256").update(`${tenant?.id ?? subAccountId ?? ""}|${eventType}|`).update(raw).digest("hex")}`;

    // Record first (idempotent). A duplicate delivery is acknowledged, not re-applied.
    const recorded = await recordWebhookEvent(tenant?.id ?? null, eventType || "unknown", deliveryId, payload);

    // GHL-native invoice payment -> automatic per-line-item commission. These arrive
    // proxied through Kleegr like every other webhook; we key on the ORIGINAL event
    // name (invoice/payment events are outside the location.*/subaccount.* family, so
    // this is handled before isHandledWebhookEvent). Mapping to our document is by the
    // globally-unique ghl_invoice_id, and applyInvoicePaidEvent is itself idempotent.
    const invoicePaid = parseInvoicePaidEvent(eventTypeRaw, payload);
    if (invoicePaid) {
      if (recorded.duplicate) {
        return res.status(200).json({ ok: true, duplicate: true, event: eventType, action: "invoice_paid_duplicate" });
      }
      if (!(await trackerInstalled())) {
        return res.status(200).json({ ok: true, applied: false, action: "tracker_not_installed", event: eventType });
      }
      const result = await database.transaction((db) => applyInvoicePaidEvent(db, invoicePaid));
      return res.status(200).json({ ok: true, applied: result.applied, action: result.action, event: eventType, documentId: result.documentId ?? null, earnings: result.earnings ?? 0 });
    }

    if (tenant && await trackerInstalled() && /^(contact|opportunity)\./.test(eventType)) {
      // Every verified redelivery can restore the review queue after a crash: the row is
      // normalised to the same shape the sync preview stages, so approveImport (manual or
      // the opted-in automatic pipeline policy) is the single path that applies it.
      // Financial effects happen only through that path, never implicitly here.
      const normalized = normalizeWebhookRow(eventType, payload.data || payload);
      if (!normalized) return res.status(200).json({ok:true,queued:false,action:'unmapped',duplicate:recorded.duplicate,event:eventType});
      await queueTrackerEvent(database, tenant.id, normalized.resource, normalized.row, `Verified Kleegr ${eventType} event. Match the contact and confirm the mapping before approval.`);
      const auto = await autoImportEvent(database, tenant.id, normalized.resource, normalized.row.externalId);
      return res.status(200).json({ok:true,queued:true,resource:normalized.resource,duplicate:recorded.duplicate,event:eventType,auto});
    }
    if (recorded.duplicate) {
      return res.status(200).json({ ok: true, duplicate: true, event: eventType });
    }

    if (!eventType || !isHandledWebhookEvent(eventType)) {
      // Acknowledge unknown/undeclared events (avoid retries) but do nothing.
      return res.status(200).json({ ok: true, applied: false, action: "ignored", event: eventType || null });
    }

    const result = await applyWebhookEvent(eventType, payload);
    return res.status(200).json({ ok: true, applied: result.applied, action: result.action, event: eventType });
  } catch (err) {
    console.error("[scm:error] kleegr-webhook:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return res.status(500).json({ error: "internal_error" });
  }
}
