// DB-free tests for the rep balance reconciliation that backs self-service
// withdrawals.
// Run via `tsx api/_lib/balance.test.ts` (wired into `npm test`).
//
// The invariant under test: every dollar lands in EXACTLY ONE bucket. Money
// that has already been paid is never subtracted again (that would charge the
// rep twice for the same payment), money claimed by a batch is never counted as
// available (that would let them claim it twice), and a clawback always reduces
// what they can draw (otherwise a refund is silently forgiven).
import {
  computeBalance,
  selectWithdrawalEntries,
  MIN_WITHDRAWAL,
  type BalanceRow,
} from "./balance.js";
import type { CommissionStatus } from "../../src/types/index.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

let seq = 0;
function row(over: Partial<BalanceRow> = {}): BalanceRow {
  seq++;
  return {
    id: `led${seq}`,
    commissionAmount: 100,
    status: "pending",
    isProjection: false,
    ruleType: "monthly_residual",
    entrySource: "engine",
    payoutBatchId: null,
    paymentDate: `2025-01-${String(seq).padStart(2, "0")}`,
    ...over,
  };
}

console.log("\n[computeBalance · the pending pool is what is withdrawable]");

{
  const b = computeBalance([row({ commissionAmount: 100 }), row({ commissionAmount: 50 })]);
  ok("pending commission sums", b.commission === 150);
  ok("available equals it", b.available === 150);
  ok("no salary", b.salary === 0);
  ok("no deductions", b.deductions === 0);
  ok("both lines are drawable", b.availableEntryIds.length === 2);
}

console.log("\n[computeBalance · salary is money the rep is owed too]");

{
  const b = computeBalance([
    row({ commissionAmount: 100 }),
    row({ commissionAmount: 400, ruleType: "salary" }),
  ]);
  ok("salary is its own bucket", b.salary === 400);
  ok("commission excludes it", b.commission === 100);
  ok("both are available", b.available === 500);
}

console.log("\n[computeBalance · clawbacks reduce what can be drawn]");

{
  const b = computeBalance([
    row({ commissionAmount: 100 }),
    row({ commissionAmount: -30, entrySource: "clawback" }),
  ]);
  ok("the deduction is reported positive", b.deductions === 30);
  ok("...and is netted off", b.available === 70);
  ok("...and is NOT in the drawable lines", b.availableEntryIds.length === 1);
}
{
  // A rep can owe more than they have earned. The balance says so honestly and
  // floors the withdrawable figure at zero rather than going negative.
  const b = computeBalance([
    row({ commissionAmount: 20 }),
    row({ commissionAmount: -100, entrySource: "clawback" }),
  ]);
  ok("net goes negative", b.net === -80);
  ok("...but available floors at 0", b.available === 0);
}

console.log("\n[computeBalance · money already claimed or paid is not available]");

{
  const b = computeBalance([
    row({ commissionAmount: 100, status: "submitted" }),
    row({ commissionAmount: 200, status: "approved" }),
  ]);
  // Submitting moves a line out of the pending pool, so it cannot also be
  // available — that is how a rep would claim the same money twice.
  ok("submitted + approved are awaiting approval", b.awaitingApproval === 300);
  ok("...and are not available", b.available === 0);
}
{
  const b = computeBalance([
    row({ commissionAmount: 500, status: "paid" }),
    row({ commissionAmount: 400, status: "paid", ruleType: "salary" }),
    row({ commissionAmount: 100 }),
  ]);
  ok("paid is reported for context", b.paidToDate === 900);
  ok("...with the salary part called out", b.salaryPaidToDate === 400);
  // Subtracting money that already left the business would charge the rep twice.
  ok("...and is NOT subtracted from available", b.available === 100);
}

console.log("\n[computeBalance · unearned money is never withdrawable]");

{
  const b = computeBalance([
    row({ commissionAmount: 100, status: "held" }),
    row({ commissionAmount: 250, status: "projected", isProjection: true }),
    row({ commissionAmount: 60 }),
  ]);
  ok("held is not available", b.notYetReleased >= 100);
  ok("a projection is not available", b.available === 60);
}
{
  const b = computeBalance([
    row({ commissionAmount: 100, status: "rejected" }),
    row({ commissionAmount: 100, status: "canceled" }),
    row({ commissionAmount: 100, status: "clawed_back" }),
  ]);
  ok("settled statuses contribute nothing", b.available === 0 && b.net === 0);
}

console.log("\n[computeBalance · drawable lines are oldest first]");

{
  const a = row({ id: "new", paymentDate: "2025-05-01" });
  const b = row({ id: "old", paymentDate: "2025-01-01" });
  const out = computeBalance([a, b]);
  ok("the longest-waiting line comes first", out.availableEntryIds[0] === "old");
}

console.log("\n[selectWithdrawalEntries · drawing the whole balance]");

