// Tests for how HybridStore classifies a failed /api/state read, and for the
// production rule that a cached copy may NOT stand in for the live dataset.
// Run via `tsx src/lib/storage/apiStore.test.ts` (wired into `npm test`).
//
// Three distinctions are under test:
//   REFUSAL (401/403/4xx)  must propagate — serving cached data for everything
//                          is what let a dead session render as a healthy
//                          Dashboard.
//   ABSENT  (not our JSON) there is no server here (`vite dev`), so the local
//                          copy IS the backend and may always be served.
//   OUTAGE  (5xx/network)  a server exists and is failing. The cache may stand
//                          in only where the policy allows it — in production it
//                          may not, because a stale balance is worse than an
//                          honest error.
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
const MODE_KEY = "scm.state_mode";
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

const devMode = { serverAuthoritative: true, environment: "development", localFallback: true };
const prodMode = { serverAuthoritative: true, environment: "production", localFallback: false };

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

const {
  classifyStateResponse,
  isAuthError,
  isUnavailableError,
  StateLoadError,
  HybridStore,
  getBackendInfo,
  resetBackendInfo,
} = await import("./apiStore");

const JSON_CT = "application/json; charset=utf-8";
const store = new HybridStore();

/**
 * Run a load() and report what came back, without letting a throw escape.
 * `remembered` seeds what the last successful load learned about the
 * deployment, which is what the outage policy consults.
 */
async function attempt(r: Reply, remembered: unknown = devMode) {
  reply = r;
  storage.set(CACHE_KEY, JSON.stringify(cachedData));
  if (remembered === null) storage.delete(MODE_KEY);
  else storage.set(MODE_KEY, JSON.stringify(remembered));
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
ok("410 (retired snapshot write) ⇒ client", classifyStateResponse(410, JSON_CT) === "client");
ok("422 ⇒ client", classifyStateResponse(422, JSON_CT) === "client");
ok("429 ⇒ client", classifyStateResponse(429, JSON_CT) === "client");

console.log("\n[classify · upstream broken (outage) vs upstream absent]");

ok("500 ⇒ outage", classifyStateResponse(500, JSON_CT) === "outage");
ok("502 ⇒ outage", classifyStateResponse(502, JSON_CT) === "outage");
ok("503 (database_not_configured) ⇒ outage", classifyStateResponse(503, JSON_CT) === "outage");

// `vite dev` and any static host answer /api/state with the SPA's index.html.
// That is an ABSENT API — no server exists to be authoritative — which is a
// different thing from our API being down, and is why content type is checked
// before status.
ok("200 text/html (vite dev) ⇒ absent", classifyStateResponse(200, "text/html") === "absent");
ok("404 text/html (no functions) ⇒ absent", classifyStateResponse(404, "text/html") === "absent");
ok("a missing content-type ⇒ absent", classifyStateResponse(200, null) === "absent");

console.log("\n[load · success]");

let r = await attempt({
  status: 200,
  contentType: JSON_CT,
  body: { data: serverData, mode: prodMode },
});
ok("returns the server's data", idOf(r.data) === "srv");
ok("did not throw", r.error === null);
ok("backend is neon", getBackendInfo().backend === "neon");
ok("isOfflineData is false", getBackendInfo().isOfflineData === false);
ok("serverAuthoritative is true", getBackendInfo().serverAuthoritative === true);
ok("the response was written to the cache", storage.get(CACHE_KEY)?.includes("srv") === true);
ok("the mode was remembered", storage.get(MODE_KEY)?.includes("production") === true);

console.log("\n[save · no local writes once a server owns the data]");

storage.set(CACHE_KEY, JSON.stringify(cachedData));
await store.save(serverData);
ok(
  "save() does not touch the cache in server-authoritative mode",
  storage.get(CACHE_KEY)?.includes("cached") === true,
);

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

for (const status of [400, 404, 410, 422]) {
  r = await attempt({ status, contentType: JSON_CT, body: { error: "nope" } });
  ok(`${status} throws`, r.error instanceof StateLoadError);
  ok(`${status} is not an auth error`, !isAuthError(r.error));
  ok(`${status} serves no cached data`, r.data === null);
}

console.log("\n[load · an ABSENT API always falls back — this is `vite dev`]");

r = await attempt({ status: 200, contentType: "text/html", body: {} }, prodMode);
ok("the SPA shell returns the cache", idOf(r.data) === "cached");
ok("...flagged isOfflineData", getBackendInfo().isOfflineData === true);
ok("...and drops server-authoritative, so local writes resume",
  getBackendInfo().serverAuthoritative === false);

// With no server, the reducer IS the database — save() must persist again.
storage.set(CACHE_KEY, JSON.stringify(cachedData));
await store.save(serverData);
ok("save() writes the cache when no server owns the data",
  storage.get(CACHE_KEY)?.includes("srv") === true);

console.log("\n[load · an OUTAGE in DEVELOPMENT may be answered from the cache]");

r = await attempt({ status: 500, contentType: JSON_CT, body: { error: "internal_error" } }, devMode);
ok("5xx returns the cached copy", idOf(r.data) === "cached");
ok("...without throwing", r.error === null);
ok("...flagged isOfflineData", getBackendInfo().isOfflineData === true);
ok("...backend reads local", getBackendInfo().backend === "local");

r = await attempt("network-failure", devMode);
ok("a network failure returns the cache", idOf(r.data) === "cached");

r = await attempt({ status: 200, contentType: JSON_CT, body: { data: { nope: true } } }, devMode);
ok("a malformed 2xx payload returns the cache", idOf(r.data) === "cached");

console.log("\n[load · an OUTAGE in PRODUCTION must NOT serve a stale ledger]");

r = await attempt({ status: 500, contentType: JSON_CT, body: { error: "internal_error" } }, prodMode);
ok("5xx throws instead of serving the cache", r.error instanceof StateLoadError);
ok("...classified as an outage the UI must report", isUnavailableError(r.error));
ok("...and returns no data", r.data === null);
ok("...the stale cache is NOT served", idOf(r.data) !== "cached");

r = await attempt("network-failure", prodMode);
ok("a network failure throws too", isUnavailableError(r.error));

// Nothing remembered means this device has never reached the API, so there is
// no evidence it is a development build. Refuse — the expensive mistake is
// showing a stale number, not showing an error.
r = await attempt({ status: 500, contentType: JSON_CT, body: {} }, null);
ok("an unknown deployment refuses the cache", isUnavailableError(r.error));

console.log("\n[load · recovery]");

resetBackendInfo();
reply = "network-failure";
storage.clear();
r = { data: await store.load().catch(() => null), error: null };
ok("an outage with an empty cache resolves to null", r.data === null);

r = await attempt(
  { status: 200, contentType: JSON_CT, body: { data: serverData, mode: devMode } },
  devMode,
);
ok("a later success clears isOfflineData", getBackendInfo().isOfflineData === false);
ok("...and returns live data again", idOf(r.data) === "srv");

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
