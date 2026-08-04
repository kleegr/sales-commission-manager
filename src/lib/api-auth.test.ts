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

// ---------------------------------------------------------------------------
// The installed interceptor, against a stubbed browser.
//
// The rule above is pure; these cover the wiring around it — that the token and
// the review-mode selection actually land on the request, that a caller's own
// headers survive, and that nothing is attached when there is nothing to send.
// ---------------------------------------------------------------------------

const storage = new Map<string, string>();
const sent: Array<{ url: string; headers: Headers }> = [];

(globalThis as { window?: unknown }).window = {
  location: { origin: ORIGIN },
  localStorage: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
  fetch: (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(
      init?.headers ?? (typeof input !== "string" && !(input instanceof URL) ? input.headers : {}),
    );
    sent.push({ url, headers });
    return Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" } }));
  },
};

const { installApiAuthInterceptor } = await import("./api-auth");
const { SESSION_TOKEN_KEY } = await import("./session-token");
const { DEMO_TENANT_KEY, DEMO_ROLE_KEY } = await import("./demo-prefs");

installApiAuthInterceptor();
const call = async (input: RequestInfo | URL, init?: RequestInit) => {
  sent.length = 0;
  await (globalThis as unknown as { window: { fetch: typeof fetch } }).window.fetch(input, init);
  return sent[0];
};

console.log("\n[API auth · nothing stored ⇒ pass-through]");

let r = await call("/api/goals");
ok("no Authorization header when localStorage is empty", !r.headers.has("authorization"));
ok("no x-demo-tenant either", !r.headers.has("x-demo-tenant"));

console.log("\n[API auth · the session token rides along]");

storage.set(SESSION_TOKEN_KEY, "sess-tok");
r = await call("/api/goals");
ok("/api/goals carries the Bearer token", r.headers.get("authorization") === "Bearer sess-tok");
r = await call("/api/documents?kind=proposal");
ok("/api/documents carries it too", r.headers.get("authorization") === "Bearer sess-tok");
r = await call("/api/documents", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
ok("a POST carries it", r.headers.get("authorization") === "Bearer sess-tok");
ok("...without losing the caller's content-type", r.headers.get("content-type") === "application/json");

r = await call("/api/kleegr/sync");
ok("the exempt launch endpoint is left alone", !r.headers.has("authorization"));
r = await call("/api/documents", { headers: { authorization: "Bearer caller-owns-this" } });
ok("a caller's own Authorization header wins", r.headers.get("authorization") === "Bearer caller-owns-this");

console.log("\n[API auth · review-mode selection travels as headers]");

// The scm_demo_* cookies are third-party inside the iframe, so the choice has
// to ride as headers or a framed reviewer silently gets the server default.
storage.set(DEMO_TENANT_KEY, "acme");
storage.set(DEMO_ROLE_KEY, "sales_manager");
r = await call("/api/goals");
ok("x-demo-tenant is attached", r.headers.get("x-demo-tenant") === "acme");
ok("x-demo-role is attached", r.headers.get("x-demo-role") === "sales_manager");
ok("alongside the Bearer token", r.headers.get("authorization") === "Bearer sess-tok");

// Review mode with no login at all: the demo headers must still go out, which
// is exactly the path the old `if (!token) return` short-circuit dropped.
storage.delete(SESSION_TOKEN_KEY);
r = await call("/api/goals");
ok("demo headers are sent even with NO session token", r.headers.get("x-demo-tenant") === "acme");
ok("...and no Authorization header is invented", !r.headers.has("authorization"));

r = await call("/assets/index.js");
ok("non-API requests stay untouched", !r.headers.has("x-demo-tenant"));

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
