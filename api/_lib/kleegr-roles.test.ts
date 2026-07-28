// Dependency-free tests for launch-token role mapping.
// Run via `tsx api/_lib/kleegr-roles.test.ts` (add to `npm test`).
//
// Reproduces the reported defect and locks in the fix:
//   • a Smart Productivity `subaccount_admin` must reach the ADMIN workspace,
//     not the limited Salesperson portal;
//   • Manager stays distinct;
//   • User/Viewer equivalence is asserted DELIBERATELY (documented product gap)
//     so a future read-only role has to update this test on purpose;
//   • the GoHighLevel vocabulary handled by mapKleegrRole() is unchanged;
//   • nothing unknown can ever reach `owner`.

import { mapLaunchTokenRole } from "./kleegr-roles.js";
import { mapKleegrRole, type AppRole } from "./kleegr.js";

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

// Mirrors homePathFor() in api/kleegr/launch.ts — kept here so the test asserts
// the USER-VISIBLE outcome (which workspace they land in), not just the string.
function homePathFor(role: AppRole): string {
  if (role === "owner") return "/agency";
  if (role === "admin" || role === "sales_manager") return "/";
  return "/portal";
}

function main() {
  // =========================================================================
  console.log("\n[launch role · the reported defect]");
  ok(
    "subaccount_admin → admin (was: salesperson)",
    mapLaunchTokenRole("subaccount_admin") === "admin",
  );
  ok(
    "subaccount_admin is NEVER salesperson",
    mapLaunchTokenRole("subaccount_admin") !== "salesperson",
  );
  ok(
    "subaccount_admin lands on the admin workspace, not /portal",
    homePathFor(mapLaunchTokenRole("subaccount_admin")) === "/",
  );
  ok(
    "subaccount_admin is NEVER auto-promoted to owner (even in an agency placement)",
    mapLaunchTokenRole("subaccount_admin", "agency") === "admin",
  );
  ok(
    "regression guard: the OLD mapper really did downgrade it",
    mapKleegrRole("subaccount_admin") === "salesperson",
  );

  // =========================================================================
  console.log("\n[launch role · full Smart Productivity tier table]");
  ok("agency_admin + agency → owner", mapLaunchTokenRole("agency_admin", "agency") === "owner");
  ok("agency_admin + sub_account → admin", mapLaunchTokenRole("agency_admin", "sub_account") === "admin");
  ok("manager → sales_manager", mapLaunchTokenRole("manager") === "sales_manager");
  ok("manager lands on the team workspace", homePathFor(mapLaunchTokenRole("manager")) === "/");
  ok("user → salesperson", mapLaunchTokenRole("user") === "salesperson");
  ok("user lands on /portal", homePathFor(mapLaunchTokenRole("user")) === "/portal");

  // =========================================================================
  console.log("\n[launch role · documented User/Viewer equivalence]");
  // SCM has no read-only role, and Smart Productivity's SCM_ROLE_DEFAULTS give
  // `user` and `viewer` an identical permission set. This is a KNOWN PRODUCT
  // GAP, asserted here so introducing a real read-only tier is a deliberate,
  // test-updating change rather than an accident.
  ok("viewer → salesperson (explicit, not the default branch)", mapLaunchTokenRole("viewer") === "salesperson");
  ok(
    "viewer and user are currently equivalent (documented gap)",
    mapLaunchTokenRole("viewer") === mapLaunchTokenRole("user"),
  );

  // =========================================================================
  console.log("\n[launch role · normalisation]");
  ok("case-insensitive", mapLaunchTokenRole("SUBACCOUNT_ADMIN") === "admin");
  ok("hyphen tolerated", mapLaunchTokenRole("subaccount-admin") === "admin");
  ok("space tolerated", mapLaunchTokenRole("sub account admin") === "admin");
  ok("surrounding whitespace tolerated", mapLaunchTokenRole("  manager ") === "sales_manager");

  // =========================================================================
  console.log("\n[launch role · GoHighLevel vocabulary is unchanged]");
  // Anything that is not a Smart Productivity tier key must delegate to the
  // existing mapper, so the gateway/user-sync path behaves exactly as before.
  for (const r of ["admin", "account_admin", "location_admin", "agency_owner", "owner", "user", "manager"]) {
    ok(
      `"${r}" delegates identically (sub_account)`,
      mapLaunchTokenRole(r, "sub_account") === mapKleegrRole(r, "sub_account"),
    );
  }
  ok("bare admin → admin", mapLaunchTokenRole("admin") === "admin");

  // =========================================================================
  console.log("\n[launch role · fail-safe]");
  ok("unknown → salesperson", mapLaunchTokenRole("superuser") === "salesperson");
  ok("empty → salesperson", mapLaunchTokenRole("") === "salesperson");
  ok("null → salesperson", mapLaunchTokenRole(null) === "salesperson");
  ok("undefined → salesperson", mapLaunchTokenRole(undefined) === "salesperson");
  ok("unknown is NEVER owner, even in an agency placement", mapLaunchTokenRole("root", "agency") !== "owner");
  ok("only agency_admin can ever reach owner", mapLaunchTokenRole("subaccount_admin", "agency") !== "owner");

  console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
