// DB-free tests for the client input validation that backs POST/PATCH
// /api/clients — the per-resource endpoint that replaced the client half of the
// retired `PUT /api/state` snapshot.
//
// The important behaviour here is not "is the string trimmed": it is which
// fields are COMMISSION-AFFECTING, because that list is what tells the endpoint
// when it must recompute the ledger. Miss one and the ledger silently drifts
// away from the client row it is derived from.
//
// Run via `tsx api/_lib/clients-core.test.ts` (wired into `npm test`).
import {
  buildClientUpdate,
  isEndedClientStatus,
  normalizeClientInput,
  resolveCanceledDate,
} from "./commission-handlers.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const TODAY = "2025-06-01";

console.log("\n[client status helpers]");

ok("canceled has ended", isEndedClientStatus("canceled"));
ok("refunded has ended", isEndedClientStatus("refunded"));
ok("active has not", !isEndedClientStatus("active"));
ok("paused has not", !isEndedClientStatus("paused"));

console.log("\n[resolveCanceledDate · the clawback window anchor]");

ok("canceled with no date stamps today", resolveCanceledDate("canceled", null, TODAY) === TODAY);
ok("refunded with no date stamps today", resolveCanceledDate("refunded", "", TODAY) === TODAY);
// An admin backdating a cancellation must win — the clawback window is measured
// from when the client actually left, not from when somebody recorded it.
ok("an explicit date wins", resolveCanceledDate("canceled", "2025-03-15", TODAY) === "2025-03-15");
ok("active clears the date", resolveCanceledDate("active", "2025-03-15", TODAY) === null);
ok("paused clears the date", resolveCanceledDate("paused", "2025-03-15", TODAY) === null);

console.log("\n[normalizeClientInput · create]");

{
  const r = normalizeClientInput({ companyName: "  Acme  " }, TODAY);
  ok("accepts a minimal payload", r.ok);
  if (r.ok) {
    ok("trims the company name", r.value.companyName === "Acme");
    ok("defaults the signup date to today", r.value.signupDate === TODAY);
    ok("defaults to active", r.value.status === "active");
    ok("defaults fees to zero", r.value.setupFee === 0 && r.value.monthlySubscription === 0);
    ok("no rep by default", r.value.salespersonId === null);
    ok("no cancellation date while active", r.value.canceledDate === null);
  }
}
{
  const r = normalizeClientInput({}, TODAY);
  ok("a missing company name is rejected", !r.ok && r.error === "company_name_required");
}
{
  const r = normalizeClientInput({ companyName: "A", status: "exploded" }, TODAY);
  ok("an unknown status falls back to active", r.ok && r.value.status === "active");
}
{
  const r = normalizeClientInput({ companyName: "A", setupFee: -50, monthlySubscription: "abc" }, TODAY);
  ok("a negative fee is refused, not stored", r.ok && r.value.setupFee === 0);
  ok("a non-numeric fee is refused, not stored", r.ok && r.value.monthlySubscription === 0);
}
{
  const r = normalizeClientInput({ companyName: "A", status: "canceled" }, TODAY);
  ok("creating as canceled stamps the date", r.ok && r.value.canceledDate === TODAY);
}

console.log("\n[buildClientUpdate · partial patches]");

{
  const r = buildClientUpdate({}, TODAY);
  ok("an empty patch is rejected", !r.ok && r.error === "no_fields_to_update");
}
{
  const r = buildClientUpdate({ notes: "called back" }, TODAY);
  ok("a notes-only patch is allowed", r.ok);
  // Notes cannot change a number the engine produces, so no recompute.
  ok("...and is NOT commission-affecting", r.ok && r.value.commissionAffecting.length === 0);
  ok("...and is not a reassignment", r.ok && r.value.reassignedTo === undefined);
}
{
  const r = buildClientUpdate({ companyName: "" }, TODAY);
  ok("blanking the company name is rejected", !r.ok && r.error === "company_name_required");
}

console.log("\n[buildClientUpdate · what forces a recompute]");

for (const [key, value] of [
  ["salespersonId", "sp2"],
  ["signupDate", "2025-02-02"],
  ["setupFee", 999],
  ["monthlySubscription", 42],
  ["status", "paused"],
] as const) {
  const r = buildClientUpdate({ [key]: value }, TODAY);
  ok(`${key} is commission-affecting`, r.ok && r.value.commissionAffecting.length > 0);
}

{
  const r = buildClientUpdate({ salespersonId: "sp2" }, TODAY);
  ok("a reassignment is reported to the endpoint", r.ok && r.value.reassignedTo === "sp2");
  const cleared = buildClientUpdate({ salespersonId: "" }, TODAY);
  ok("unassigning reports null (not undefined)", cleared.ok && cleared.value.reassignedTo === null);
}

console.log("\n[buildClientUpdate · status and cancellation move together]");

{
  // Setting the status must also settle the date, or the clawback window is
  // measured from a value that belongs to a previous cancellation.
  const r = buildClientUpdate({ status: "canceled" }, TODAY);
  ok("canceling stamps today", r.ok && r.value.set.canceled_date === TODAY);
  ok("...and both columns are written", r.ok && r.value.set.status === "canceled");
}
{
  const r = buildClientUpdate({ status: "canceled", canceledDate: "2025-04-01" }, TODAY);
  ok("an explicit cancellation date wins", r.ok && r.value.set.canceled_date === "2025-04-01");
}
{
  const r = buildClientUpdate({ status: "active", canceledDate: "2025-04-01" }, TODAY);
  ok("reactivating clears a stale date", r.ok && r.value.set.canceled_date === null);
}
{
  const r = buildClientUpdate({ canceledDate: "2025-04-01" }, TODAY);
  ok("a date-only patch is allowed", r.ok && r.value.set.canceled_date === "2025-04-01");
  ok("...and is commission-affecting", r.ok && r.value.commissionAffecting.includes("canceled_date"));
}

console.log("\n[buildClientUpdate · every patch stamps updated_at]");
{
  const r = buildClientUpdate({ notes: "x" }, TODAY);
  ok("updated_at is set", r.ok && typeof r.value.set.updated_at === "string");
}

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
