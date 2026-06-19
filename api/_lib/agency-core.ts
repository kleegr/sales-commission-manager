// ============================================================================
// AGENCY CORE  (pure, DB-free)
//
// The agency / super-admin overview rolls up EACH sub-account (tenant) into a
// single set of headline numbers: revenue, commission liability vs paid, payout
// status, document counts, feature access, and last activity. This module is
// the PURE part of that feature — it takes already-aggregated rows (the SQL
// lives in repository.ts) and shapes them into the response the Agency page
// renders, plus the cross-tenant summary.
//
// Keeping it pure (no DB, no I/O) means the financial roll-up math is unit
// tested without a database, exactly like commission-timing and documents-core.
//
// IMPORTANT (tenant isolation): nothing here reads data. The endpoint decides
// WHICH tenants the caller may see (all tenants only in trusted review/demo
// mode; otherwise just the caller's own tenant) before any of these run.
//
// IMPORTANT (lane): these numbers are aggregated from the PERSISTED ledger rows
// (commission_ledger.status / .is_projection) — they are NOT a re-derivation of
// the commission-timing resolver. Exact display-time timing reconciliation is
// the server-recompute work (commission plans/payments/ledger DB APIs), which
// is intentionally out of this lane.
// ============================================================================

import {
  coerceFeatures,
  FEATURE_KEYS,
  type FeatureFlags,
  type FeatureKey,
} from "../../src/lib/features.js";

/** Static tenant facts (from the tenants row). */
export interface TenantMeta {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  ghlLocationId: string | null;
}

/** One tenant's raw, already-summed aggregates (produced by repository SQL). */
export interface RawTenantAggregate {
  tenantId: string;
  // counts
  salespeople: number;
  activeSalespeople: number;
  clients: number;
  activeClients: number;
  plans: number;
  payments: number;
  payouts: number;
  documents: number;
  // revenue (refunds stored positive; net subtracts them — matches analytics.ts)
  grossRevenue: number;
  refunds: number;
  // commissions by PERSISTED status (projections excluded except `projected`)
  commPaid: number;
  commPending: number; // pending + submitted + approved
  commHeld: number;
  commClawedBack: number;
  commProjected: number;
  // payouts by workflow status
  payoutSubmittedN: number;
  payoutSubmittedAmt: number;
  payoutApprovedN: number;
  payoutApprovedAmt: number;
  payoutPaidN: number;
  payoutPaidAmt: number;
  payoutRejectedN: number;
  payoutRejectedAmt: number;
  // documents by kind / lifecycle
  proposals: number;
  contracts: number;
  docsSigned: number;
  docsSent: number;
  docsDraft: number;
  // activity
  lastActivityAt: string | null;
}

interface PayoutBucket {
  count: number;
  amount: number;
}

/** The shaped per-tenant rollup the Agency page consumes. */
export interface TenantRollup {
  slug: string;
  name: string;
  status: string;
  appEnabled: boolean;
  ghlLocationId: string | null;
  counts: {
    salespeople: number;
    activeSalespeople: number;
    clients: number;
    activeClients: number;
    plans: number;
    payments: number;
    payouts: number;
    documents: number;
  };
  revenue: { gross: number; refunds: number; net: number };
  commissions: {
    paid: number;
    pending: number;
    held: number;
    clawedBack: number;
    projected: number;
    /** Owed but unpaid (pending + held), excluding projections. */
    liability: number;
  };
  payouts: {
    submitted: PayoutBucket;
    approved: PayoutBucket;
    paid: PayoutBucket;
    rejected: PayoutBucket;
    /** Submitted + approved (awaiting payment). */
    pendingAmount: number;
  };
  documents: {
    total: number;
    proposals: number;
    contracts: number;
    signed: number;
    sent: number;
    draft: number;
  };
  features: FeatureFlags;
  disabledFeatures: FeatureKey[];
  lastActivityAt: string | null;
}

