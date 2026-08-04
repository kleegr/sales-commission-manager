// Tests for the client-side Bearer-token interceptor rule.
// Run via `tsx src/lib/api-auth.test.ts` (wired into `npm test`).
import { shouldAttachBearer } from "./api-auth";

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

const ORIGIN = "https://sales-commission-manager.vercel.app";
const attach = (url: string) => shouldAttachBearer(url, ORIGIN);

console.log("\n[API auth · attaches to same-origin /api calls]");

ok("relative /api/auth/me", attach("/api/auth/me"));
ok("relative /api/state", attach("/api/state"));
ok("with a query string", attach("/api/salespeople?id=abc"));
ok("nested path", attach("/api/kleegr/status"));
ok("absolute same-origin URL", attach(`${ORIGIN}/api/state`));

console.log("\n[API auth · never leaks the token off-origin]");

ok("cross-origin API is skipped", !attach("https://api.example.com/api/state"));
ok("Kleegr's own host is skipped", !attach("https://crm.kleegr.com/api/plugins/verify"));
ok("the parent host is skipped", !attach("https://smart-productivity-pied.vercel.app/api/state"));
ok("protocol-relative off-origin is skipped", !attach("//evil.example/api/state"));
ok("an unparseable URL is skipped", !attach("http://["));

console.log("\n[API auth · leaves non-API requests alone]");

ok("the SPA shell", !attach("/"));
ok("a client route", !attach("/portal?kleegr=connected"));
ok("a static asset", !attach("/assets/index-abc123.js"));
ok("a path that merely starts with 'api'", !attach("/apidocs"));

console.log("\n[API auth · Kleegr launch-token endpoints stay exempt]");

// On these two, `Authorization: Bearer …` means a short-lived KLEEGR LAUNCH
// TOKEN, not an SCM session — overwriting it would break the gateway sync.
ok("/api/kleegr/launch exempt", !attach("/api/kleegr/launch"));
ok("/api/kleegr/launch with a token query exempt", !attach("/api/kleegr/launch?token=xyz"));
ok("/api/kleegr/sync exempt", !attach("/api/kleegr/sync"));
ok("other /api/kleegr/* endpoints are NOT exempt", attach("/api/kleegr/status"));
ok("...including test-connection", attach("/api/kleegr/test-connection"));

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
