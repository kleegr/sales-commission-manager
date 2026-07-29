// Tests the launch / first-sync IMPORT gate (KLEEGR_SYNC_ENABLED). When off (the
// production-safe default) a launch must NOT auto-import users/contacts/
// opportunities — only the sub-account profile is refreshed.
import { syncImportEnabled } from "./kleegr-sync.js";

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

const KEY = "KLEEGR_SYNC_ENABLED";
const saved = process.env[KEY];
function setEnv(v: string | undefined) {
  if (v === undefined) delete process.env[KEY];
  else process.env[KEY] = v;
}

console.log("\n[Kleegr · first-sync import gate]");
setEnv(undefined);
ok("import OFF by default (unset)", syncImportEnabled() === false);
setEnv("");
ok("import OFF for empty", syncImportEnabled() === false);
setEnv("off");
ok("import OFF for a non-affirmative value", syncImportEnabled() === false);
setEnv("false");
ok("import OFF for false", syncImportEnabled() === false);
setEnv("1");
ok("import ON for 1", syncImportEnabled() === true);
setEnv("true");
ok("import ON for true", syncImportEnabled() === true);
setEnv("on");
ok("import ON for on", syncImportEnabled() === true);
setEnv("yes");
ok("import ON for yes", syncImportEnabled() === true);
setEnv(saved);

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