{
  const rows = [row({ id: "a", commissionAmount: 100 }), row({ id: "b", commissionAmount: 50 })];
  const b = computeBalance(rows);
  const sel = selectWithdrawalEntries(b, rows, null);
  ok("null amount means everything", sel.ok && sel.amount === 150);
  ok("...claiming every line", sel.ok && sel.entryIds.length === 2);
  ok("...and is not partial", sel.ok && sel.partial === false);
}
{
  // Drawing everything must settle the clawback in the same batch, so the rep
  // cannot leave the deduction behind and take only the positives.
  const rows = [
    row({ id: "pos", commissionAmount: 100 }),
    row({ id: "neg", commissionAmount: -30, entrySource: "clawback" }),
  ];
  const b = computeBalance(rows);
  const sel = selectWithdrawalEntries(b, rows, null);
  ok("the deduction rides along", sel.ok && sel.entryIds.includes("neg"));
  ok("...so the batch total is the net", sel.ok && sel.amount === 70);
}
{
  // Asking for more than the balance is not an error — it is "pay me out".
  const rows = [row({ id: "a", commissionAmount: 100 })];
  const b = computeBalance(rows);
  const sel = selectWithdrawalEntries(b, rows, 5_000);
  ok("an over-ask is capped at the balance", sel.ok && sel.amount === 100);
}

console.log("\n[selectWithdrawalEntries · partial draws take WHOLE lines]");

{
  // A ledger line cannot be half-paid without inventing a split the ledger,
  // the audit trail and the recompute would all have to model.
  const rows = [
    row({ id: "a", commissionAmount: 100, paymentDate: "2025-01-01" }),
    row({ id: "b", commissionAmount: 50, paymentDate: "2025-02-01" }),
    row({ id: "c", commissionAmount: 25, paymentDate: "2025-03-01" }),
  ];
  const b = computeBalance(rows);
  const sel = selectWithdrawalEntries(b, rows, 120);
  ok("takes whole lines only", sel.ok && sel.amount === 100);
  ok("...oldest first", sel.ok && sel.entryIds[0] === "a");
  ok("...and reports the shortfall as partial", sel.ok && sel.partial === true);
}
{
  const rows = [row({ id: "a", commissionAmount: 100 })];
  const b = computeBalance(rows);
  const sel = selectWithdrawalEntries(b, rows, 40);
  // Every line is larger than the request: refuse rather than overpay.
  ok("an unsplittable request is refused", !sel.ok && sel.error === "below_minimum");
}

console.log("\n[selectWithdrawalEntries · refusals]");

{
  const b = computeBalance([]);
  ok("an empty ledger has nothing to submit", !selectWithdrawalEntries(b, [], null).ok);
}
{
  const rows = [row({ commissionAmount: 100, status: "submitted" })];
  const b = computeBalance(rows);
  const sel = selectWithdrawalEntries(b, rows, null);
  ok("everything already claimed refuses", !sel.ok && sel.error === "nothing_to_submit");
}
{
  const rows = [
    row({ id: "pos", commissionAmount: 100 }),
    row({ id: "neg", commissionAmount: -100, entrySource: "clawback" }),
  ];
  const b = computeBalance(rows);
  const sel = selectWithdrawalEntries(b, rows, null);
  // Positives exist, but the clawback cancels them: there is nothing to pay.
  ok("a fully-clawed-back balance refuses", !sel.ok && sel.error === "insufficient_balance");
}
{
  const rows = [row({ id: "a", commissionAmount: 100 })];
  const b = computeBalance(rows);
  const sel = selectWithdrawalEntries(b, rows, MIN_WITHDRAWAL - 0.5);
  ok("below the minimum refuses", !sel.ok && sel.error === "below_minimum");
}

console.log("\n[computeBalance · a full realistic ledger reconciles]");

{
  const rows: BalanceRow[] = [
    row({ commissionAmount: 250, status: "paid" }),
    row({ commissionAmount: 400, status: "paid", ruleType: "salary" }),
    row({ commissionAmount: 120, status: "submitted" }),
    row({ commissionAmount: 80, status: "held" }),
    row({ commissionAmount: 300, status: "projected", isProjection: true }),
    row({ commissionAmount: 200 }),
    row({ commissionAmount: 400, ruleType: "salary" }),
    row({ commissionAmount: -50, entrySource: "clawback" }),
  ];
  const b = computeBalance(rows);
  ok("commission = 200", b.commission === 200);
  ok("salary = 400", b.salary === 400);
  ok("deductions = 50", b.deductions === 50);
  ok("available = 550", b.available === 550);
  ok("awaiting approval = 120", b.awaitingApproval === 120);
  ok("paid to date = 650", b.paidToDate === 650);
  // Nothing is counted twice: available + awaiting + paid + unreleased covers
  // every live dollar, with deductions accounted for inside `available`.
  const accountedFor = b.net + b.deductions + b.awaitingApproval + b.paidToDate + b.notYetReleased;
  const total = rows
    .filter((r) => r.status !== "clawed_back" && r.commissionAmount > 0)
    .reduce((s, r) => s + r.commissionAmount, 0);
  ok("every positive dollar is accounted for exactly once", accountedFor === total);
}

const statuses: CommissionStatus[] = [
  "projected", "held", "pending", "submitted", "approved", "paid", "rejected", "canceled", "clawed_back",
];
console.log("\n[computeBalance · every status is handled]");
for (const status of statuses) {
  const b = computeBalance([row({ status, isProjection: status === "projected" })]);
  const total = b.available + b.awaitingApproval + b.paidToDate + b.notYetReleased;
  ok(`${status} does not vanish or double-count`, total === 100 || total === 0);
}

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
