// Minimal, dependency-free tests for the auth password primitives.
// Run via `tsx api/_lib/auth.test.ts` (wired into `npm test`).
import { hashPassword, verifyPassword } from "./auth.js";

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

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
