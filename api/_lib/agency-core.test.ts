// Dependency-free, DB-free tests for the agency rollup math.
// Run via `tsx api/_lib/agency-core.test.ts` (wired into `npm test`).
import {
  emptyAggregate,
  assembleRollup,
  summarizeAgency,
  type TenantMeta,
  type RawTenantAggregate,
  type TenantRollup,
} from "./agency-core.js";

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
const approx = (a: number, b: number) => Math.abs(a - b) < 1e-6;

const meta = (over: Partial<TenantMeta> = {}): TenantMeta => ({
  tenantId: "t1",
  slug: "acme",
  name: "Acme Partners",
  status: "active",
  ghlLocationId: "ghl_loc_acme_002",
  ...over,
});

function agg(over: Partial<RawTenantAggregate> = {}): RawTenantAggregate {
  return { ...emptyAggregate("t1"), ...over };
}

console.log("\n[Agency \u00b7 emptyAggregate]");
{
  const e = emptyAggregate("t9");
  ok("tenantId carried", e.tenantId === "t9");
  ok("all numeric fields zero", e.grossRevenue === 0 && e.commPaid === 0 && e.payouts === 0 && e.documents === 0);
  ok("lastActivityAt null", e.lastActivityAt === null);
}

console.log("\n[Agency \u00b7 assembleRollup revenue]");
{
  const r = assembleRollup(meta(), agg({ grossRevenue: 10000, refunds: 1500 }), {});
  ok("gross passthrough", r.revenue.gross === 10000);
  ok("refunds passthrough", r.revenue.refunds === 1500);
  ok("net = gross - refunds", r.revenue.net === 8500);
}
{
  // refunds subtract exactly like analytics.revenueInRange
  const r = assembleRollup(meta(), agg({ grossRevenue: 1000.005, refunds: 0.005 }), {});
  ok("net rounded to cents", approx(r.revenue.net, 1000));
}

console.log("\n[Agency \u00b7 assembleRollup commissions]");
{
  const r = assembleRollup(
    meta(),
    agg({ commPaid: 500, commPending: 300, commHeld: 200, commClawedBack: 50, commProjected: 9999 }),
    {},
  );
  ok("paid passthrough", r.commissions.paid === 500);
  ok("liability = pending + held", r.commissions.liability === 500);
  ok("clawed-back tracked separately", r.commissions.clawedBack === 50);
  ok("projected excluded from liability", r.commissions.liability === 500 && r.commissions.projected === 9999);
}

console.log("\n[Agency \u00b7 assembleRollup payouts]");
{
  const r = assembleRollup(
    meta(),
    agg({
      payoutSubmittedN: 1,
      payoutSubmittedAmt: 400,
      payoutApprovedN: 2,
      payoutApprovedAmt: 600,
      payoutPaidN: 3,
      payoutPaidAmt: 900,
    }),
    {},
  );
  ok("submitted bucket", r.payouts.submitted.count === 1 && r.payouts.submitted.amount === 400);
  ok("paid bucket", r.payouts.paid.count === 3 && r.payouts.paid.amount === 900);
  ok("pendingAmount = submitted + approved", r.payouts.pendingAmount === 1000);
}

console.log("\n[Agency \u00b7 assembleRollup status + features]");
{
  const active = assembleRollup(meta({ status: "active" }), agg(), {});
  ok("active tenant appEnabled", active.appEnabled === true);
  const suspended = assembleRollup(meta({ status: "suspended" }), agg(), {});
  ok("non-active tenant not appEnabled", suspended.appEnabled === false);

  // null flags => fail-open: everything enabled, nothing disabled
  const open = assembleRollup(meta(), agg(), null);
  ok("null flags fail open (all enabled)", open.disabledFeatures.length === 0 && open.features.reports === true);

  // explicit overrides surface in disabledFeatures
  const gated = assembleRollup(meta(), agg(), { reports: false, ai: false });
  ok("disabled features listed", gated.disabledFeatures.includes("reports") && gated.disabledFeatures.includes("ai"));
  ok("enabled features not listed", !gated.disabledFeatures.includes("commissions"));
  ok("flag map reflects override", gated.features.reports === false && gated.features.commissions === true);
}

console.log("\n[Agency \u00b7 assembleRollup documents + counts]");
{
  const r = assembleRollup(
    meta(),
    agg({ documents: 5, proposals: 3, contracts: 2, docsSigned: 1, salespeople: 7, activeSalespeople: 5, clients: 12 }),
    {},
  );
  ok("documents total", r.documents.total === 5 && r.documents.proposals === 3 && r.documents.contracts === 2);
  ok("doc lifecycle counts", r.documents.signed === 1);
  ok("people counts passthrough", r.counts.salespeople === 7 && r.counts.activeSalespeople === 5);
  ok("client count passthrough", r.counts.clients === 12);
}

console.log("\n[Agency \u00b7 summarizeAgency]");
{
  const rollups: TenantRollup[] = [
    assembleRollup(meta({ slug: "demo", status: "active" }), agg({ grossRevenue: 10000, refunds: 0, commPaid: 1000, commPending: 200, commHeld: 100, salespeople: 4, clients: 6, documents: 3 }), {}),
    assembleRollup(meta({ slug: "acme", status: "active" }), agg({ grossRevenue: 5000, refunds: 500, commPaid: 400, commPending: 100, commHeld: 0, salespeople: 2, clients: 3, documents: 1 }), {}),
    assembleRollup(meta({ slug: "old", status: "suspended" }), agg(), {}),
  ];
  const s = summarizeAgency(rollups);
  ok("tenantCount", s.tenantCount === 3);
  ok("activeTenants counts only active", s.activeTenants === 2);
  ok("totalRevenue sums net", s.totalRevenue === 10000 + 4500);
  ok("totalCommissionsPaid sums", s.totalCommissionsPaid === 1400);
  ok("totalCommissionLiability = pending+held across", s.totalCommissionLiability === 200 + 100 + 100);
  ok("totalSalespeople sums", s.totalSalespeople === 6);
  ok("totalClients sums", s.totalClients === 9);
  ok("totalDocuments sums", s.totalDocuments === 4);
}
{
  const s = summarizeAgency([]);
  ok("empty agency summary safe", s.tenantCount === 0 && s.totalRevenue === 0 && s.activeTenants === 0);
}

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
