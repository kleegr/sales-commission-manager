// Dependency-free, DB-free tests for the per-resource handler helpers.
// Run via `tsx api/_lib/handlers.test.ts` (wired into `npm test`).
import {
  readScopeFor,
  canManagePeople,
  canEditSettings,
  isSelfRole,
  parseBody,
  normalizeSalespersonInsert,
  buildSalespersonUpdate,
  normalizeSettingsInput,
  canManageGoals,
  normalizeGoalInput,
  normalizeMilestoneInput,
  FEATURE_KEYS,
  defaultFeatureFlags,
  mergeFeatureRows,
  canManageFeatures,
  normalizeFeatureFlags,
} from "./handlers.js";

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

console.log("\n[Handlers \u00b7 authorization]");
ok("owner sees whole tenant", readScopeFor("owner" as any) === "all");
ok("admin sees whole tenant", readScopeFor("admin" as any) === "all");
ok("sales_manager sees team", readScopeFor("sales_manager" as any) === "team");
ok("salesperson sees self", readScopeFor("salesperson" as any) === "self");
ok("affiliate sees self", readScopeFor("affiliate" as any) === "self");
ok("partner sees self", readScopeFor("partner" as any) === "self");

ok("owner can manage people", canManagePeople("owner" as any));
ok("admin can manage people", canManagePeople("admin" as any));
ok("sales_manager CANNOT manage people", !canManagePeople("sales_manager" as any));
ok("salesperson CANNOT manage people", !canManagePeople("salesperson" as any));
ok("affiliate CANNOT manage people", !canManagePeople("affiliate" as any));

ok("owner can edit settings", canEditSettings("owner" as any));
ok("admin can edit settings", canEditSettings("admin" as any));
ok("manager CANNOT edit settings", !canEditSettings("sales_manager" as any));
ok("salesperson CANNOT edit settings", !canEditSettings("salesperson" as any));

ok("salesperson is self role", isSelfRole("salesperson" as any));
ok("owner is not self role", !isSelfRole("owner" as any));

console.log("\n[Handlers \u00b7 body parsing]");
ok("parses JSON string body", (parseBody({ body: '{"a":1}' } as any).a as number) === 1);
ok("passes through object body", (parseBody({ body: { a: 2 } } as any).a as number) === 2);
ok("null body -> {}", Object.keys(parseBody({ body: null } as any)).length === 0);
ok("malformed JSON -> {}", Object.keys(parseBody({ body: "{bad" } as any)).length === 0);

console.log("\n[Handlers \u00b7 salesperson insert validation]");
const missingName = normalizeSalespersonInsert({});
ok("missing name rejected", !missingName.ok && missingName.error === "name_required");

const blankName = normalizeSalespersonInsert({ name: "   " });
ok("whitespace name rejected", !blankName.ok);

const good = normalizeSalespersonInsert({
  name: "  Jordan Reed  ",
  email: "jordan@x.com",
  role: "affiliate",
  weeklySalary: "500",
  commissionPlanId: "plan_1",
});
ok("valid input accepted", good.ok);
ok("name trimmed", good.ok && good.value.name === "Jordan Reed");
ok("role preserved", good.ok && good.value.role === "affiliate");
ok("weeklySalary coerced to number", good.ok && good.value.weeklySalary === 500);
ok("defaults status=active", good.ok && good.value.status === "active");
ok("defaults approvalStatus=approved", good.ok && good.value.approvalStatus === "approved");

const badRole = normalizeSalespersonInsert({ name: "X", role: "ceo" });
ok("invalid role falls back to salesperson", badRole.ok && badRole.value.role === "salesperson");

const emptySalary = normalizeSalespersonInsert({ name: "X", weeklySalary: "" });
ok("empty weeklySalary -> null", emptySalary.ok && emptySalary.value.weeklySalary === null);

console.log("\n[Handlers \u00b7 salesperson partial update]");
const emptyPatch = buildSalespersonUpdate({});
ok("empty patch rejected", !emptyPatch.ok && emptyPatch.error === "no_fields_to_update");

const namePatch = buildSalespersonUpdate({ name: "New Name" });
ok("name-only patch ok", namePatch.ok);
ok("patch maps to snake_case + updated_at", namePatch.ok && "name" in namePatch.value && "updated_at" in namePatch.value);
ok("patch does NOT touch unspecified fields", namePatch.ok && !("email" in namePatch.value));

const blankPatchName = buildSalespersonUpdate({ name: "  " });
ok("patch blank name rejected", !blankPatchName.ok);

const planPatch = buildSalespersonUpdate({ commissionPlanId: "plan_9" });
ok("commissionPlanId maps to commission_plan_id", planPatch.ok && planPatch.value.commission_plan_id === "plan_9");

const clearPlan = buildSalespersonUpdate({ commissionPlanId: "" });
ok("empty commissionPlanId clears to null", clearPlan.ok && clearPlan.value.commission_plan_id === null);

console.log("\n[Handlers \u00b7 settings validation]");
const sFlat = normalizeSettingsInput({
  companyName: "Acme",
  avgSetupFee: 3000,
  avgMonthly: 400,
  monthlyChurnPct: 150, // out of range -> clamp
  months: 999, // out of range -> clamp
});
ok("settings accepted", sFlat.ok);
ok("companyName kept", sFlat.ok && sFlat.value.companyName === "Acme");
ok("setup fee kept", sFlat.ok && sFlat.value.defaultSetupFee === 3000);
ok("churn clamped to 100", sFlat.ok && sFlat.value.churnPct === 100);
ok("months clamped to 600", sFlat.ok && sFlat.value.months === 600);

