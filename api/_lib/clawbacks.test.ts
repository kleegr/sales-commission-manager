// DB-free tests for the refund / chargeback reversal plan.
// Run via `tsx api/_lib/clawbacks.test.ts` (wired into `npm test`).
//
// The single decision this module exists to get right:
//   money NOT yet paid  -> void the line (nothing left the business)
//   money ALREADY paid  -> book a NEGATIVE adjustment (history is immutable, so
//                          the reversal nets off the rep's next payout instead)
// Getting it backwards either double-deducts a rep or silently forgives a
// refund, and both are the kind of error a commission system cannot ship with.
import { planClawback, isAlreadyPaid, isAlreadyReversed, type ClawbackCandidate } from "./clawbacks.js";
import type { CommissionStatus } from "../../src/types/index.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const ASOF = "2025-06-01";

function line(over: Partial<ClawbackCandidate> = {}): ClawbackCandidate {
  return {
    id: "led1",
    salespersonId: "sp1",
    clientId: "cl1",
    paymentId: "pay1",
    ruleId: "r_setup",
    ruleType: "setup_fee",
    ruleLabel: "Setup fee · 10%",
    commissionAmount: 100,
    status: "pending",
    isProjection: false,
    entrySource: "engine",
    ...over,
  };
}

console.log("\n[status helpers]");

ok("paid counts as paid", isAlreadyPaid("paid"));
ok("approved does not (money hasn't moved)", !isAlreadyPaid("approved"));
ok("submitted does not", !isAlreadyPaid("submitted"));
ok("clawed_back is already reversed", isAlreadyReversed("clawed_back"));
ok("rejected is already reversed", isAlreadyReversed("rejected"));
ok("canceled is already reversed", isAlreadyReversed("canceled"));
ok("pending is not", !isAlreadyReversed("pending"));

console.log("\n[unpaid money is simply voided — no adjustment row]");

for (const status of ["projected", "held", "pending", "submitted", "approved"] as CommissionStatus[]) {
  const plan = planClawback({ candidates: [line({ status })], trigger: "refund", asOf: ASOF });
  ok(`${status} is voided`, plan.voidIds.includes("led1"));
  ok(`${status} books no adjustment`, plan.adjustments.length === 0);
}

console.log("\n[paid money books a NEGATIVE adjustment instead]");

{
  const plan = planClawback({ candidates: [line({ status: "paid" })], trigger: "refund", asOf: ASOF });
  ok("the paid line is NOT voided (history is immutable)", plan.voidIds.length === 0);
  ok("one adjustment is booked", plan.adjustments.length === 1);
  const adj = plan.adjustments[0];
  ok("the amount is negative", adj.commissionAmount === -100);
  ok("...and equals the reversed amount", Math.abs(adj.commissionAmount) === 100);
  ok("it points back at the line it reverses", adj.adjustmentOfEntryId === "led1");
  ok("it belongs to the same rep", adj.salespersonId === "sp1");
  // `pending` is what lets it enter the payout pool and net off the next cycle.
  ok("it is pending, so it nets off the next payout", adj.status === "pending");
  ok("it is marked as a clawback, not engine output", adj.entrySource === "clawback");
  ok("it is not attached to the reversed payment", adj.paymentId === null);
  ok("it is not a projection", adj.isProjection === false);
  ok("the label names the trigger", adj.ruleLabel.includes("refund"));
  ok("it carries a reason", (adj.clawbackReason ?? "").length > 0);
}
{
  const plan = planClawback({ candidates: [line({ status: "paid" })], trigger: "chargeback", asOf: ASOF });
  ok("a chargeback is labelled as such", plan.adjustments[0].ruleLabel.includes("chargeback"));
}

console.log("\n[idempotency · a re-delivered refund cannot double-deduct]");

{
  // The default id is derived from the entry being reversed, so a second
  // insert collides on the primary key and is a no-op.
  const first = planClawback({ candidates: [line({ status: "paid" })], trigger: "refund", asOf: ASOF });
  const second = planClawback({ candidates: [line({ status: "paid" })], trigger: "refund", asOf: ASOF });
  ok("the adjustment id is deterministic", first.adjustments[0].id === second.adjustments[0].id);
}
{
  // Once reversed, the line must not be reversed again.
  const plan = planClawback({ candidates: [line({ status: "clawed_back" })], trigger: "refund", asOf: ASOF });
  ok("an already-clawed-back line is skipped", plan.skippedIds.includes("led1"));
  ok("...nothing voided", plan.voidIds.length === 0);
  ok("...nothing adjusted", plan.adjustments.length === 0);
}
{
  // A reversal row is not itself reversible — otherwise a repeated refund would
  // claw back the clawback and pay the rep for the refund.
  const plan = planClawback({
    candidates: [line({ status: "pending", entrySource: "clawback", commissionAmount: -100 })],
    trigger: "refund",
    asOf: ASOF,
  });
  ok("a clawback row is skipped", plan.skippedIds.includes("led1"));
  ok("...and is never voided", plan.voidIds.length === 0);
}

console.log("\n[nothing to reverse]");

{
  const plan = planClawback({ candidates: [line({ isProjection: true })], trigger: "refund", asOf: ASOF });
  ok("a projection is skipped (it is a forecast, not an entitlement)", plan.skippedIds.includes("led1"));
}
{
  const plan = planClawback({ candidates: [line({ commissionAmount: 0 })], trigger: "refund", asOf: ASOF });
  ok("a zero-value line is skipped", plan.skippedIds.includes("led1"));
}
{
  const plan = planClawback({ candidates: [], trigger: "refund", asOf: ASOF });
  ok("an empty candidate set is a no-op", plan.voidIds.length === 0 && plan.adjustments.length === 0);
  ok("...with nothing reversed", plan.totalReversed === 0);
}

console.log("\n[a mixed batch · the usual real-world case]");

{
  // One line already paid, one still pending, one already reversed.
  const plan = planClawback({
    candidates: [
      line({ id: "a", status: "paid", commissionAmount: 100 }),
      line({ id: "b", status: "pending", commissionAmount: 50 }),
      line({ id: "c", status: "clawed_back", commissionAmount: 25 }),
    ],
    trigger: "refund",
    asOf: ASOF,
  });
  ok("the paid one is adjusted", plan.adjustments.length === 1 && plan.adjustments[0].adjustmentOfEntryId === "a");
  ok("the pending one is voided", plan.voidIds.length === 1 && plan.voidIds[0] === "b");
  ok("the reversed one is skipped", plan.skippedIds.length === 1 && plan.skippedIds[0] === "c");
  // 100 (adjusted) + 50 (voided); the already-reversed 25 must not be counted
  // twice across two refund deliveries.
  ok("the total reverses only what was live", plan.totalReversed === 150);
}

console.log("\n[cancellation uses the same machinery]");

{
  const plan = planClawback({ candidates: [line({ status: "paid" })], trigger: "cancellation", asOf: ASOF });
  ok("labelled as a cancellation", plan.adjustments[0].ruleLabel.includes("cancellation"));
  ok("dated on the reversal date", plan.adjustments[0].dueDate === ASOF);
}

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
