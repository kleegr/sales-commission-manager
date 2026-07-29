// Tenant-isolation tests for the agency-visibility decision.
// Run via `tsx api/_lib/agency-scope.test.ts` (wired into `npm test`).
import { resolveAgencyScope } from "./agency-scope.js";

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

console.log("\n[Agency · cross-tenant visibility]");

ok("owner of an agency tenant may see the agency", resolveAgencyScope("owner", "agency_demo") === "agency");
ok("owner with NO agency is confined to own tenant", resolveAgencyScope("owner", null) === "tenant");
ok("owner with empty agency id is confined to own tenant", resolveAgencyScope("owner", "") === "tenant");
ok("admin NEVER sees across the agency", resolveAgencyScope("admin", "agency_demo") === "tenant");
ok("sales_manager confined to own tenant", resolveAgencyScope("sales_manager", "agency_demo") === "tenant");
ok("salesperson confined to own tenant", resolveAgencyScope("salesperson", "agency_demo") === "tenant");
ok("affiliate confined to own tenant", resolveAgencyScope("affiliate", "agency_demo") === "tenant");
ok("unknown role confined to own tenant", resolveAgencyScope("whatever", "agency_demo") === "tenant");

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
