// Money-path authorization tests for the payout workflow (H-3 + separation of
// duties). Pure decision logic, no DB. Run via `tsx api/_lib/payouts-authz.test.ts`.
import { roleMayTransition, mayActOnBatch, violatesSeparationOfDuties } from "./payouts.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

console.log("\n[Payouts · role gate]");
ok("owner may approve", roleMayTransition("approve", "owner") === true);
ok("admin may mark_paid", roleMayTransition("mark_paid", "admin") === true);
ok("manager may approve/reject", roleMayTransition("approve", "sales_manager") === true && roleMayTransition("reject", "sales_manager") === true);
ok("manager may NOT mark_paid", roleMayTransition("mark_paid", "sales_manager") === false);
ok("manager may NOT cancel", roleMayTransition("cancel", "sales_manager") === false);
ok("salesperson may do nothing", roleMayTransition("approve", "salesperson") === false && roleMayTransition("mark_paid", "salesperson") === false);

console.log("\n[Payouts · team scope (H-3)]");
ok("owner acts on any batch", mayActOnBatch("owner", new Set<string>(), "sp_x") === true);
ok("admin acts on any batch", mayActOnBatch("admin", new Set<string>(), "sp_x") === true);
ok("manager acts on OWN team's batch", mayActOnBatch("sales_manager", new Set(["sp_a", "sp_b"]), "sp_a") === true);
ok("manager CANNOT act on another team's batch", mayActOnBatch("sales_manager", new Set(["sp_a"]), "sp_b") === false);
ok("manager with empty team acts on nothing", mayActOnBatch("sales_manager", new Set<string>(), "sp_a") === false);

console.log("\n[Payouts · separation of duties]");
ok("manager cannot approve a batch they submitted", violatesSeparationOfDuties("approve", "sales_manager", "u_mgr", "u_mgr") === true);
ok("manager CAN approve a batch someone else submitted", violatesSeparationOfDuties("approve", "sales_manager", "u_other", "u_mgr") === false);
ok("admin cannot approve their own submission", violatesSeparationOfDuties("approve", "admin", "u_admin", "u_admin") === true);
ok("owner is exempt (solo operator)", violatesSeparationOfDuties("approve", "owner", "u_owner", "u_owner") === false);
ok("reject is never a separation-of-duties violation", violatesSeparationOfDuties("reject", "sales_manager", "u_mgr", "u_mgr") === false);
ok("no recorded submitter -> no violation", violatesSeparationOfDuties("approve", "sales_manager", null, "u_mgr") === false);

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
