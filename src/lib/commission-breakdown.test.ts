// Tests for the step-by-step commission breakdown shown when a rep clicks a
// ledger amount.
// Run via `tsx src/lib/commission-breakdown.test.ts` (wired into `npm test`).
//
// The design decision under test: the breakdown DERIVES the explanation from
// the stored row rather than recomputing it. If it recomputed, it would explain
// what the rules say today and quietly disagree with a line priced under an
// older plan. `verified` is how a genuine mismatch surfaces instead of hiding.
import { buildBreakdown, findRule, formatRate, verifyAmount } from "./commission-breakdown";
import type { Client, CommissionEntry, CommissionPlan } from "../types";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const plan: CommissionPlan = {
  id: "plan1",
  name: "Standard",
  description: "",
  rules: [
    { id: "r_setup", type: "setup_fee", mode: "percentage", value: 10 },
    { id: "r_bonus", type: "signup_bonus", amount: 150 },
    { id: "r_res", type: "monthly_residual", startMonth: 1, endMonth: 3, continueForever: false, valueType: "percentage", value: 70 },
  ],
  sampleSetupFee: 1000,
  sampleMonthly: 200,
  createdAt: "2025-01-01",
};

const client: Client = {
  id: "cl1", companyName: "Northwind", contactName: "", email: "", phone: "",
  salespersonId: "sp1", signupDate: "2025-01-01", setupFee: 1000, monthlySubscription: 200,
  status: "active", canceledDate: null, notes: "", createdAt: "2025-01-01",
};

function entry(over: Partial<CommissionEntry> = {}): CommissionEntry {
  return {
    id: "led1",
    salespersonId: "sp1",
    clientId: "cl1",
    paymentId: "pay1",
    paymentDate: "2025-02-01",
    paymentType: "setup_fee",
    paymentAmount: 1000,
    ruleId: "r_setup",
    ruleType: "setup_fee",
    ruleLabel: "Setup fee · 10%",
    commissionValueType: "percentage",
    commissionValue: 10,
    commissionAmount: 100,
    status: "pending",
    dueDate: "2025-02-01",
    paidDate: null,
    notes: "",
    isProjection: false,
    createdAt: "2025-02-01",
    ...over,
  };
}

console.log("\n[findRule · id first, then type]");

ok("finds by id", findRule(plan, entry())?.id === "r_setup");
// A rule can be edited or replaced; falling back to type keeps the explanation
// useful rather than blank.
ok("falls back to type when the id is gone", findRule(plan, entry({ ruleId: "deleted" }))?.type === "setup_fee");
ok("no plan is tolerated", findRule(undefined, entry()) === undefined);

console.log("\n[formatRate]");

ok("a percentage reads as %", formatRate(entry()) === "10%");
ok("a fixed rate reads as money", formatRate(entry({ commissionValueType: "fixed", commissionValue: 150 })).includes("150"));

console.log("\n[verifyAmount · do the parts still make the total?]");

ok("a consistent percentage line verifies", verifyAmount(entry()));
// The whole point: a line priced under an older plan must be FLAGGED, not
// silently recomputed to today's rules.
ok("an inconsistent one does not", !verifyAmount(entry({ commissionAmount: 250 })));
ok("rounding within a cent is tolerated", verifyAmount(entry({ paymentAmount: 333.33, commissionAmount: 33.33 })));
ok("a fixed line is always consistent", verifyAmount(entry({ commissionValueType: "fixed", commissionValue: 150, commissionAmount: 150 })));

console.log("\n[buildBreakdown · a percentage setup fee]");

{
  const b = buildBreakdown(entry(), plan, client);
  ok("the formula shows the multiplication", b.formula.includes("10%") && b.formula.includes("1,000"));
  ok("names the client", b.steps[0].label.includes("Northwind"));
  ok("shows what was paid", b.steps[0].value?.includes("1,000") === true);
  ok("quotes the rule that fired", b.steps.some((s) => s.detail === "Setup fee · 10%"));
  ok("ends with the commission as the total", b.steps[b.steps.length - 1].total === true);
  ok("...worth $100", b.amount === 100);
  ok("marked verified", b.verified);
}

console.log("\n[buildBreakdown · a flat rule multiplies nothing]");

