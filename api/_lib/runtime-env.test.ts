// Tests for the deployment-environment helpers that decide whether the browser
// may ever fall back to its localStorage copy.
// Run via `tsx api/_lib/runtime-env.test.ts` (wired into `npm test`).
import {
  deploymentEnvironment,
  isEnabled,
  isProduction,
  localFallbackAllowed,
} from "./runtime-env.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("\n[isEnabled · only the documented switch-on values]");

for (const v of ["1", "true", "on", "enabled", "yes", "TRUE", " On "]) {
  ok(`"${v}" enables`, isEnabled(v) === true);
}
for (const v of ["0", "false", "off", "no", "", " ", "maybe", undefined]) {
  ok(`${JSON.stringify(v)} does not`, isEnabled(v) === false);
}

console.log("\n[deploymentEnvironment · VERCEL_ENV wins, NODE_ENV is the fallback]");

ok("production", deploymentEnvironment({ VERCEL_ENV: "production" }) === "production");
ok("preview", deploymentEnvironment({ VERCEL_ENV: "preview" }) === "preview");
ok("development", deploymentEnvironment({ VERCEL_ENV: "development" }) === "development");
ok(
  "VERCEL_ENV beats NODE_ENV",
  deploymentEnvironment({ VERCEL_ENV: "preview", NODE_ENV: "production" }) === "preview",
);
ok("NODE_ENV=production without VERCEL_ENV", deploymentEnvironment({ NODE_ENV: "production" }) === "production");
ok("an empty env is development", deploymentEnvironment({}) === "development");
ok("an unrecognised VERCEL_ENV falls through to NODE_ENV", deploymentEnvironment({ VERCEL_ENV: "weird" }) === "development");

ok("isProduction agrees", isProduction({ VERCEL_ENV: "production" }) === true);
ok("...and for preview", isProduction({ VERCEL_ENV: "preview" }) === false);

console.log("\n[localFallbackAllowed · off wherever real tenant data lives]");

ok("production ⇒ off", localFallbackAllowed({ VERCEL_ENV: "production" }) === false);
// Preview deployments point at real data too, so they get the production rule.
ok("preview ⇒ off", localFallbackAllowed({ VERCEL_ENV: "preview" }) === false);
ok("development ⇒ on", localFallbackAllowed({ VERCEL_ENV: "development" }) === true);
ok("an empty env ⇒ on (local dev)", localFallbackAllowed({}) === true);

console.log("\n[localFallbackAllowed · the deliberate offline-demo override]");

ok(
  "SCM_ALLOW_LOCAL_FALLBACK re-enables it in production",
  localFallbackAllowed({ VERCEL_ENV: "production", SCM_ALLOW_LOCAL_FALLBACK: "1" }) === true,
);
ok(
  "...but only for the documented values",
  localFallbackAllowed({ VERCEL_ENV: "production", SCM_ALLOW_LOCAL_FALLBACK: "maybe" }) === false,
);
ok(
  "...and an empty value does not count",
  localFallbackAllowed({ VERCEL_ENV: "production", SCM_ALLOW_LOCAL_FALLBACK: "" }) === false,
);

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
