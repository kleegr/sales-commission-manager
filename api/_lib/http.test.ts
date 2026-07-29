// Tests for the CSRF + rate-limit decision logic (pure parts).
// Run via `tsx api/_lib/http.test.ts` (wired into `npm test`).
import { csrfOk } from "./http.js";
import { overLimit, LOGIN_MAX_FAILURES } from "./rate-limit.js";

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

const mk = (method: string, headers: Record<string, string>) =>
  ({ method, headers }) as any;

console.log("\n[HTTP · CSRF origin check]");

ok("GET is always allowed", csrfOk(mk("GET", { host: "app.example.com", origin: "https://evil.com" })) === true);
ok("HEAD is always allowed", csrfOk(mk("HEAD", { host: "app.example.com" })) === true);
ok(
  "POST from same origin is allowed",
  csrfOk(mk("POST", { host: "app.example.com", origin: "https://app.example.com" })) === true,
);
ok(
  "POST from a foreign origin is BLOCKED",
  csrfOk(mk("POST", { host: "app.example.com", origin: "https://evil.com" })) === false,
);
ok(
  "PATCH from a foreign origin is BLOCKED",
  csrfOk(mk("PATCH", { host: "app.example.com", origin: "https://evil.com" })) === false,
);
ok(
  "DELETE with a matching Referer (no Origin) is allowed",
  csrfOk(mk("DELETE", { host: "app.example.com", referer: "https://app.example.com/x" })) === true,
);
ok(
  "POST with a foreign Referer (no Origin) is BLOCKED",
  csrfOk(mk("POST", { host: "app.example.com", referer: "https://evil.com/x" })) === false,
);
ok(
  "POST with neither Origin nor Referer is allowed (non-browser client)",
  csrfOk(mk("POST", { host: "app.example.com" })) === true,
);

console.log("\n[HTTP · login failure budget]");
ok("under the limit is not blocked", overLimit(LOGIN_MAX_FAILURES - 1) === false);
ok("at the limit is blocked", overLimit(LOGIN_MAX_FAILURES) === true);
ok("over the limit is blocked", overLimit(LOGIN_MAX_FAILURES + 5) === true);
ok("zero failures is not blocked", overLimit(0) === false);

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