{
  const b = buildBreakdown(
    entry({ ruleId: "r_bonus", ruleType: "signup_bonus", ruleLabel: "Signup bonus", commissionValueType: "fixed", commissionValue: 150, commissionAmount: 150 }),
    plan,
    client,
  );
  ok("says so explicitly", b.steps.some((s) => (s.detail ?? "").includes("nothing is multiplied")));
  ok("the formula is just the amount", b.formula.includes("150") && !b.formula.includes("×"));
}

console.log("\n[buildBreakdown · a residual names the month band]");

{
  const b = buildBreakdown(
    entry({
      paymentType: "monthly_subscription", paymentAmount: 200, ruleId: "r_res",
      ruleType: "monthly_residual", ruleLabel: "Residual · Month 1–3 · 70%",
      commissionValue: 70, commissionAmount: 140,
    }),
    plan,
    client,
  );
  ok("the month band appears", b.steps.some((s) => (s.detail ?? "").includes("Month 1–3")));
  ok("the arithmetic is 70% of 200", b.formula.includes("70%") && b.formula.includes("200"));
  ok("the total is 140", b.amount === 140);
}

console.log("\n[buildBreakdown · salary is not tied to a client payment]");

{
  const b = buildBreakdown(
    entry({ ruleType: "salary", paymentType: "salary", clientId: null, paymentId: null, ruleLabel: "Weekly salary", commissionValueType: "fixed", commissionValue: 500, commissionAmount: 500, paymentAmount: 500 }),
    plan,
  );
  ok("explains it is not client-driven", b.steps[0].detail?.includes("not tied to a client") === true);
  ok("worth the salary amount", b.amount === 500);
}

console.log("\n[buildBreakdown · a clawback reads as a deduction]");

{
  const b = buildBreakdown(
    entry({
      commissionAmount: -100, ruleLabel: "Clawback (refund) · Setup fee · 10%",
      notes: "Reverses led1 after a refund.", status: "pending",
      commissionValueType: "fixed", commissionValue: -100,
    }),
    plan,
    client,
  );
  ok("titled as a clawback", b.title === "Clawback");
  ok("the formula is negative", b.formula.startsWith("−"));
  ok("the total says deducted", b.steps[b.steps.length - 1].label.includes("Deducted"));
  ok("...and is signed negative", b.steps[b.steps.length - 1].value?.startsWith("−") === true);
  ok("the reason is carried through", b.steps[0].detail?.includes("Reverses") === true);
}

console.log("\n[buildBreakdown · the timing explanation]");

{
  const b = buildBreakdown(entry({ status: "pending" }), plan, client);
  ok("pending is explained as available", b.timing[0].toLowerCase().includes("available"));
}
{
  const b = buildBreakdown(
    entry({ status: "held", holdReason: "Awaiting payment confirmation", timingTrigger: "after_days", releaseDate: "2025-03-03" }),
    plan, client,
  );
  ok("held is explained", b.timing[0].toLowerCase().includes("held"));
  ok("the hold reason is shown", b.timing.some((t) => t.includes("Awaiting payment confirmation")));
  ok("the release rule is named", b.timing.some((t) => t.includes("Release rule")));
  ok("the release date is given", b.timing.some((t) => t.includes("Becomes payable")));
}
{
  const b = buildBreakdown(entry({ status: "paid", paidDate: "2025-03-01" }), plan, client);
  ok("a paid line reports when", b.timing.some((t) => t.startsWith("Paid on")));
}
{
  const b = buildBreakdown(entry({ status: "held", releasedOverride: true }), plan, client);
  ok("an admin release is disclosed", b.timing.some((t) => t.includes("released this early")));
}
{
  const b = buildBreakdown(entry({ status: "clawed_back", clawbackReason: "Client refund" }), plan, client);
  ok("a clawed-back line explains itself", b.timing[0].toLowerCase().includes("clawed back"));
  ok("...with the reason", b.timing.some((t) => t === "Client refund"));
}

console.log("\n[buildBreakdown · degrades without context]");

{
  // Every number it needs is on the row, so it must still work with no plan and
  // no client — a manager looking at someone else's line, for instance.
  const b = buildBreakdown(entry());
  ok("still produces steps", b.steps.length >= 3);
  ok("still produces the total", b.amount === 100);
  ok("falls back to a generic subject", b.steps[0].label.includes("The client"));
}

console.log("\n[buildBreakdown · a mispriced line is flagged, not corrected]");

{
  const b = buildBreakdown(entry({ commissionAmount: 250 }), plan, client);
  ok("verified is false", b.verified === false);
  // The amount shown is the one that was actually booked.
  ok("the booked amount is still what is shown", b.amount === 250);
}

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