/** All-zero aggregate for a tenant that has no business rows yet. */
export function emptyAggregate(tenantId: string): RawTenantAggregate {
  return {
    tenantId,
    salespeople: 0,
    activeSalespeople: 0,
    clients: 0,
    activeClients: 0,
    plans: 0,
    payments: 0,
    payouts: 0,
    documents: 0,
    grossRevenue: 0,
    refunds: 0,
    commPaid: 0,
    commPending: 0,
    commHeld: 0,
    commClawedBack: 0,
    commProjected: 0,
    payoutSubmittedN: 0,
    payoutSubmittedAmt: 0,
    payoutApprovedN: 0,
    payoutApprovedAmt: 0,
    payoutPaidN: 0,
    payoutPaidAmt: 0,
    payoutRejectedN: 0,
    payoutRejectedAmt: 0,
    proposals: 0,
    contracts: 0,
    docsSigned: 0,
    docsSent: 0,
    docsDraft: 0,
    lastActivityAt: null,
  };
}

/** Shape one tenant's raw aggregate + flags into the rendered rollup. */
export function assembleRollup(
  meta: TenantMeta,
  agg: RawTenantAggregate,
  flags: Record<string, boolean> | null | undefined,
): TenantRollup {
  const net = round2(agg.grossRevenue - agg.refunds);
  const liability = round2(agg.commPending + agg.commHeld);
  const features = coerceFeatures(flags);
  const disabledFeatures = FEATURE_KEYS.filter((k) => features[k] === false);

  return {
    slug: meta.slug,
    name: meta.name,
    status: meta.status,
    appEnabled: meta.status === "active",
    ghlLocationId: meta.ghlLocationId,
    counts: {
      salespeople: agg.salespeople,
      activeSalespeople: agg.activeSalespeople,
      clients: agg.clients,
      activeClients: agg.activeClients,
      plans: agg.plans,
      payments: agg.payments,
      payouts: agg.payouts,
      documents: agg.documents,
    },
    revenue: { gross: round2(agg.grossRevenue), refunds: round2(agg.refunds), net },
    commissions: {
      paid: round2(agg.commPaid),
      pending: round2(agg.commPending),
      held: round2(agg.commHeld),
      clawedBack: round2(agg.commClawedBack),
      projected: round2(agg.commProjected),
      liability,
    },
    payouts: {
      submitted: { count: agg.payoutSubmittedN, amount: round2(agg.payoutSubmittedAmt) },
      approved: { count: agg.payoutApprovedN, amount: round2(agg.payoutApprovedAmt) },
      paid: { count: agg.payoutPaidN, amount: round2(agg.payoutPaidAmt) },
      rejected: { count: agg.payoutRejectedN, amount: round2(agg.payoutRejectedAmt) },
      pendingAmount: round2(agg.payoutSubmittedAmt + agg.payoutApprovedAmt),
    },
    documents: {
      total: agg.documents,
      proposals: agg.proposals,
      contracts: agg.contracts,
      signed: agg.docsSigned,
      sent: agg.docsSent,
      draft: agg.docsDraft,
    },
    features,
    disabledFeatures,
    lastActivityAt: agg.lastActivityAt,
  };
}

/** Cross-tenant totals shown above the per-sub-account cards. */
export interface AgencySummary {
  tenantCount: number;
  activeTenants: number;
  totalRevenue: number; // net
  totalCommissionsPaid: number;
  totalCommissionLiability: number;
  totalSalespeople: number;
  totalClients: number;
  totalPayoutsPending: number;
  totalDocuments: number;
}

export function summarizeAgency(rollups: TenantRollup[]): AgencySummary {
  const s: AgencySummary = {
    tenantCount: rollups.length,
    activeTenants: 0,
    totalRevenue: 0,
    totalCommissionsPaid: 0,
    totalCommissionLiability: 0,
    totalSalespeople: 0,
    totalClients: 0,
    totalPayoutsPending: 0,
    totalDocuments: 0,
  };
  for (const r of rollups) {
    if (r.appEnabled) s.activeTenants += 1;
    s.totalRevenue += r.revenue.net;
    s.totalCommissionsPaid += r.commissions.paid;
    s.totalCommissionLiability += r.commissions.liability;
    s.totalSalespeople += r.counts.salespeople;
    s.totalClients += r.counts.clients;
    s.totalPayoutsPending += r.payouts.pendingAmount;
    s.totalDocuments += r.documents.total;
  }
  s.totalRevenue = round2(s.totalRevenue);
  s.totalCommissionsPaid = round2(s.totalCommissionsPaid);
  s.totalCommissionLiability = round2(s.totalCommissionLiability);
  s.totalPayoutsPending = round2(s.totalPayoutsPending);
  return s;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
