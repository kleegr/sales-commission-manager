// ============================================================================
// SERVER-SIDE COMMISSION RECOMPUTE
//
// The most important piece of the Plans + Payments + Ledger slice: when a
// payment changes, OR a plan / rule changes, the commission ledger must be
// recomputed on the SERVER (not the browser) so the persisted ledger is always
// authoritative and survives reload.
//
// This module has two halves:
//   1. recomputeClientLedger()  — a PURE, DB-free function that, given one
//      client's plan + payments + the rows already in the ledger, decides which
//      payment-derived rows to delete, which fresh rows to insert, and which
//      locked rows to preserve. It is fully unit-tested (recompute.test.ts) with
//      no database, exactly like the rest of the pure logic in this repo.
//   2. A thin DB layer (loaders + applyRecompute…InTx) that reads the tenant's
//      rows, runs the pure core, and applies the deletes/inserts inside a
//      transaction. Every statement is scoped by tenant_id.
//
// SAFETY — DO NOT CORRUPT PAYOUT HISTORY
//   Rows whose status is one of LOCKED_STATUSES (submitted / approved / paid)
//   are part of an in-flight or completed payout. They are PRESERVED ENTIRELY:
//   never deleted, never re-priced, and their id (and therefore their
//   payout_batch_entries linkage) is kept intact. Only NON-locked rows
//   (pending / held / projected / clawed_back / rejected / canceled) are
//   regenerated from the current plan + timing. This is intentionally stricter
//   than the client-side recompute, which re-priced even locked rows.
//
//   The admin "Release now" flag (released_override) and a human-set workflow
//   label (rejected / canceled) are carried across a regenerate by the stable
//   key `${paymentId}:${ruleId}`, so a released or manually-labelled line keeps
//   its meaning.
// ============================================================================

import { calculateCommissionForPayment } from "../../src/lib/commission-engine.js";
import {
  normalizeTiming,
  resolveCommissionTiming,
} from "../../src/lib/commission-timing.js";
import { isoToDate, todayISO } from "../../src/lib/format.js";
import type {
  Client,
  CommissionEntry,
  CommissionPlan,
  CommissionStatus,
  Payment,
  Salesperson,
} from "../../src/types/index.js";
import { query, withTransaction, type PoolClient } from "./db.js";

const nowISO = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Status classification (pure)
// ---------------------------------------------------------------------------

/**
 * Payout-locked statuses. A row in one of these states is in (or has completed)
 * the payout workflow; recompute preserves it verbatim and a payment delete is
 * refused while any of these reference the payment.
 */
export const LOCKED_STATUSES: CommissionStatus[] = ["submitted", "approved", "paid"];

/**
 * Human-set workflow statuses whose LABEL survives a regenerate (the row may
 * still be re-priced, unlike LOCKED rows). `rejected` / `canceled` are terminal
 * manual outcomes; submitted/approved/paid are also locked (above).
 */
export const MANUAL_STATUSES: CommissionStatus[] = [
  "submitted",
  "approved",
  "paid",
  "rejected",
  "canceled",
];

export function isLocked(status: string): boolean {
  return (LOCKED_STATUSES as string[]).includes(status);
}

