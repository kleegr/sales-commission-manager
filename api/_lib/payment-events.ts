// ============================================================================
// PAYMENT EVENTS  (pure normalization + decisions; tested in payment-events.test.ts)
//
// Kleegr forwards GoHighLevel's payment lifecycle to /api/kleegr/webhook. This
// module turns those payloads into the two facts the commission system needs:
//
//   1. DID THE CLIENT ACTUALLY PAY?  Only a confirmed payment may release a
//      commission. Everything else — a pending authorization, a failed charge —
//      leaves the money held. This is the rule the product promises: *if the
//      client hasn't paid, the salesperson's commission stays held.*
//   2. DID THE MONEY COME BACK?      A refund or chargeback has to reverse the
//      commission it generated (see clawbacks.ts for what "reverse" means when
//      the rep has already been paid).
//
// There is NO gateway integration here and no database access: a webhook body
// goes in, a typed decision comes out, so every branch is unit-testable offline.
// Field names vary across GHL / Stripe-style payloads and across Kleegr
// versions, so each value is read from a list of plausible aliases rather than
// one hard-coded path — a payload we cannot read must fail as "unparseable",
// never as "succeeded".
// ============================================================================

import type { PaymentType } from "../../src/types/index.js";

/** The payment lifecycle events this app subscribes to. */
export const PAYMENT_WEBHOOK_EVENTS = [
  "payment.succeeded",
  "payment.failed",
  "payment.refunded",
  "payment.disputed",
] as const;

export type PaymentWebhookEvent = (typeof PAYMENT_WEBHOOK_EVENTS)[number];

/**
 * Aliases for the same four facts. GoHighLevel, Stripe and Kleegr each name
 * these differently; an unknown name is deliberately NOT mapped, so it falls
 * through to the "ignored" path instead of being guessed into a money movement.
 */
const EVENT_ALIASES: Record<string, PaymentWebhookEvent> = {
  "payment.succeeded": "payment.succeeded",
  "payment.completed": "payment.succeeded",
  "payment.captured": "payment.succeeded",
  "payment.paid": "payment.succeeded",
  "invoice.paid": "payment.succeeded",
  "invoice.payment_succeeded": "payment.succeeded",
  "order.paid": "payment.succeeded",
  "order.completed": "payment.succeeded",
  "subscription.charged": "payment.succeeded",

  "payment.failed": "payment.failed",
  "payment.declined": "payment.failed",
  "invoice.payment_failed": "payment.failed",
  "charge.failed": "payment.failed",

  "payment.refunded": "payment.refunded",
  "charge.refunded": "payment.refunded",
  "refund.created": "payment.refunded",
  "refund.succeeded": "payment.refunded",
  "order.refunded": "payment.refunded",

  "payment.disputed": "payment.disputed",
  "charge.dispute.created": "payment.disputed",
  "chargeback.created": "payment.disputed",
  "dispute.created": "payment.disputed",
};

/** Map a raw event name onto a payment event, or null if it isn't one. */
export function normalizePaymentEventName(raw: string): PaymentWebhookEvent | null {
  const name = String(raw ?? "").trim().toLowerCase();
  return EVENT_ALIASES[name] ?? null;
}

export function isPaymentEvent(raw: string): boolean {
  return normalizePaymentEventName(raw) !== null;
}

// ---------------------------------------------------------------------------
// Payload normalization
// ---------------------------------------------------------------------------

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    // Numeric ids are common and must not be dropped.
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function firstAmount(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return null;
}

function firstInt(...vals: unknown[]): number | null {
  const n = firstAmount(...vals);
  if (n === null) return null;
  const i = Math.round(n);
  return Number.isFinite(i) && i > 0 ? i : null;
}

