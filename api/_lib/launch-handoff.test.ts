// Tests for the Kleegr launch handoff document (the mobile-WebView auth fix).
// Run via `tsx api/_lib/launch-handoff.test.ts` (wired into `npm test`).
import {
  renderLaunchHandoff,
  jsStringLiteral,
  htmlAttr,
  SESSION_STORAGE_KEY,
  SP_PERMS_STORAGE_KEY,
} from "./launch-handoff.js";

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

console.log("\n[Launch handoff · script-literal escaping]");

ok("plain value round-trips as a JS string", jsStringLiteral("abc-123") === '"abc-123"');
ok("no raw < survives (cannot open a tag)", !jsStringLiteral("a<b").includes("<"));
ok("no raw > survives", !jsStringLiteral("a>b").includes(">"));
ok("a </script> payload cannot close the element", !jsStringLiteral("</script>").includes("</"));
ok("an <!-- payload cannot open an HTML comment", !jsStringLiteral("<!--x").includes("<!--"));
ok("escaped form still decodes to the original", JSON.parse(jsStringLiteral("a<b>&c")) === "a<b>&c");
ok("quotes stay escaped", JSON.parse(jsStringLiteral('he said "hi"')) === 'he said "hi"');
ok("U+2028 is escaped (not a raw line terminator)", !jsStringLiteral("a\u2028b").includes("\u2028"));

console.log("\n[Launch handoff · attribute escaping]");

ok("ampersand escaped", htmlAttr("/?a=1&b=2") === "/?a=1&amp;b=2");
ok("double quote escaped (cannot break out of href)", !htmlAttr('"onload=x').includes('"'));
ok("angle brackets escaped", htmlAttr("<x>") === "&lt;x&gt;");

console.log("\n[Launch handoff · document]");

const TOKEN = "s3ss10n-t0ken_ABC-xyz";
const html = renderLaunchHandoff("/portal?kleegr=connected", TOKEN);

ok("is an HTML document", html.startsWith("<!doctype html>"));
ok("writes the token under the agreed localStorage key", html.includes(`localStorage.setItem("${SESSION_STORAGE_KEY}"`));
ok("key matches the client's contract", SESSION_STORAGE_KEY === "scm_session_token");
ok("carries the session token", html.includes(TOKEN));
ok("navigates with location.replace (no history entry for the launch URL)", html.includes("window.location.replace("));
ok("does NOT use location.assign/href (would keep the launch token in history)", !html.includes("location.href="));
ok("targets the role's workspace", html.includes("/portal?kleegr=connected"));
ok("localStorage write is wrapped in try/catch", /try\{window\.localStorage\.setItem\([^)]*\)\}catch/.test(html));
ok("has a <noscript> fallback to the same target", html.includes("<noscript>") && html.includes('href="/portal?kleegr=connected"'));
ok("exactly one <script> element", html.split("<script>").length - 1 === 1);
ok("exactly one </script> close", html.split("</script>").length - 1 === 1);

// A hostile target/token must not be able to inject markup or extra script.
const evil = renderLaunchHandoff("/x?y=</script><script>alert(1)</script>", "tok</script>en");
ok("hostile target cannot inject a second <script>", evil.split("<script>").length - 1 === 1);
ok("hostile token cannot close the script element early", evil.split("</script>").length - 1 === 1);
ok("hostile target is escaped in the noscript href", !evil.includes('href="/x?y=</script>'));

console.log("\n[Launch handoff · role targets]");
for (const target of ["/agency?kleegr=connected", "/?kleegr=connected", "/portal?kleegr=connected"]) {
  const doc = renderLaunchHandoff(target, TOKEN);
  ok(`renders for ${target}`, doc.includes(JSON.stringify(target).replace(/</g, "\\u003c")) || doc.includes(target));
}

console.log("\n[Launch handoff · SP permissions blob]");

ok("perms key matches the client's contract", SP_PERMS_STORAGE_KEY === "scm_sp_perms");

// No policy → the key is CLEARED (standalone / non-SP launch stays permissive).
const noPerms = renderLaunchHandoff("/portal?kleegr=connected", TOKEN);
ok("the perms key appears in the handoff script", noPerms.includes(SP_PERMS_STORAGE_KEY));
ok("no policy → the runtime value is null (clears the key)", /var p=null;/.test(noPerms));
ok("session token write is untouched by the perms feature", /try\{window\.localStorage\.setItem\([^)]*\)\}catch/.test(noPerms));
ok("still exactly one <script> with no policy", noPerms.split("<script>").length - 1 === 1);

// With a policy → the runtime `p` is the JSON blob (not null), written under the key.
const policy = { canManagePlans: false, maxPlans: 3, canApprovePayouts: true, canExportReports: false };
const withPerms = renderLaunchHandoff("/?kleegr=connected", TOKEN, policy);
ok("a policy → the runtime value is NOT null", !/var p=null;/.test(withPerms));
ok("carries the policy fields", withPerms.includes("canManagePlans") && withPerms.includes("maxPlans"));
ok("still exactly one <script> with a policy", withPerms.split("<script>").length - 1 === 1);
ok("still exactly one </script> with a policy", withPerms.split("</script>").length - 1 === 1);

// A hostile policy value cannot break out of the script element.
const evilPolicy = renderLaunchHandoff("/?kleegr=connected", TOKEN, { x: "</script><script>alert(1)</script>" });
ok("hostile policy cannot inject a second <script>", evilPolicy.split("<script>").length - 1 === 1);
ok("hostile policy cannot close the script element early", evilPolicy.split("</script>").length - 1 === 1);

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
