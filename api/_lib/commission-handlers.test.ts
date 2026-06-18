// Dependency-free, DB-free tests for the commission handler helpers.
// Run via `tsx api/_lib/commission-handlers.test.ts` (wired into `npm test`).
import {
  canManagePlans,
  canManagePayments,
  canReleaseCommission,
  canRecomputeLedger,
  commissionReadScope,
  normalizeRule,
  normalizeRules,
  normalizePlanInput,
  normalizePlanTiming,
  normalizeOrderedIds,
  normalizePaymentInput,
  buildPaymentUpdate,
  parseLedgerFilters,
  normalizeIdList,
} from "./commission-handlers.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}`);
  }
}

console.log("\n[Commission \u00b7 authorization]");
ok("owner can manage plans", canManagePlans("owner" as any));
ok("admin can manage plans", canManagePlans("admin" as any));
ok("manager CANNOT manage plans", !canManagePlans("sales_manager" as any));
ok("salesperson CANNOT manage plans", !canManagePlans("salesperson" as any));

ok("owner can manage payments", canManagePayments("owner" as any));
ok("manager can manage payments", canManagePayments("sales_manager" as any));
ok("salesperson can manage payments (scope-checked)", canManagePayments("salesperson" as any));

ok("owner can release", canReleaseCommission("owner" as any));
ok("manager CANNOT release", !canReleaseCommission("sales_manager" as any));
ok("owner can recompute", canRecomputeLedger("owner" as any));
ok("salesperson CANNOT recompute", !canRecomputeLedger("salesperson" as any));

ok("owner read scope = all", commissionReadScope("owner" as any) === "all");
ok("manager read scope = team", commissionReadScope("sales_manager" as any) === "team");
ok("affiliate read scope = self", commissionReadScope("affiliate" as any) === "self");

console.log("\n[Commission \u00b7 rule validation]");
const rBad = normalizeRule({ type: "nope" });
ok("invalid rule type rejected", !rBad.ok);
const rSetup = normalizeRule({ type: "setup_fee", mode: "percentage", value: "15" });
ok("setup_fee coerces value", rSetup.ok && rSetup.value.type === "setup_fee" && (rSetup.value as any).value === 15);
ok("setup_fee gets an id", rSetup.ok && !!rSetup.value.id);
const rSetupKeepId = normalizeRule({ id: "keep_me", type: "setup_fee", mode: "fixed", value: 200 });
ok("existing rule id preserved", rSetupKeepId.ok && rSetupKeepId.value.id === "keep_me");
const rBonus = normalizeRule({ type: "signup_bonus", amount: "250" });
ok("signup_bonus coerces amount", rBonus.ok && (rBonus.value as any).amount === 250);
const rRes = normalizeRule({ type: "monthly_residual", startMonth: 3, endMonth: 1, continueForever: false, valueType: "fixed", value: 50 });
ok("residual clamps endMonth up to startMonth", rRes.ok && (rRes.value as any).endMonth === 3);
const rResForever = normalizeRule({ type: "monthly_residual", startMonth: 2, endMonth: 9, continueForever: true, valueType: "percentage", value: 40 });
ok("residual continueForever nulls endMonth", rResForever.ok && (rResForever.value as any).endMonth === null);
const rSalary = normalizeRule({ type: "salary", weeklyAmount: 1000, startDate: "2025-01-01", maxWeeks: "12" });
ok("salary keeps fields", rSalary.ok && (rSalary.value as any).weeklyAmount === 1000 && (rSalary.value as any).maxWeeks === 12);

const rulesBad = normalizeRules({ not: "an array" });
ok("rules must be an array", !rulesBad.ok);
const rulesOk = normalizeRules([{ type: "setup_fee", mode: "none", value: 0 }, { type: "signup_bonus", amount: 10 }]);
ok("valid rules array accepted", rulesOk.ok && rulesOk.value.length === 2);
const rulesNull = normalizeRules(undefined);
ok("undefined rules -> empty array", rulesNull.ok && rulesNull.value.length === 0);
const rulesOneBad = normalizeRules([{ type: "setup_fee", mode: "none", value: 0 }, { type: "bogus" }]);
ok("one bad rule fails the whole array", !rulesOneBad.ok);

console.log("\n[Commission \u00b7 plan validation]");
const pEmpty = normalizePlanInput({});
ok("empty name -> Untitled plan", pEmpty.ok && pEmpty.value.name === "Untitled plan");
ok("no rules key -> rules omitted", pEmpty.ok && pEmpty.value.rules === undefined);
const pReq = normalizePlanInput({ name: "Std" }, { requireRules: true });
ok("requireRules -> rules present (empty)", pReq.ok && Array.isArray(pReq.value.rules) && pReq.value.rules!.length === 0);
const pWithRules = normalizePlanInput({ name: "Std", sampleSetupFee: "2500", sampleMonthly: 250, rules: [{ type: "signup_bonus", amount: 100 }] });
ok("plan coerces samples + rules", pWithRules.ok && pWithRules.value.sampleSetupFee === 2500 && pWithRules.value.rules!.length === 1);
const pBadRules = normalizePlanInput({ name: "Std", rules: [{ type: "weird" }] });
ok("plan rejects bad rule", !pBadRules.ok);

