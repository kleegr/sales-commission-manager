// Dependency-free, DB-free tests for role landing + route access.
// Run via `tsx src/lib/roles.test.ts` (wired into `npm test`).
//
// These lock in the fix for the "Agency Owner looks like a Salesperson / is
// missing the agency dashboard" bug: the agency owner (role "owner") must land
// on the agency portal, never on the single-sub-account Dashboard, and every
// role must be able to reach its own home (no guard redirect loops).
import { homePath, canAccess, ROLE_LABEL, type Role } from "./roles";

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

const ALL_ROLES: Role[] = [
  "owner",
  "admin",
  "sales_manager",
  "salesperson",
  "affiliate",
  "partner",
];

console.log("\n[Roles \u00b7 homePath]");
ok("agency owner lands on the agency portal", homePath("owner") === "/agency");
ok("owner does NOT land on the single-tenant dashboard", homePath("owner") !== "/");
ok("sub-account admin lands on the dashboard/workspace", homePath("admin") === "/");
ok("sales manager lands on the (team) dashboard", homePath("sales_manager") === "/");
ok("salesperson lands on the self-service portal", homePath("salesperson") === "/portal");
ok("affiliate lands on the portal", homePath("affiliate") === "/portal");
ok("partner lands on the portal", homePath("partner") === "/portal");

console.log("\n[Roles \u00b7 no redirect loop: every role can reach its own home]");
for (const r of ALL_ROLES) {
  // The route guard redirects a role to homePath(role) when it can't see a
  // page; if a role could not access its OWN home this would loop forever and
  // land it in the wrong portal (the exact failure mode of the original bug).
  ok(`canAccess(${r}, homePath(${r}))`, canAccess(r, homePath(r)));
}

console.log("\n[Roles \u00b7 canAccess: agency vs single sub-account]");
ok("owner may NOT take the single-tenant dashboard route", !canAccess("owner", "/"));
ok("owner may see the agency portal", canAccess("owner", "/agency"));
ok("admin may see the agency portal (own sub-account scope)", canAccess("admin", "/agency"));
ok("admin may see the dashboard", canAccess("admin", "/"));
ok("manager may see the dashboard", canAccess("sales_manager", "/"));
ok("manager may NOT see the agency portal", !canAccess("sales_manager", "/agency"));
ok("salesperson may NOT see the agency portal", !canAccess("salesperson", "/agency"));
ok("salesperson may NOT see the dashboard", !canAccess("salesperson", "/"));
ok("affiliate may NOT see the agency portal", !canAccess("affiliate", "/agency"));

console.log("\n[Roles \u00b7 canAccess: portals are role-correct]");
ok("salesperson may see their portal", canAccess("salesperson", "/portal"));
ok("affiliate may see the portal", canAccess("affiliate", "/portal"));
ok("partner may see the portal", canAccess("partner", "/portal"));
ok("owner may NOT take the salesperson portal route", !canAccess("owner", "/portal"));
ok("admin may NOT take the salesperson portal route", !canAccess("admin", "/portal"));

console.log("\n[Roles \u00b7 canAccess: shared + admin-only routes]");
ok("payouts visible to every role", ALL_ROLES.every((r) => canAccess(r, "/payouts")));
ok("documents visible to every role", ALL_ROLES.every((r) => canAccess(r, "/documents")));
ok("settings is owner/admin only", canAccess("owner", "/settings") && canAccess("admin", "/settings"));
ok("settings hidden from manager", !canAccess("sales_manager", "/settings"));
ok("settings hidden from salesperson", !canAccess("salesperson", "/settings"));
ok("people is owner/admin only", canAccess("owner", "/people") && !canAccess("sales_manager", "/people"));

console.log("\n[Roles \u00b7 canAccess: detail routes inherit their parent]");
ok("/plans/new inherits /plans (owner allowed)", canAccess("owner", "/plans/new"));
ok("/plans/:id/edit inherits /plans (salesperson denied)", !canAccess("salesperson", "/plans/abc/edit"));
ok("/clients/:id inherits /clients (manager allowed)", canAccess("sales_manager", "/clients/c_1"));
ok("/people/:id inherits /people (manager denied)", !canAccess("sales_manager", "/people/sp_1"));
ok("unknown route denied by default", !canAccess("owner", "/totally-unknown"));

console.log("\n[Roles \u00b7 labels]");
ok("owner is labelled 'Agency Owner'", ROLE_LABEL.owner === "Agency Owner");
ok("every role has a non-empty label", ALL_ROLES.every((r) => typeof ROLE_LABEL[r] === "string" && ROLE_LABEL[r].length > 0));

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
