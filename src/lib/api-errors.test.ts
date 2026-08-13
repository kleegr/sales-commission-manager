// Tests for the API error → human sentence mapping.
// Run via `tsx src/lib/api-errors.test.ts` (wired into `npm test`).
//
// This matters more than it looks: a failed write no longer falls back to
// localStorage, so these strings are the entire explanation the user gets for
// why their change did not save. A raw code leaking through is a bug.
import { errorMessage, isLockedByPayout } from "./api-errors";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("\n[errorMessage · known codes get a sentence]");

const known = [
  "has_locked_commissions",
  "batch_total_mismatch",
  "batch_lines_changed",
  "entry_not_pending",
  "insufficient_balance",
  "separation_of_duties",
  "forbidden",
  "company_name_required",
  "snapshot_write_removed",
];
for (const code of known) {
  const msg = errorMessage(new Error(code));
  ok(`${code} maps to prose`, msg !== "" && !msg.includes("_"));
}

console.log("\n[errorMessage · accepts both a code string and a thrown Error]");

ok(
  "a bare string works",
  errorMessage("has_locked_commissions") === errorMessage(new Error("has_locked_commissions")),
);

console.log("\n[errorMessage · unknown input falls back, never leaks a code]");

ok("an unmapped code falls back", !errorMessage(new Error("wat_is_this")).includes("wat_is_this"));
ok("null falls back", errorMessage(null).length > 0);
ok("undefined falls back", errorMessage(undefined).length > 0);
ok("an object falls back", errorMessage({ nope: 1 }).length > 0);
ok("an empty message falls back", errorMessage(new Error("")).length > 0);
ok("a custom fallback is honoured", errorMessage(new Error("nope"), "custom") === "custom");

console.log("\n[isLockedByPayout · the one failure with a specific remedy]");

ok("detects the locked case", isLockedByPayout(new Error("has_locked_commissions")));
ok("...from a string too", isLockedByPayout("has_locked_commissions"));
ok("ignores other failures", !isLockedByPayout(new Error("forbidden")));
ok("ignores null", !isLockedByPayout(null));

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
