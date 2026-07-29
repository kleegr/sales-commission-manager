// Minimal, dependency-free tests for the auth password primitives.
// Run via `tsx api/_lib/auth.test.ts` (wired into `npm test`).
import { hashPassword, verifyPassword, demoModeEnabled, isDemoSlug } from "./auth.js";

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

console.log("\n[Auth · password hashing]");

const hash = hashPassword("demo1234");
ok("hash has scrypt$salt$hash shape", /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/.test(hash));
ok("correct password verifies", verifyPassword("demo1234", hash));
ok("wrong password rejected", !verifyPassword("wrong", hash));
ok("empty password rejected", !verifyPassword("", hash));
ok("null stored hash rejected", !verifyPassword("demo1234", null));
ok("malformed stored hash rejected", !verifyPassword("demo1234", "not-a-hash"));

const h2 = hashPassword("demo1234");
ok("same password -> different salt/hash", h2 !== hash);
ok("both hashes still verify", verifyPassword("demo1234", h2) && verifyPassword("demo1234", hash));

console.log("\n[Auth · demo-mode host guard]");

const ENV_KEYS = ["DEMO_MODE", "VERCEL_ENV", "DEMO_MODE_ALLOW_IN_PRODUCTION"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
function setEnv(e: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const k of ENV_KEYS) {
    const v = e[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

setEnv({ DEMO_MODE: undefined, VERCEL_ENV: undefined, DEMO_MODE_ALLOW_IN_PRODUCTION: undefined });
ok("demo OFF when DEMO_MODE unset (production-safe default)", demoModeEnabled() === false);

setEnv({ DEMO_MODE: "off" });
ok("demo OFF for a non-affirmative value", demoModeEnabled() === false);

setEnv({ DEMO_MODE: "true", VERCEL_ENV: "preview" });
ok("demo ON when affirmative and NOT production", demoModeEnabled() === true);

setEnv({ DEMO_MODE: "on", VERCEL_ENV: "production" });
ok("demo FORCED OFF in production even when DEMO_MODE=on", demoModeEnabled() === false);

setEnv({ DEMO_MODE: "on", VERCEL_ENV: "production", DEMO_MODE_ALLOW_IN_PRODUCTION: "1" });
ok("demo allowed in production ONLY with the explicit second flag", demoModeEnabled() === true);

setEnv(savedEnv); // restore the ambient environment for any later code

console.log("\n[Auth · demo tenant slug allowlist]");
ok("demo slug 'demo' is allowed", isDemoSlug("demo") === true);
ok("demo slug 'acme' is allowed", isDemoSlug("acme") === true);
ok("a real Kleegr slug is NOT a demo slug", isDemoSlug("k-ygsxkbj2ezscgrlxh6tr") === false);
ok("empty slug is NOT a demo slug", isDemoSlug("") === false);

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
