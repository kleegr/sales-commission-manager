// Dependency-free tests for the Kleegr Smart Productivity integration.
// Run via `tsx api/_lib/kleegr.test.ts` (wired into `npm test`).
//
// Covers the security-critical PURE logic (no real network, no DB):
//   - webhook HMAC-SHA256 signature verification (fail-closed)
//   - Kleegr → app role mapping
//   - launch-token claim validation (valid/aud/exp/required ids)
//   - gateway / token error mapping via an INJECTED fake fetch
//   - defensive payload normalizers
//   - manifest ⇄ handled-events consistency + root JSON ⇄ embedded constant
//   - writeState mapping-preservation helper

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeWebhookSignature,
  verifyWebhookSignature,
  mapKleegrRole,
  validateLaunchClaims,
  verifyLaunchToken,
  verifyIntegrationToken,
  kleegrGateway,
  KleegrError,
  HANDLED_WEBHOOK_EVENTS,
  isHandledWebhookEvent,
  preserveExternalMapping,
  INTEGRATION_STATUSES,
  GATEWAY_RESOURCES,
  APP_KEY,
} from "./kleegr.js";
import { KLEEGR_MANIFEST } from "./kleegr-manifest.js";
import { normalizeContact, normalizeOpportunity, asRecordList, extractSubAccountId } from "./kleegr-sync.js";

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

/** Build a fake fetch returning a given status + JSON body (Response-like). */
function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  })) as unknown as typeof fetch;
}

function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.keys(val).sort().reduce((o: any, k) => ((o[k] = (val as any)[k]), o), {})
      : val,
  );
}

