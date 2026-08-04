// Tests for how HybridStore.load() classifies a failed /api/state read.
// Run via `tsx src/lib/storage/apiStore.test.ts` (wired into `npm test`).
//
// The distinction under test: a REFUSAL (401/403/4xx) must propagate, and an
// OUTAGE (network failure, 5xx, or a response that isn't our JSON API) must be
// answered from the localStorage cache. Serving cached data for everything is
// what let a dead session render as a healthy Dashboard.
import type { AppData } from "../../types";

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

// --- stub browser globals before the store touches them ---------------------

const CACHE_KEY = "scm.data.v1";
const storage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
};

/** A minimally valid payload — load() only insists on data.salespeople[]. */
const serverData = { salespeople: [{ id: "srv" }] } as unknown as AppData;
const cachedData = { salespeople: [{ id: "cached" }] } as unknown as AppData;
const idOf = (d: AppData | null) =>
  (d as unknown as { salespeople: { id: string }[] } | null)?.salespeople?.[0]?.id ?? null;

type Reply = { status: number; contentType: string; body?: unknown } | "network-failure";
let reply: Reply = "network-failure";

(globalThis as { fetch?: unknown }).fetch = () => {
  if (reply === "network-failure") return Promise.reject(new TypeError("Failed to fetch"));
  const r = reply;
  return Promise.resolve(
    new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { "content-type": r.contentType },
    }),
  );
};

const { classifyStateResponse, isAuthError, StateLoadError, HybridStore, getBackendInfo } =
  await import("./apiStore");

const JSON_CT = "application/json; charset=utf-8";
const store = new HybridStore();

/** Run a load() and report what came back, without letting a throw escape. */
async function attempt(r: Reply) {
  reply = r;
  storage.set(CACHE_KEY, JSON.stringify(cachedData));
  try {
    return { data: await store.load(), error: null as unknown };
  } catch (e) {
    return { data: null, error: e };
  }
}

// ---------------------------------------------------------------------------

console.log("\n[classify · a JSON 2xx is a success]");

ok("200 JSON", classifyStateResponse(200, JSON_CT) === null);
ok("204 JSON", classifyStateResponse(204, "application/json") === null);

console.log("\n[classify · the API answered and REFUSED — never serve cache]");

ok("401 ⇒ auth", classifyStateResponse(401, JSON_CT) === "auth");
ok("403 ⇒ auth", classifyStateResponse(403, JSON_CT) === "auth");
ok("400 ⇒ client", classifyStateResponse(400, JSON_CT) === "client");
ok("404 ⇒ client", classifyStateResponse(404, JSON_CT) === "client");
ok("422 ⇒ client", classifyStateResponse(422, JSON_CT) === "client");
ok("429 ⇒ client", classifyStateResponse(429, JSON_CT) === "client");

console.log("\n[classify · upstream is broken or absent — cache may stand in]");

ok("500 ⇒ outage", classifyStateResponse(500, JSON_CT) === "outage");
ok("502 ⇒ outage", classifyStateResponse(502, JSON_CT) === "outage");
ok("503 (database_not_configured) ⇒ outage", classifyStateResponse(503, JSON_CT) === "outage");

// `vite dev` and any static host answer /api/state with the SPA's index.html.
// That is an ABSENT API, not a 404 to report to the user — content type is
// checked before status precisely so this reaches the cached-data path.
ok("200 text/html (vite dev) ⇒ outage", classifyStateResponse(200, "text/html") === "outage");
ok("404 text/html (no functions deployed) ⇒ outage", classifyStateResponse(404, "text/html") === "outage");
ok("a missing content-type ⇒ outage", classifyStateResponse(200, null) === "outage");

console.log("\n[load · success]");

let r = await attempt({ status: 200, contentType: JSON_CT, body: { data: serverData } });
ok("returns the server's data", idOf(r.data) === "srv");
ok("did not throw", r.error === null);
ok("backend is neon", getBackendInfo().backend === "neon");
ok("isOfflineData is false", getBackendInfo().isOfflineData === false);
ok("the response was written to the cache", storage.get(CACHE_KEY)?.includes("srv") === true);

console.log("\n[load · auth failure propagates, cache is NOT served]");

r = await attempt({ status: 401, contentType: JSON_CT, body: { error: "unauthorized" } });
ok("401 throws", r.error instanceof StateLoadError);
ok("...classified as auth", isAuthError(r.error));
ok("...carrying the status", (r.error as StateLoadError).status === 401);
ok("...and returns no data", r.data === null);
ok("the stale cache is NOT served", idOf(r.data) !== "cached");
ok("backend is not switched to local", getBackendInfo().backend !== "local");

r = await attempt({ status: 403, contentType: JSON_CT, body: { error: "forbidden" } });
ok("403 throws too", isAuthError(r.error));

console.log("\n[load · client errors propagate, cache is NOT served]");

for (const status of [400, 404, 422]) {
  r = await attempt({ status, contentType: JSON_CT, body: { error: "nope" } });
  ok(`${status} throws`, r.error instanceof StateLoadError);
  ok(`${status} is not an auth error`, !isAuthError(r.error));
  ok(`${status} serves no cached data`, r.data === null);
}

console.log("\n[load · outages fall back to the cache and flag it]");

r = await attempt({ status: 500, contentType: JSON_CT, body: { error: "internal_error" } });
ok("5xx returns the cached copy", idOf(r.data) === "cached");
ok("...without throwing", r.error === null);
ok("...flagged isOfflineData", getBackendInfo().isOfflineData === true);
ok("...backend reads local", getBackendInfo().backend === "local");

r = await attempt("network-failure");
ok("a network failure returns the cache", idOf(r.data) === "cached");
ok("...flagged isOfflineData", getBackendInfo().isOfflineData === true);

r = await attempt({ status: 200, contentType: "text/html", body: {} });
ok("the vite-dev SPA shell returns the cache", idOf(r.data) === "cached");
ok("...flagged isOfflineData", getBackendInfo().isOfflineData === true);

// A 2xx JSON body that isn't the payload we asked for: answering, but not
// usefully. Cached data still beats an empty screen.
r = await attempt({ status: 200, contentType: JSON_CT, body: { data: { nope: true } } });
ok("a malformed 2xx payload returns the cache", idOf(r.data) === "cached");

// An outage with nothing cached must still resolve, not throw.
storage.clear();
reply = "network-failure";
r = { data: await store.load(), error: null };
ok("an outage with an empty cache resolves to null", r.data === null);

// Recovery: a later success must clear the offline flag rather than latch it.
r = await attempt({ status: 200, contentType: JSON_CT, body: { data: serverData } });
ok("a later success clears isOfflineData", getBackendInfo().isOfflineData === false);
ok("...and returns live data again", idOf(r.data) === "srv");

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