export function isManual(status: string): boolean {
  return (MANUAL_STATUSES as string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Pure recompute core
// ---------------------------------------------------------------------------

/** The minimal prior-ledger-row shape the recompute needs to make decisions. */
export interface PriorLedgerRow {
  id: string;
  paymentId: string | null;
  ruleId: string | null;
  status: CommissionStatus;
  paidDate: string | null;
  releasedOverride: boolean;
}

export interface RecomputeClientInput {
  client: Client;
  /** The client's current salesperson, or null if unassigned/missing. */
  salesperson: Salesperson | null;
  /** The salesperson's current plan, or null if none/missing. */
  plan: CommissionPlan | null;
  /** Every payment belonging to this client. */
  payments: Payment[];
  /** The payment-derived ledger rows already stored for this client. */
  priorRows: PriorLedgerRow[];
  /** Evaluation date ("today"); defaults to today. */
  today?: string;
}

export interface RecomputeClientResult {
  /** Ids of NON-locked payment-derived rows to delete before inserting. */
  deleteIds: string[];
  /** Fresh, timing-resolved rows to insert. */
  insertRows: CommissionEntry[];
  /** Ids of locked rows that were preserved untouched (for reporting/tests). */
  preservedIds: string[];
}

const key = (paymentId: string | null, ruleId: string | null) =>
  `${paymentId ?? ""}:${ruleId ?? ""}`;

/**
 * Recompute one client's payment-derived commission ledger. PURE: no database,
 * no clock beyond the supplied `today`, no randomness in the decision (the
 * fresh rows get new ids from the engine, which is the only non-determinism and
 * never affects amounts/statuses).
 */
export function recomputeClientLedger(
  input: RecomputeClientInput,
): RecomputeClientResult {
  const today = input.today ?? todayISO();
  const { client, salesperson, plan, payments, priorRows } = input;

  const lockedRows = priorRows.filter((r) => isLocked(r.status));
  const nonLockedRows = priorRows.filter((r) => !isLocked(r.status));

  const deleteIds = nonLockedRows.map((r) => r.id);
  const preservedIds = lockedRows.map((r) => r.id);

  // Keys of locked rows: their fresh counterpart must NOT be re-inserted (the
  // locked row already stands in for that payment+rule).
  const lockedKeys = new Set(lockedRows.map((r) => key(r.paymentId, r.ruleId)));

  // Prior state to carry across a regenerate for NON-locked rows.
  const priorByKey = new Map<string, PriorLedgerRow>();
  for (const r of nonLockedRows) priorByKey.set(key(r.paymentId, r.ruleId), r);

  const insertRows: CommissionEntry[] = [];

  // Without an assigned salesperson + plan there is nothing to regenerate; the
  // stale non-locked rows are removed (deleteIds) and locked rows are kept.
  if (!salesperson || !plan || client.salespersonId !== salesperson.id) {
    return { deleteIds, insertRows, preservedIds };
  }

  const timing = normalizeTiming(plan.timing);

  // Qualifying monthly payments at/under `today` (for the after_payments gate).
  const cutoff = isoToDate(today).getTime();
  const clientPaymentCount = payments.filter(
    (p) =>
      p.clientId === client.id &&
      p.type === "monthly_subscription" &&
      isoToDate(p.date).getTime() <= cutoff,
  ).length;

  for (const pay of payments) {
    if (pay.clientId !== client.id) continue;
    const fresh = calculateCommissionForPayment(pay, client, salesperson, plan);
    for (const entry of fresh) {
      const k = key(entry.paymentId, entry.ruleId);
      if (lockedKeys.has(k)) continue; // locked row already preserves this line

      const prior = priorByKey.get(k);
      const releasedOverride = prior?.releasedOverride ?? false;

      const t = resolveCommissionTiming({
        timing,
        earnedDate: entry.paymentDate,
        asOf: today,
        clientStatus: client.status,
        clientSignupDate: client.signupDate,
        clientCanceledDate: client.canceledDate,
        clientPaymentCount,
        releasedOverride,
      });

      // Timing owns the status UNLESS a human set a manual label we must keep
      // (rejected / canceled). submitted/approved/paid are locked above and
      // never reach here.
      const status: CommissionStatus =
        prior && isManual(prior.status) ? prior.status : t.status;

      insertRows.push({
        ...entry,
        status,
        paidDate: prior?.paidDate ?? null,
        releasedOverride,
        earnedDate: t.earnedDate,
        releaseDate: t.releaseDate,
        holdDays: t.holdDays,
        holdReason: t.reason,
        clawbackReason: t.clawbackReason,
        timingTrigger: t.trigger,
      });
    }
  }

  return { deleteIds, insertRows, preservedIds };
}

// ===========================================================================
// DB layer  (tenant-scoped; runs inside a caller-provided transaction)
// ===========================================================================

import type { Rule } from "../../src/types/index.js";

/** Load one plan + its rules (rebuilding the Rule union from metadata JSONB). */
async function loadPlanWithRules(
  c: PoolClient,
  tenantId: string,
  planId: string,
): Promise<CommissionPlan | null> {
  const { rows: planRows } = await c.query<any>(
    `SELECT * FROM commission_plans WHERE tenant_id = $1 AND id = $2`,
    [tenantId, planId],
  );
  const p = planRows[0];
  if (!p) return null;
  const { rows: ruleRows } = await c.query<any>(
    `SELECT * FROM commission_rules WHERE tenant_id = $1 AND commission_plan_id = $2 ORDER BY sort_order ASC`,
    [tenantId, planId],
  );
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? "",
    rules: ruleRows.map((r) => r.metadata as Rule),
    sampleSetupFee: Number(p.sample_setup_fee),
    sampleMonthly: Number(p.sample_monthly),
    timing: p.timing ?? undefined,
    createdAt: p.created_at || nowISO(),
  };
}

function mapClientRow(c: any): Client {
  return {
    id: c.id,
    companyName: c.company_name ?? "",
    contactName: c.contact_name ?? "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    salespersonId: c.salesperson_id ?? null,
    signupDate: c.signup_date ?? "",
    setupFee: Number(c.setup_fee_amount),
    monthlySubscription: Number(c.monthly_subscription_amount),
    status: c.status,
    canceledDate: c.canceled_date ?? null,
    notes: c.notes ?? "",
    createdAt: c.created_at || nowISO(),
  };
}

function mapSalespersonRow(r: any): Salesperson {
  return {
    id: r.id,
    name: r.name,
    email: r.email ?? "",
    phone: r.phone ?? "",
    role: r.role,
    referralCode: r.referral_code ?? "",
    status: r.status,
    commissionPlanId: r.commission_plan_id ?? null,
    weeklySalary: r.weekly_salary === null ? null : Number(r.weekly_salary),
    salaryStartDate: r.salary_start_date ?? null,
    salaryEndDate: r.salary_end_date ?? null,
    notes: r.notes ?? "",
    source: r.source,
    approvalStatus: r.approval_status,
    companyName: r.company_name ?? undefined,
    website: r.website ?? undefined,
    referralSource: r.referral_source ?? undefined,
    createdAt: r.created_at || nowISO(),
  };
}

function mapPaymentRow(p: any): Payment {
  return {
    id: p.id,
    clientId: p.client_id,
    date: p.payment_date ?? "",
    type: p.payment_type,
    amount: Number(p.amount),
    paymentNumber: p.payment_number === null ? null : Number(p.payment_number),
    notes: p.notes ?? "",
    createdAt: p.created_at || nowISO(),
  };
}

/** Insert one freshly-computed ledger row (column mapping mirrors writeState). */
async function insertLedgerRow(
  c: PoolClient,
  tenantId: string,
  planId: string | null,
  e: CommissionEntry,
): Promise<void> {
  const ts = nowISO();
  await c.query(
    `INSERT INTO commission_ledger
       (id, tenant_id, salesperson_id, client_id, payment_id, commission_plan_id, commission_rule_id,
        rule_type, payment_date, payment_type, payment_amount, commission_rule_used, commission_type,
        commission_value, commission_amount, status, due_date, paid_date, released_override,
        payout_batch_id, is_projection, notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [
      e.id, tenantId, e.salespersonId, e.clientId, e.paymentId, planId, e.ruleId,
      e.ruleType, e.paymentDate, e.paymentType, e.paymentAmount, e.ruleLabel, e.commissionValueType,
      e.commissionValue, e.commissionAmount, e.status, e.dueDate, e.paidDate, e.releasedOverride ?? false,
      null, e.isProjection ?? false, e.notes ?? "", e.createdAt || ts, ts,
    ],
  );
}

/**
 * Recompute ONE client inside an open transaction. Loads the client, its
 * salesperson + plan, its payments and its prior payment-derived rows; runs the
 * pure core; deletes non-locked rows and inserts the fresh ones. Locked rows
 * are left untouched.
 */
export async function recomputeClientInTx(
  c: PoolClient,
  tenantId: string,
  clientId: string,
  today = todayISO(),
): Promise<{ deleted: number; inserted: number; preserved: number }> {
  const { rows: clientRows } = await c.query<any>(
    `SELECT * FROM clients WHERE tenant_id = $1 AND id = $2`,
    [tenantId, clientId],
  );
  const clientRow = clientRows[0];
  if (!clientRow) return { deleted: 0, inserted: 0, preserved: 0 };
  const client = mapClientRow(clientRow);

  let salesperson: Salesperson | null = null;
  let plan: CommissionPlan | null = null;
  if (client.salespersonId) {
    const { rows: spRows } = await c.query<any>(
      `SELECT * FROM salespeople WHERE tenant_id = $1 AND id = $2`,
      [tenantId, client.salespersonId],
    );
    if (spRows[0]) {
      salesperson = mapSalespersonRow(spRows[0]);
      if (salesperson.commissionPlanId) {
        plan = await loadPlanWithRules(c, tenantId, salesperson.commissionPlanId);
      }
    }
  }

  const { rows: payRows } = await c.query<any>(
    `SELECT * FROM payments WHERE tenant_id = $1 AND client_id = $2 ORDER BY payment_date ASC`,
    [tenantId, clientId],
  );
  const payments = payRows.map(mapPaymentRow);

  const { rows: ledgerRows } = await c.query<any>(
    `SELECT id, payment_id, commission_rule_id, status, paid_date, released_override
       FROM commission_ledger
      WHERE tenant_id = $1 AND client_id = $2 AND payment_id IS NOT NULL`,
    [tenantId, clientId],
  );
  const priorRows: PriorLedgerRow[] = ledgerRows.map((r) => ({
    id: r.id,
    paymentId: r.payment_id ?? null,
    ruleId: r.commission_rule_id ?? null,
    status: r.status,
    paidDate: r.paid_date ?? null,
    releasedOverride: !!r.released_override,
  }));

  const result = recomputeClientLedger({ client, salesperson, plan, payments, priorRows, today });

  if (result.deleteIds.length > 0) {
    await c.query(
      `DELETE FROM commission_ledger WHERE tenant_id = $1 AND id = ANY($2::text[])`,
      [tenantId, result.deleteIds],
    );
  }
  const planId = salesperson?.commissionPlanId ?? null;
  for (const e of result.insertRows) await insertLedgerRow(c, tenantId, planId, e);

  return {
    deleted: result.deleteIds.length,
    inserted: result.insertRows.length,
    preserved: result.preservedIds.length,
  };
}

/** Recompute every client whose salesperson is on the given plan. */
export async function recomputePlanInTx(
  c: PoolClient,
  tenantId: string,
  planId: string,
  today = todayISO(),
): Promise<{ clients: number }> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT cl.id
       FROM clients cl
       JOIN salespeople sp ON sp.id = cl.salesperson_id AND sp.tenant_id = cl.tenant_id
      WHERE cl.tenant_id = $1 AND sp.commission_plan_id = $2`,
    [tenantId, planId],
  );
  for (const r of rows) await recomputeClientInTx(c, tenantId, r.id, today);
  return { clients: rows.length };
}

/** Recompute every client in the tenant (used by the ledger "recompute" action). */
export async function recomputeTenantInTx(
  c: PoolClient,
  tenantId: string,
  today = todayISO(),
): Promise<{ clients: number }> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM clients WHERE tenant_id = $1`,
    [tenantId],
  );
  for (const r of rows) await recomputeClientInTx(c, tenantId, r.id, today);
  return { clients: rows.length };
}

// --- standalone wrappers (own transaction) for endpoints not already in one --

export function recomputeClient(tenantId: string, clientId: string) {
  return withTransaction((c) => recomputeClientInTx(c, tenantId, clientId));
}

export function recomputePlan(tenantId: string, planId: string) {
  return withTransaction((c) => recomputePlanInTx(c, tenantId, planId));
}

export function recomputeTenant(tenantId: string) {
  return withTransaction((c) => recomputeTenantInTx(c, tenantId));
}

/** True when a payment has any LOCKED commission (blocks delete / risky edits). */
export async function paymentHasLockedCommissions(
  tenantId: string,
  paymentId: string,
): Promise<boolean> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM commission_ledger
      WHERE tenant_id = $1 AND payment_id = $2 AND status = ANY($3::text[])`,
    [tenantId, paymentId, LOCKED_STATUSES],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}
