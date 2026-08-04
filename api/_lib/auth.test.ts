// Minimal, dependency-free tests for the auth password primitives.
// Run via `tsx api/_lib/auth.test.ts` (wired into `npm test`).
import {
  hashPassword,
  verifyPassword,
  demoModeEnabled,
  isDemoSlug,
  readBearerToken,
  getSessionTokens,
  getSessionToken,
  isEmbeddedClient,
} from "./auth.js";
import type { VercelRequest } from "@vercel/node";

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

// ---------------------------------------------------------------------------
// Session transport: Authorization: Bearer … first, cookie second.
//
// This is the mobile-WebView fix. Inside the Smart Productivity iframe the
// `scm_session` cookie is third-party and is blocked outright by iOS WebKit /
// Android WebView, so the embedded client replays the session token as a
// Bearer header instead. Both candidates must be offered to the session
// lookup, in that order, and neither may be dropped.
// ---------------------------------------------------------------------------

console.log("\n[Auth · session transport (Bearer + cookie)]");

const req = (headers: Record<string, string>) => ({ headers }) as unknown as VercelRequest;

ok("no credentials at all → no candidates", getSessionTokens(req({})).length === 0);

const cookieOnly = req({ cookie: "scm_session=cookie-token; other=x" });
ok("cookie only → the cookie token", getSessionTokens(cookieOnly).join() === "cookie-token");
ok("cookie only → getSessionToken agrees", getSessionToken(cookieOnly) === "cookie-token");

const bearerOnly = req({ authorization: "Bearer bearer-token" });
ok("Bearer only → the bearer token", getSessionTokens(bearerOnly).join() === "bearer-token");
ok("Bearer only → getSessionToken agrees", getSessionToken(bearerOnly) === "bearer-token");

const both = req({ authorization: "Bearer bearer-token", cookie: "scm_session=cookie-token" });
ok("both → Bearer is tried FIRST", getSessionTokens(both)[0] === "bearer-token");
ok("both → the cookie is still offered as a fallback", getSessionTokens(both)[1] === "cookie-token");
ok("both → exactly two candidates", getSessionTokens(both).length === 2);

const same = req({ authorization: "Bearer same-token", cookie: "scm_session=same-token" });
ok("identical Bearer + cookie are deduplicated", getSessionTokens(same).length === 1);

ok("scheme is case-insensitive", readBearerToken(req({ authorization: "bearer tok" })) === "tok");
ok("BEARER uppercase accepted", readBearerToken(req({ authorization: "BEARER tok" })) === "tok");
ok("surrounding whitespace trimmed", readBearerToken(req({ authorization: "Bearer  tok  " })) === "tok");
ok("a Basic header is NOT a session token", readBearerToken(req({ authorization: "Basic abc" })) === null);
ok("an empty Bearer value is null", readBearerToken(req({ authorization: "Bearer " })) === null);
ok("a bare token with no scheme is ignored", readBearerToken(req({ authorization: "tok" })) === null);
ok("a missing header is null", readBearerToken(req({})) === null);

// A URL-encoded cookie value must decode identically to what setSessionCookie wrote.
const encoded = req({ cookie: "scm_session=a%2Bb%2Fc%3D" });
ok("cookie value is URL-decoded", getSessionTokens(encoded).join() === "a+b/c=");

// Only OUR cookie counts — a same-named-prefix cookie must not be picked up.
const decoy = req({ cookie: "scm_session_other=nope; scm_session=real" });
ok("a decoy cookie name is not mistaken for the session", getSessionToken(decoy) === "real");

// ---------------------------------------------------------------------------
// Embedded-client declaration (decides whether a login response carries the
// raw session token, the transport a WebView cannot block).
// ---------------------------------------------------------------------------

console.log("\n[Login handoff · only an EMBEDDED client is handed the token]");

ok("boolean true", isEmbeddedClient(true));
ok('string "true" (JSON round-trip)', isEmbeddedClient("true"));
ok('string "1"', isEmbeddedClient("1"));
ok("number 1", isEmbeddedClient(1));

ok("boolean false", !isEmbeddedClient(false));
ok('string "false"', !isEmbeddedClient("false"));
ok("absent/undefined ⇒ plain browser login stays cookie-only", !isEmbeddedClient(undefined));
ok("null", !isEmbeddedClient(null));
ok("empty string", !isEmbeddedClient(""));
ok("0", !isEmbeddedClient(0));
ok("an arbitrary string is not a yes", !isEmbeddedClient("yes please"));
ok("an object is not a yes", !isEmbeddedClient({ embedded: true }));

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