ok("default timing -> undefined", normalizePlanTiming({ trigger: "immediate", requireActiveClient: false, clawbackBeforeMonths: 0 }) === undefined);
ok("null timing -> undefined", normalizePlanTiming(null) === undefined);
const tCustom = normalizePlanTiming({ trigger: "after_days", days: 30 });
ok("custom timing kept", !!tCustom && tCustom.trigger === "after_days" && tCustom.days === 30);
const tActive = normalizePlanTiming({ trigger: "immediate", requireActiveClient: true });
ok("active-only is non-default", !!tActive && tActive.requireActiveClient === true);

const ordBad = normalizeOrderedIds({});
ok("reorder needs ids", !ordBad.ok);
const ordOk = normalizeOrderedIds({ orderedIds: ["a", "b", "c"] });
ok("reorder ids accepted", ordOk.ok && ordOk.value.length === 3);

console.log("\n[Commission \u00b7 payment validation]");
const payNoClient = normalizePaymentInput({ amount: 100 });
ok("payment needs a client", !payNoClient.ok && payNoClient.error === "client_required");
const paySetup = normalizePaymentInput({ clientId: "cl1", type: "setup_fee", amount: "1000" });
ok("setup payment: no payment number", paySetup.ok && paySetup.value.paymentNumber === null && paySetup.value.amount === 1000);
const payMonthly = normalizePaymentInput({ clientId: "cl1", type: "monthly_subscription", amount: 200 });
ok("monthly payment defaults number to 1", payMonthly.ok && payMonthly.value.paymentNumber === 1);
const payMonthlyN = normalizePaymentInput({ clientId: "cl1", type: "monthly_subscription", amount: 200, paymentNumber: 5 });
ok("monthly payment keeps its number", payMonthlyN.ok && payMonthlyN.value.paymentNumber === 5);
const payBadType = normalizePaymentInput({ clientId: "cl1", type: "bribe", amount: 1 });
ok("bad payment type falls back to monthly", payBadType.ok && payBadType.value.type === "monthly_subscription");
const payNegAmt = normalizePaymentInput({ clientId: "cl1", type: "refund", amount: -50 });
ok("negative amount floored to 0", payNegAmt.ok && payNegAmt.value.amount === 0);
const payDefaultsDate = normalizePaymentInput({ clientId: "cl1", type: "adjustment", amount: 0 });
ok("missing date defaults to today (yyyy-mm-dd)", payDefaultsDate.ok && /^\d{4}-\d{2}-\d{2}$/.test(payDefaultsDate.value.date));

console.log("\n[Commission \u00b7 payment patch]");
const upEmpty = buildPaymentUpdate({});
ok("empty payment patch rejected", !upEmpty.ok);
const upNotes = buildPaymentUpdate({ notes: "late" });
ok("notes-only patch is NOT commission-affecting", upNotes.ok && upNotes.value.commissionAffecting.length === 0);
const upAmount = buildPaymentUpdate({ amount: 300 });
ok("amount patch IS commission-affecting", upAmount.ok && upAmount.value.commissionAffecting.includes("amount"));
ok("patch maps amount + updated_at", upAmount.ok && (upAmount.value.set as any).amount === 300 && "updated_at" in upAmount.value.set);
const upClient = buildPaymentUpdate({ clientId: "cl2" });
ok("clientId patch maps to client_id + is commission-affecting", upClient.ok && (upClient.value.set as any).client_id === "cl2" && upClient.value.commissionAffecting.includes("client_id"));
const upBlankClient = buildPaymentUpdate({ clientId: "" });
ok("blank clientId patch rejected", !upBlankClient.ok);

console.log("\n[Commission \u00b7 ledger filters + id list]");
const f = parseLedgerFilters({ salespersonId: "sp1", status: "held", from: "2025-01-01", to: "2025-12-31" });
ok("filters parsed", f.salespersonId === "sp1" && f.status === "held" && f.from === "2025-01-01" && f.to === "2025-12-31");
const fBadStatus = parseLedgerFilters({ status: "banana" });
ok("invalid status dropped", fBadStatus.status === null);
const fEmpty = parseLedgerFilters({});
ok("empty filters -> all null", fEmpty.salespersonId === null && fEmpty.clientId === null && fEmpty.status === null);

const idBad = normalizeIdList({});
ok("id list required", !idBad.ok);
const idOk = normalizeIdList({ ids: ["a", "b"] });
ok("id list accepted", idOk.ok && idOk.value.length === 2);
const idAlt = normalizeIdList({ commissionEntryIds: ["x"] });
ok("commissionEntryIds alias accepted", idAlt.ok && idAlt.value.length === 1);

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