async function main() {
  // ---- env for the network-mapping tests (values are dummies) ----
  process.env.KLEEGR_API_BASE_URL = "https://kleegr.test";
  process.env.KLEEGR_INTEGRATION_TOKEN = "test-integration-token";
  process.env.KLEEGR_WEBHOOK_SECRET = "test-webhook-secret";

  // =========================================================================
  console.log("\n[Kleegr · webhook signature]");
  const secret = "shhh-very-secret";
  const rawBody = JSON.stringify({ event: "contact.created", data: { id: "c1" } });
  const sig = computeWebhookSignature(rawBody, secret);
  ok("signature has sha256=<hex> shape", /^sha256=[0-9a-f]{64}$/.test(sig));
  ok("valid signature accepted", verifyWebhookSignature(rawBody, sig, secret));
  ok("bare hex (no sha256= prefix) accepted", verifyWebhookSignature(rawBody, sig.replace("sha256=", ""), secret));
  ok("tampered body rejected", !verifyWebhookSignature(rawBody + " ", sig, secret));
  ok("wrong secret rejected", !verifyWebhookSignature(rawBody, sig, "different-secret"));
  ok("missing signature rejected", !verifyWebhookSignature(rawBody, null, secret));
  ok("empty signature rejected", !verifyWebhookSignature(rawBody, "", secret));
  ok("garbage signature rejected", !verifyWebhookSignature(rawBody, "sha256=deadbeef", secret));
  ok("Buffer body verifies the same as string", verifyWebhookSignature(Buffer.from(rawBody), sig, secret));
  let threwNoSecret = false;
  try {
    verifyWebhookSignature(rawBody, sig, "");
  } catch (e) {
    threwNoSecret = e instanceof KleegrError && e.code === "config_error";
  }
  ok("missing secret throws config_error (fail closed, not accept)", threwNoSecret);

  // =========================================================================
  console.log("\n[Kleegr · role mapping]");
  ok("agency_admin + sub_account → admin", mapKleegrRole("agency_admin", "sub_account") === "admin");
  ok("agency_admin + agency → owner", mapKleegrRole("agency_admin", "agency") === "owner");
  ok("manager → sales_manager", mapKleegrRole("manager") === "sales_manager");
  ok("user → salesperson", mapKleegrRole("user") === "salesperson");
  ok("unknown role → salesperson (never owner)", mapKleegrRole("superuser") === "salesperson");
  ok("empty role → salesperson", mapKleegrRole("") === "salesperson");
  ok("null role → salesperson", mapKleegrRole(null) === "salesperson");
  ok("case-insensitive (AGENCY_ADMIN)", mapKleegrRole("AGENCY_ADMIN", "agency") === "owner");
  ok("unknown is NEVER owner", mapKleegrRole("root", "agency") !== "owner");

  // =========================================================================
  console.log("\n[Kleegr · launch claim validation]");
  const now = 1_000_000_000_000; // fixed ms
  const goodClaims = {
    valid: true,
    aud: APP_KEY,
    exp: Math.floor(now / 1000) + 600, // 10 min in the future
    sp_user_id: "sp_user_1",
    sub_account_id: "sub_1",
    location_id: "loc_1",
    email: "rep@example.com",
    role: "manager",
    permissions: ["read", "write"],
  };
  const good = validateLaunchClaims(goodClaims, now);
  ok("good claims accepted", good.ok === true);
  ok("claims expose sp_user_id", good.claims?.sp_user_id === "sp_user_1");
  ok("claims expose sub_account_id", good.claims?.sub_account_id === "sub_1");
  ok("claims expose location_id", good.claims?.location_id === "loc_1");
  ok("permissions parsed to array", Array.isArray(good.claims?.permissions) && good.claims?.permissions.length === 2);

  ok("nested {claims:{…}} shape accepted", validateLaunchClaims({ valid: true, claims: goodClaims }, now).ok === true);
  ok("valid !== true rejected", validateLaunchClaims({ ...goodClaims, valid: false }, now).ok === false);
  ok("aud mismatch rejected", validateLaunchClaims({ ...goodClaims, aud: "other-app" }, now).reason === "aud_mismatch");
  ok("expired token rejected", validateLaunchClaims({ ...goodClaims, exp: Math.floor(now / 1000) - 1 }, now).reason === "expired");
  ok("exp = null (no expiry) accepted", validateLaunchClaims({ ...goodClaims, exp: null }, now).ok === true);
  ok("missing sp_user_id rejected", validateLaunchClaims({ ...goodClaims, sp_user_id: undefined }, now).reason === "missing_sp_user_id");
  ok("missing sub_account_id rejected", validateLaunchClaims({ ...goodClaims, sub_account_id: "" }, now).reason === "missing_sub_account_id");
  ok("empty payload rejected", validateLaunchClaims(null, now).ok === false);

  // =========================================================================
  console.log("\n[Kleegr · gateway + token error mapping (injected fetch)]");
  // integration token verify (success)
  const identity = await verifyIntegrationToken(fakeFetch(200, { ok: true, app: { appKey: APP_KEY }, scopes: ["a"], subAccounts: [] }));
  ok("verifyIntegrationToken success parses identity", identity.ok === true && Array.isArray(identity.scopes));

  // integration token verify (401 → unauthorized)
  let unauth: KleegrError | null = null;
  try {
    await verifyIntegrationToken(fakeFetch(401, { error: "bad token" }));
  } catch (e) {
    unauth = e as KleegrError;
  }
  ok("verifyIntegrationToken 401 → unauthorized", unauth?.code === "unauthorized");

  // gateway error codes
  async function gwErr(status: number): Promise<string> {
    try {
      await kleegrGateway("launch-tok", "contacts", {}, fakeFetch(status, { error: "x" }));
      return "no_error";
    } catch (e) {
      return e instanceof KleegrError ? e.code : "unknown";
    }
  }
  ok("gateway 403 → gateway_denied", (await gwErr(403)) === "gateway_denied");
  ok("gateway 501 → not_implemented", (await gwErr(501)) === "not_implemented");
  ok("gateway 502 → ghl_upstream_error", (await gwErr(502)) === "ghl_upstream_error");
  ok("gateway 401 → unauthorized", (await gwErr(401)) === "unauthorized");

  // gateway success unwraps {data:…}
  const gwData = await kleegrGateway<{ items: number[] }>("tok", "contacts", {}, fakeFetch(200, { data: { items: [1, 2, 3] } }));
  ok("gateway unwraps {data:…} envelope", Array.isArray(gwData.items) && gwData.items.length === 3);

  // gateway requires a launch token
  let noTok = false;
  try {
    await kleegrGateway("", "contacts");
  } catch (e) {
    noTok = e instanceof KleegrError && e.code === "unauthorized";
  }
  ok("gateway without launch token → unauthorized", noTok);

  // verifyLaunchToken via injected fetch
  const vlt = await verifyLaunchToken("launch-token", fakeFetch(200, goodClaims), now);
  ok("verifyLaunchToken success → ok claims", vlt.ok === true && vlt.claims?.sub_account_id === "sub_1");
  const vltBad = await verifyLaunchToken("launch-token", fakeFetch(401, { error: "nope" }), now);
  ok("verifyLaunchToken 401 → rejected", vltBad.ok === false && vltBad.reason === "rejected");

  // =========================================================================
  console.log("\n[Kleegr · payload normalizers]");
  const c = normalizeContact({ id: "ghl_c1", firstName: "Ada", lastName: "Lovelace", email: "ada@x.com", companyName: "Analytical Co" });
  ok("contact normalizes id + name + company", c?.kleegrContactId === "ghl_c1" && c?.contactName === "Ada Lovelace" && c?.companyName === "Analytical Co");
  ok("contact with no identifiers → null", normalizeContact({ foo: "bar" }) === null);
  const o = normalizeOpportunity({ id: "opp1", name: "Deal", pipelineId: "p1", pipelineStageId: "s1", status: "open", monetaryValue: 1200, contactId: "ghl_c1" });
  ok("opportunity normalizes pipeline/stage/status/value", o?.pipelineId === "p1" && o?.stageId === "s1" && o?.status === "open" && o?.monetaryValue === 1200);
  ok("opportunity links to contactRef", o?.contactRef === "ghl_c1");
  ok("asRecordList unwraps {contacts:[…]}", asRecordList({ contacts: [{ id: 1 }] }, "contacts").length === 1);
  ok("asRecordList unwraps bare array", asRecordList([{ id: 1 }, { id: 2 }]).length === 2);
  ok("asRecordList of junk → []", asRecordList(42).length === 0);
  ok("extractSubAccountId reads nested data.locationId", extractSubAccountId({ data: { locationId: "loc_9" } }) === "loc_9");
  ok("extractSubAccountId reads top-level sub_account_id", extractSubAccountId({ sub_account_id: "sub_9" }) === "sub_9");

  // =========================================================================
  console.log("\n[Kleegr · manifest consistency]");
  const handled = new Set<string>(HANDLED_WEBHOOK_EVENTS);
  const manifestEvents = new Set<string>(KLEEGR_MANIFEST.webhookEvents);
  ok("every manifest webhook event is handled", [...manifestEvents].every((e) => handled.has(e)));
  ok("every handled event is declared in the manifest", [...handled].every((e) => manifestEvents.has(e)));
  ok("isHandledWebhookEvent true for declared", isHandledWebhookEvent("contact.created"));
  ok("isHandledWebhookEvent false for unknown", !isHandledWebhookEvent("contact.deleted"));
  ok("manifest appKey matches APP_KEY", KLEEGR_MANIFEST.appKey === APP_KEY);
  ok("manifest launchUrl points at /kleegr/launch", KLEEGR_MANIFEST.launchUrl.endsWith("/kleegr/launch"));
  ok("manifest webhookUrl points at /api/kleegr/webhook", KLEEGR_MANIFEST.webhookUrl.endsWith("/api/kleegr/webhook"));
  // No secret VALUES are committed (referencing env-var NAMES in setupInstructions is expected + safe).
  const manifestStr = stableStringify(KLEEGR_MANIFEST);
  ok("manifest contains no integration-token value", !manifestStr.includes(process.env.KLEEGR_INTEGRATION_TOKEN!));
  ok("manifest contains no webhook-secret value", !manifestStr.includes(process.env.KLEEGR_WEBHOOK_SECRET!));
  ok("no secret-like top-level manifest key", Object.keys(KLEEGR_MANIFEST).find((k) => /secret|token|password|apikey/i.test(k)) === undefined);

  // root JSON file must equal the embedded constant (no drift)
  const rootJson = JSON.parse(readFileSync(resolve(process.cwd(), "smart-productivity.app.json"), "utf8"));
  ok("root smart-productivity.app.json equals embedded manifest", stableStringify(rootJson) === stableStringify(KLEEGR_MANIFEST));

  // =========================================================================
  console.log("\n[Kleegr · misc invariants]");
  ok("integration statuses are the documented set", stableStringify(INTEGRATION_STATUSES) === stableStringify(["connected", "configuring", "error", "disconnected"]));
  ok("gateway resources include the documented set", ["subaccount", "users", "opportunities", "contacts", "conversations"].every((r) => (GATEWAY_RESOURCES as readonly string[]).includes(r)));

  // =========================================================================
  console.log("\n[Kleegr · writeState mapping preservation]");
  const captured = [
    { id: "cli_1", kleegr_contact_id: "k1" },
    { id: "cli_2", kleegr_contact_id: "k2" },
    { id: "cli_gone", kleegr_contact_id: "k3" },
  ];
  const survivors = preserveExternalMapping(captured, ["cli_1", "cli_2"]);
  ok("preserves mapping for surviving rows", survivors.length === 2 && survivors.every((r) => r.id !== "cli_gone"));
  ok("drops mapping for rows removed from the snapshot", !survivors.some((r) => r.id === "cli_gone"));

  console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

void main();
