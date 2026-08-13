// Tests for the local-fallback policy: when the browser's cached copy of
// AppData may stand in for the live database, and when it may be written.
// Run via `tsx src/lib/storage/fallback-policy.test.ts` (wired into `npm test`).
import {
  allowCachedRead,
  allowLocalWrites,
  coerceServerMode,
  readRememberedMode,
  rememberMode,
  clearRememberedMode,
  type ModeStore,
  type ServerMode,
} from "./fallback-policy";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const dev: ServerMode = { serverAuthoritative: true, environment: "development", localFallback: true };
const preview: ServerMode = { serverAuthoritative: true, environment: "preview", localFallback: false };
const prod: ServerMode = { serverAuthoritative: true, environment: "production", localFallback: false };
const noServer: ServerMode = { serverAuthoritative: false, environment: "development", localFallback: true };

console.log("\n[coerceServerMode · defensive parsing]");

ok("a full payload round-trips", coerceServerMode(prod)?.environment === "production");
ok("null is rejected", coerceServerMode(null) === null);
ok("a non-object is rejected", coerceServerMode("production") === null);
ok("an unknown environment is rejected", coerceServerMode({ environment: "staging" }) === null);
// An older server that predates the field must not be read as "fallback is fine".
ok(
  "a missing localFallback is derived, not assumed true",
  coerceServerMode({ environment: "production" })?.localFallback === false,
);
ok(
  "...and development still derives true",
  coerceServerMode({ environment: "development" })?.localFallback === true,
);
ok(
  "serverAuthoritative defaults to true",
  coerceServerMode({ environment: "production" })?.serverAuthoritative === true,
);
ok(
  "...but an explicit false is honoured",
  coerceServerMode({ environment: "development", serverAuthoritative: false })
    ?.serverAuthoritative === false,
);

console.log("\n[allowCachedRead · an ABSENT API is always answerable from cache]");

// There is no server here, so no database can disagree with the cache.
ok("absent + production mode", allowCachedRead("absent", prod) === true);
ok("absent + nothing remembered", allowCachedRead("absent", null) === true);

console.log("\n[allowCachedRead · an OUTAGE is a policy question]");

ok("outage in development serves the cache", allowCachedRead("outage", dev) === true);
ok("outage in preview does NOT", allowCachedRead("outage", preview) === false);
ok("outage in production does NOT", allowCachedRead("outage", prod) === false);
// No evidence this is a dev build ⇒ refuse. A stale financial number is the
// more expensive mistake than an honest error.
ok("outage with an unknown deployment does NOT", allowCachedRead("outage", null) === false);

console.log("\n[allowLocalWrites · only where no server owns the data]");

ok("no mode seen yet ⇒ local writes allowed", allowLocalWrites(null) === true);
ok("server-authoritative ⇒ refused", allowLocalWrites(prod) === false);
ok("...in development too — the database still owns it", allowLocalWrites(dev) === false);
ok("a non-authoritative server ⇒ allowed", allowLocalWrites(noServer) === true);

console.log("\n[remembered mode · storage glue]");

const map = new Map<string, string>();
const store: ModeStore = {
  getItem: (k) => map.get(k) ?? null,
  setItem: (k, v) => void map.set(k, v),
  removeItem: (k) => void map.delete(k),
};

ok("nothing remembered at first", readRememberedMode(store) === null);
rememberMode(store, prod);
ok("a remembered mode reads back", readRememberedMode(store)?.environment === "production");
ok("...and carries its fallback verdict", readRememberedMode(store)?.localFallback === false);
clearRememberedMode(store);
ok("clearing works", readRememberedMode(store) === null);

// Storage can be disabled (private mode, blocked cookies). None of this may
// throw — it degrades to "unknown", which the policy already treats safely.
const broken: ModeStore = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
  removeItem: () => { throw new Error("blocked"); },
};
let threw = false;
try {
  rememberMode(broken, prod);
  clearRememberedMode(broken);
  ok("a blocked store reads as unknown", readRememberedMode(broken) === null);
} catch {
  threw = true;
}
ok("a blocked store never throws", threw === false);
ok("an undefined store never throws", readRememberedMode(undefined) === null);

// Corrupt JSON in storage must not crash the boot path either.
map.set("scm.state_mode", "{not json");
ok("corrupt stored JSON reads as unknown", readRememberedMode(store) === null);

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
