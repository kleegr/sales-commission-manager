// Tests the Kleegr gateway resource token (M-2: align with the locations.readonly
// scope) and webhook event-name normalization (accept location.* and subaccount.*).
import { subaccountGatewayResource, normalizeWebhookEvent } from "./kleegr.js";

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

const KEY = "KLEEGR_GATEWAY_RESOURCE";
const saved = process.env[KEY];
function setEnv(v: string | undefined) {
  if (v === undefined) delete process.env[KEY];
  else process.env[KEY] = v;
}

console.log("\n[Kleegr · gateway resource token]");
setEnv(undefined);
ok("defaults to 'locations' (matches locations.readonly scope) when unset", subaccountGatewayResource() === "locations");
setEnv("");
ok("'locations' for empty", subaccountGatewayResource() === "locations");
setEnv("something-else");
ok("'locations' for an unrecognized value", subaccountGatewayResource() === "locations");
setEnv("locations");
ok("'locations' when explicitly set to locations", subaccountGatewayResource() === "locations");
setEnv("subaccount");
ok("'subaccount' only when explicitly overridden", subaccountGatewayResource() === "subaccount");
setEnv("SubAccount");
ok("override is case-insensitive", subaccountGatewayResource() === "subaccount");
setEnv(saved);

console.log("\n[Kleegr · webhook event naming]");
ok("location.connected -> subaccount.connected", normalizeWebhookEvent("location.connected") === "subaccount.connected");
ok("location.disconnected -> subaccount.disconnected", normalizeWebhookEvent("location.disconnected") === "subaccount.disconnected");
ok("subaccount.connected is unchanged", normalizeWebhookEvent("subaccount.connected") === "subaccount.connected");
ok("contact.created is unchanged", normalizeWebhookEvent("contact.created") === "contact.created");
ok("opportunity.updated is unchanged", normalizeWebhookEvent("opportunity.updated") === "opportunity.updated");
ok("app.installed is unchanged", normalizeWebhookEvent("app.installed") === "app.installed");

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
