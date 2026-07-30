// Dependency-free, DOM-free tests for the embedded sidebar expand/collapse
// preference. Run via `tsx src/lib/sidebar-pref.test.ts` (wired into `npm test`).
//
// These lock in the two behaviours the rail depends on: an unset or garbled
// value must fall back to the caller's default (so a fresh GHL sub-account gets
// the compact rail rather than an undefined-y expanded one), and a store that
// throws -- Safari private mode, or a GHL frame with third-party storage
// blocked -- must degrade to the default instead of taking the app down.
import {
  SIDEBAR_PREF_KEY,
  readSidebarPref,
  writeSidebarPref,
  type PrefStore,
} from "./sidebar-pref";

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

/** In-memory stand-in for localStorage. */
function fakeStore(seed: Record<string, string> = {}): PrefStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

/** A store that rejects every access, like a blocked third-party context. */
const throwingStore: PrefStore = {
  getItem() {
    throw new Error("storage blocked");
  },
  setItem() {
    throw new Error("storage blocked");
  },
};

console.log("\n[Sidebar pref · read]");
ok("unset store falls back to the caller's default (collapsed)", readSidebarPref(fakeStore(), false) === false);
ok("unset store falls back to the caller's default (expanded)", readSidebarPref(fakeStore(), true) === true);
ok('stored "1" reads as expanded', readSidebarPref(fakeStore({ [SIDEBAR_PREF_KEY]: "1" }), false) === true);
ok('stored "0" reads as collapsed', readSidebarPref(fakeStore({ [SIDEBAR_PREF_KEY]: "0" }), true) === false);
ok(
  "an unrecognised value falls back to the default",
  readSidebarPref(fakeStore({ [SIDEBAR_PREF_KEY]: "yes please" }), false) === false,
);
ok("a missing store falls back to the default", readSidebarPref(undefined, true) === true);
ok("a throwing store falls back to the default", readSidebarPref(throwingStore, false) === false);

console.log("\n[Sidebar pref · write]");
{
  const store = fakeStore();
  writeSidebarPref(store, true);
  ok('expanded persists as "1"', store.map.get(SIDEBAR_PREF_KEY) === "1");
  writeSidebarPref(store, false);
  ok('collapsed persists as "0"', store.map.get(SIDEBAR_PREF_KEY) === "0");
}
ok("the key is the documented localStorage key", SIDEBAR_PREF_KEY === "scm.sidebarExpanded");

let threw = false;
try {
  writeSidebarPref(throwingStore, true);
  writeSidebarPref(undefined, true);
} catch {
  threw = true;
}
ok("writing to a blocked/missing store never throws", !threw);

console.log("\n[Sidebar pref · round-trip]");
{
  const store = fakeStore();
  writeSidebarPref(store, true);
  ok("write(true) -> read() === true regardless of default", readSidebarPref(store, false) === true);
  writeSidebarPref(store, false);
  ok("write(false) -> read() === false regardless of default", readSidebarPref(store, true) === false);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
