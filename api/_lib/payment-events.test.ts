// DB-free tests for payment webhook normalization and the "has the client
// actually paid?" decision.
// Run via `tsx api/_lib/payment-events.test.ts` (wired into `npm test`).
//
// Two things matter here more than the parsing detail:
//   1. An unreadable payload must normalize to NULL, never to "succeeded".
//      A false positive releases money that was never collected.
//   2. Only a confirmed charge maps to `record_verified`. Everything else keeps
//      the commission held, which is the rule the product promises.
import {
  classifyPaymentType,
  isPaymentEvent,
  normalizePaymentEvent,
  normalizePaymentEventName,
  paymentEventAction,
  resolveAmount,
  toISODate,
  PAYMENT_WEBHOOK_EVENTS,
} from "./payment-events.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("\n[event names · the alias table]");

for (const canonical of PAYMENT_WEBHOOK_EVENTS) {
  ok(`${canonical} maps to itself`, normalizePaymentEventName(canonical) === canonical);
}
ok("invoice.paid ⇒ succeeded", normalizePaymentEventName("invoice.paid") === "payment.succeeded");
ok("order.completed ⇒ succeeded", normalizePaymentEventName("order.completed") === "payment.succeeded");
ok("charge.refunded ⇒ refunded", normalizePaymentEventName("charge.refunded") === "payment.refunded");
ok("chargeback.created ⇒ disputed", normalizePaymentEventName("chargeback.created") === "payment.disputed");
ok("invoice.payment_failed ⇒ failed", normalizePaymentEventName("invoice.payment_failed") === "payment.failed");
ok("case and padding are tolerated", normalizePaymentEventName("  Invoice.Paid ") === "payment.succeeded");

// An unrecognised name must NOT be guessed into a money movement.
ok("contact.created is not a payment event", normalizePaymentEventName("contact.created") === null);
ok("an empty name is not one", normalizePaymentEventName("") === null);
ok("isPaymentEvent agrees", isPaymentEvent("payment.succeeded") && !isPaymentEvent("app.installed"));

console.log("\n[toISODate · the shapes a gateway actually sends]");

ok("an ISO datetime", toISODate("2025-03-04T10:11:12Z") === "2025-03-04");
ok("a plain date", toISODate("2025-03-04") === "2025-03-04");
ok("epoch seconds (Stripe)", toISODate(1741046400) === "2025-03-04");
ok("epoch milliseconds", toISODate(1741046400000) === "2025-03-04");
ok("garbage is null", toISODate("not a date") === null);
ok("null is null", toISODate(null) === null);

console.log("\n[resolveAmount · major vs minor units]");

ok("a plain amount is taken as-is", resolveAmount({ amount: 12.5 }) === 12.5);
ok("a numeric string parses", resolveAmount({ amount: "12.50" }) === 12.5);
ok("amountInCents is divided", resolveAmount({ amountInCents: 1250 }) === 12.5);
ok("amount_cents is divided", resolveAmount({ amount_cents: 1250 }) === 12.5);
ok("a declared cents unit is divided", resolveAmount({ amount: 1250, amountUnit: "cents" }) === 12.5);
// Dividing a real dollar figure by 100 is the worse of the two mistakes, so an
// undeclared amount is never assumed to be minor units.
ok("an undeclared amount is NOT divided", resolveAmount({ amount: 1250 }) === 1250);
ok("a refund's negative amount is normalized positive", resolveAmount({ amount: -50 }) === 50);
ok("a missing amount is 0", resolveAmount({}) === 0);

console.log("\n[classifyPaymentType]");

ok("an explicit setup hint", classifyPaymentType({ type: "setup_fee" }) === "setup_fee");
ok("an onboarding hint", classifyPaymentType({ productType: "Onboarding package" }) === "setup_fee");
ok("a subscription hint", classifyPaymentType({ type: "subscription" }) === "monthly_subscription");
ok("a renewal hint", classifyPaymentType({ category: "Renewal" }) === "monthly_subscription");
ok("a subscription id implies recurring", classifyPaymentType({ subscriptionId: "sub_1" }) === "monthly_subscription");
ok("a bare one-off falls back to setup_fee", classifyPaymentType({}) === "setup_fee");

console.log("\n[normalizePaymentEvent · a readable payload]");

{
  const ev = normalizePaymentEvent("invoice.paid", {
    event: "invoice.paid",
    data: {
      id: "ch_123",
      contactId: "contact_9",
      amount: 250,
      currency: "USD",
      paidAt: "2025-03-04T09:00:00Z",
      subscriptionId: "sub_1",
      paymentNumber: 3,
    },
  });
  ok("normalizes", ev !== null);
  ok("kind is succeeded", ev?.kind === "succeeded");
  ok("carries the gateway id", ev?.externalId === "ch_123");
  ok("carries the contact ref", ev?.contactRef === "contact_9");
  ok("carries the amount", ev?.amount === 250);
  ok("carries the date", ev?.date === "2025-03-04");
  ok("classified as a subscription", ev?.paymentType === "monthly_subscription");
  ok("carries the payment number", ev?.paymentNumber === 3);
  ok("a success reverses nothing", ev?.reversesExternalId === null);
}

console.log("\n[normalizePaymentEvent · a refund names what it reverses]");

{
  const ev = normalizePaymentEvent("charge.refunded", {
    data: { id: "re_9", originalPaymentId: "ch_123", contactId: "contact_9", amount: 250 },
  });
  ok("kind is refunded", ev?.kind === "refunded");
  ok("points at the original charge", ev?.reversesExternalId === "ch_123");
}
{
  // With no explicit original, the event's own id is the charge being reversed.
  const ev = normalizePaymentEvent("payment.refunded", {
    data: { id: "ch_123", contactId: "contact_9", amount: 10 },
  });
  ok("falls back to its own id", ev?.reversesExternalId === "ch_123");
}

console.log("\n[normalizePaymentEvent · unreadable payloads fail SAFE]");

ok("a non-payment event is null", normalizePaymentEvent("contact.created", { data: { id: "x" } }) === null);
// Nothing to attach the money to ⇒ we must not act on it.
ok("no ids at all is null", normalizePaymentEvent("payment.succeeded", { data: { amount: 100 } }) === null);
ok("an empty body is null", normalizePaymentEvent("payment.succeeded", {}) === null);
ok("a null body is null", normalizePaymentEvent("payment.succeeded", null) === null);
ok("a string body is null", normalizePaymentEvent("payment.succeeded", "nope") === null);

console.log("\n[normalizePaymentEvent · a flat (undata'd) payload still works]");

{
  const ev = normalizePaymentEvent("payment.succeeded", { paymentId: "p1", contactId: "c1", amount: 5 });
  ok("reads the root object when there is no data envelope", ev?.externalId === "p1");
}

console.log("\n[paymentEventAction · if the client hasn't paid, nothing releases]");

ok("succeeded records a VERIFIED payment", paymentEventAction("succeeded") === "record_verified");
// A failed charge is still recorded — the attempt is part of the client's
// history — but unverified, so its commission stays held.
ok("failed records an UNVERIFIED payment", paymentEventAction("failed") === "record_unverified");
ok("refunded reverses", paymentEventAction("refunded") === "reverse");
ok("disputed reverses", paymentEventAction("disputed") === "reverse");

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