/** ISO yyyy-mm-dd from an ISO string, epoch seconds, or epoch milliseconds. */
export function toISODate(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    const s = value.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Stripe-style epoch SECONDS vs JS milliseconds: anything below ~1e11 is
    // seconds (that threshold is the year 5138 in seconds, and 1973 in ms).
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Amounts arrive either as major units (12.50) or minor units (1250). A payload
 * that declares minor units — or names the field `amountCents` — is divided;
 * anything else is taken at face value, because silently dividing a real dollar
 * amount by 100 is the worse failure of the two.
 */
export function resolveAmount(raw: any): number {
  const minorFlag =
    raw?.amountInCents ?? raw?.amount_in_cents ?? raw?.amountCents ?? raw?.amount_cents;
  const minor = firstAmount(minorFlag);
  if (minor !== null) return Math.abs(minor) / 100;

  const major = firstAmount(
    raw?.amount, raw?.total, raw?.value, raw?.monetaryValue,
    raw?.amountPaid, raw?.amount_paid, raw?.grandTotal,
  );
  if (major === null) return 0;

  const unit = firstString(raw?.amountUnit, raw?.amount_unit, raw?.currencyUnit)?.toLowerCase();
  if (unit === "cents" || unit === "minor") return Math.abs(major) / 100;
  return Math.abs(major);
}

/** What kind of ledger movement a payment maps onto. */
export type PaymentEventKind = "succeeded" | "failed" | "refunded" | "disputed";

export interface NormalizedPaymentEvent {
  kind: PaymentEventKind;
  /** The gateway's own id — the idempotency key for the whole flow. */
  externalId: string | null;
  /** Contact / opportunity reference used to find our client row. */
  contactRef: string | null;
  opportunityRef: string | null;
  amount: number;
  currency: string | null;
  date: string | null;
  /** Which of OUR payment types this maps onto. */
  paymentType: PaymentType;
  /** Subscription month, for a recurring charge. */
  paymentNumber: number | null;
  /** On a refund/dispute: the original payment being reversed. */
  reversesExternalId: string | null;
  notes: string;
}

const KIND_BY_EVENT: Record<PaymentWebhookEvent, PaymentEventKind> = {
  "payment.succeeded": "succeeded",
  "payment.failed": "failed",
  "payment.refunded": "refunded",
  "payment.disputed": "disputed",
};

/**
 * Decide which of OUR payment types a charge represents.
 *
 * A subscription/recurring charge is a `monthly_subscription`; an explicit
 * setup/onboarding/initial charge is a `setup_fee`. When the payload says
 * nothing, the presence of a subscription reference decides, and the final
 * fallback is `setup_fee` — a one-off charge with no recurrence signal.
 */
export function classifyPaymentType(raw: any): PaymentType {
  const hint = firstString(
    raw?.paymentType, raw?.payment_type, raw?.type, raw?.category, raw?.productType,
  )?.toLowerCase();

  if (hint) {
    if (/(setup|onboard|initial|one[-_ ]?time|deposit)/.test(hint)) return "setup_fee";
    if (/(subscription|recurring|renewal|monthly|installment)/.test(hint)) return "monthly_subscription";
  }
  const hasSubscription = !!firstString(
    raw?.subscriptionId, raw?.subscription_id, raw?.recurringId, raw?.planId,
  );
  return hasSubscription ? "monthly_subscription" : "setup_fee";
}

/**
 * Normalize a verified webhook body into a payment event, or null when the
 * payload cannot be read as one. Returning null is a deliberate, safe outcome:
 * the webhook acknowledges the delivery (so the gateway stops retrying) and
 * changes nothing.
 */
export function normalizePaymentEvent(
  eventName: string,
  payload: any,
): NormalizedPaymentEvent | null {
  const event = normalizePaymentEventName(eventName);
  if (!event) return null;

  const root = payload && typeof payload === "object" ? payload : {};
  const raw = root.data && typeof root.data === "object" ? root.data : root;

  const externalId = firstString(
    raw.paymentId, raw.payment_id, raw.transactionId, raw.transaction_id,
    raw.chargeId, raw.charge_id, raw.invoiceId, raw.invoice_id, raw.orderId, raw.order_id,
    raw.id,
  );

  const contactRef = firstString(
    raw.contactId, raw.contact_id, raw.kleegr_contact_id, raw.ghl_contact_id,
    raw.customerId, raw.customer_id,
  );
  const opportunityRef = firstString(
    raw.opportunityId, raw.opportunity_id, raw.kleegr_opportunity_id, raw.ghl_opportunity_id,
  );

  // Nothing to attach the money to ⇒ we cannot act on it.
  if (!externalId && !contactRef && !opportunityRef) return null;

  const kind = KIND_BY_EVENT[event];
  const reversesExternalId =
    kind === "refunded" || kind === "disputed"
      ? firstString(
          raw.originalPaymentId, raw.original_payment_id, raw.paymentIntentId,
          raw.payment_intent, raw.refundedPaymentId, raw.chargeId, raw.charge_id,
        ) ?? externalId
      : null;

  return {
    kind,
    externalId,
    contactRef,
    opportunityRef,
    amount: resolveAmount(raw),
    currency: firstString(raw.currency, raw.currencyCode, raw.currency_code),
    date: toISODate(
      raw.paidAt ?? raw.paid_at ?? raw.date ?? raw.createdAt ?? raw.created_at ??
      raw.created ?? raw.timestamp ?? root.createdAt ?? root.timestamp,
    ),
    paymentType: classifyPaymentType(raw),
    paymentNumber: firstInt(
      raw.paymentNumber, raw.payment_number, raw.installment, raw.billingCycle, raw.cycle,
    ),
    reversesExternalId,
    notes: firstString(raw.description, raw.note, raw.memo) ?? "",
  };
}

// ---------------------------------------------------------------------------
// What the webhook should DO with the event (pure decision)
// ---------------------------------------------------------------------------

export type PaymentEventAction =
  /** Record/confirm the payment and recompute — commissions may now release. */
  | "record_verified"
  /** Record the attempt but leave it unverified — commissions stay held. */
  | "record_unverified"
  /** Reverse the commissions this payment generated. */
  | "reverse"
  /** Nothing actionable. */
  | "ignore";

/**
 * The whole "if the client hasn't paid, the commission stays held" rule in one
 * table. A FAILED charge is deliberately still RECORDED (unverified): the
 * attempt is part of the client's history, and holding the resulting commission
 * is more honest than pretending the charge never happened.
 */
export function paymentEventAction(kind: PaymentEventKind): PaymentEventAction {
  switch (kind) {
    case "succeeded": return "record_verified";
    case "failed": return "record_unverified";
    case "refunded":
    case "disputed": return "reverse";
  }
}