const sNested = normalizeSettingsInput({ assumptions: { avgMonthly: 250, monthlyChurnPct: 3, months: 60 } });
ok("reads nested assumptions", sNested.ok && sNested.value.defaultMonthly === 250 && sNested.value.churnPct === 3);

const sNeg = normalizeSettingsInput({ avgSetupFee: -50 });
ok("negative fee floored to 0", sNeg.ok && sNeg.value.defaultSetupFee === 0);

const sBadTheme = normalizeSettingsInput({ theme: "neon" });
ok("invalid theme falls back to light", sBadTheme.ok && sBadTheme.value.theme === "light");

console.log("\n[Handlers \u00b7 goals authorization]");
ok("owner can manage goals", canManageGoals("owner" as any));
ok("admin can manage goals", canManageGoals("admin" as any));
ok("manager can manage goals", canManageGoals("sales_manager" as any));
ok("salesperson CANNOT manage goals", !canManageGoals("salesperson" as any));
ok("affiliate CANNOT manage goals", !canManageGoals("affiliate" as any));

console.log("\n[Handlers \u00b7 goal validation]");
const gMissingTarget = normalizeGoalInput({ scopeType: "tenant", metric: "revenue" });
ok("goal needs a positive target", !gMissingTarget.ok);
const gSpNoId = normalizeGoalInput({ scopeType: "salesperson", targetValue: 1000 });
ok("salesperson goal needs a salespersonId", !gSpNoId.ok);
const gOk = normalizeGoalInput({ scopeType: "salesperson", salespersonId: "sp1", metric: "clients_closed", targetValue: 5, period: "monthly" });
ok("valid salesperson goal accepted", gOk.ok);
ok("metric preserved", gOk.ok && gOk.value.metric === "clients_closed");
ok("period preserved", gOk.ok && gOk.value.period === "monthly");
const gBadMetric = normalizeGoalInput({ scopeType: "tenant", metric: "vibes", targetValue: 9 });
ok("invalid metric falls back to revenue", gBadMetric.ok && gBadMetric.value.metric === "revenue");
const gTeam = normalizeGoalInput({ scopeType: "team", managerUserId: "u9", targetValue: 50000 });
ok("team goal keeps managerUserId", gTeam.ok && gTeam.value.managerUserId === "u9");
ok("tenant goal clears salespersonId", gBadMetric.ok && gBadMetric.value.salespersonId === null);

console.log("\n[Handlers \u00b7 milestone validation]");
const mNoGoal = normalizeMilestoneInput({ thresholdValue: 100 });
ok("milestone needs a goalId", !mNoGoal.ok);
const mNoThreshold = normalizeMilestoneInput({ goalId: "g1" });
ok("milestone needs a positive threshold", !mNoThreshold.ok);
const mOk = normalizeMilestoneInput({ goalId: "g1", title: "Halfway", thresholdValue: 2500, reward: "$100" });
ok("valid milestone accepted", mOk.ok && mOk.value.thresholdValue === 2500 && mOk.value.reward === "$100");

console.log("\n[Handlers \u00b7 feature access authorization]");
ok("owner can manage features", canManageFeatures("owner" as any));
ok("admin can manage features", canManageFeatures("admin" as any));
ok("manager CANNOT manage features", !canManageFeatures("sales_manager" as any));
ok("salesperson CANNOT manage features", !canManageFeatures("salesperson" as any));
ok("affiliate CANNOT manage features", !canManageFeatures("affiliate" as any));

console.log("\n[Handlers \u00b7 feature defaults + merge]");
const defs = defaultFeatureFlags();
ok("eight canonical features", FEATURE_KEYS.length === 8);
ok("all features default ON", FEATURE_KEYS.every((k) => defs[k] === true));
ok("merge: no rows -> all on", mergeFeatureRows([]).reports === true);
const merged = mergeFeatureRows([
  { feature: "reports", enabled: false },
  { feature: "ai", enabled: false },
  { feature: "bogus", enabled: false }, // unknown key ignored
]);
ok("merge: override disables reports", merged.reports === false);
ok("merge: override disables ai", merged.ai === false);
ok("merge: untouched feature stays on", merged.commissions === true);
ok("merge: unknown key ignored (no leak)", !("bogus" in merged));

console.log("\n[Handlers \u00b7 feature flag validation]");
const fEmpty = normalizeFeatureFlags({});
ok("empty patch rejected", !fEmpty.ok && fEmpty.error === "no_known_features");
const fUnknownOnly = normalizeFeatureFlags({ vibes: true, lol: false });
ok("unknown-only patch rejected", !fUnknownOnly.ok);
const fFlat = normalizeFeatureFlags({ reports: false, payouts: "off", commissions: 1 });
ok("flat patch accepted", fFlat.ok);
ok("boolean false kept", fFlat.ok && fFlat.value.reports === false);
ok('"off" coerced to false', fFlat.ok && fFlat.value.payouts === false);
ok("truthy number coerced to true", fFlat.ok && fFlat.value.commissions === true);
ok("absent feature not in patch", fFlat.ok && !("ai" in fFlat.value));
const fWrapped = normalizeFeatureFlags({ features: { proposals: false } });
ok("wrapped {features:{…}} accepted", fWrapped.ok && fWrapped.value.proposals === false);
const fIgnore = normalizeFeatureFlags({ proposals: true, tenant_id: "evil", role: "owner" });
ok("non-feature keys ignored (no tenant_id trust)", fIgnore.ok && !("tenant_id" in (fIgnore.value as any)));

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
