// ============================================================================
// PAYOUTS REPOSITORY  (real per-resource DB writes — not snapshot replace-all)
//
// The payout workflow is the first fully database-backed, role-aware workflow:
// every action is a targeted INSERT/UPDATE inside a transaction, and every
// state transition is appended to payout_events (the audit history). Nothing
// here does a tenant-wide replace; concurrent edits to unrelated rows are safe.
//
// Lifecycle:  pending --submit--> submitted --approve--> approved --pay--> paid
//                         \--reject--> (entries back to pending)
//                          \--cancel--> canceled (paid entries become clawed_back)
// ============================================================================

import { query, withTransaction, type PoolClient } from "./db.js";

const nowISO = () => new Date().toISOString();
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export type PayoutAction = "submit" | "approve" | "reject" | "mark_paid" | "cancel";

/**
 * Who assembled the batch. `admin_batch` is the classic flow (an admin selects
 * lines on the Payouts screen); `withdrawal_request` is a rep asking to be paid
 * from their own available balance. Same lifecycle, same authorization — only
 * the origin differs.
 */
export type PayoutKind = "admin_batch" | "withdrawal_request";

export interface PayoutActor {
  userId: string;
  role: string;
}

/** One line of a batch, read from the immutable snapshot taken at submit time. */
export interface PayoutLine {
  commissionEntryId: string;
  commissionAmount: number;
  clientId: string | null;
  ruleLabel: string;
  paymentDate: string;
  /** False when the ledger row behind this line no longer exists. */
  linked: boolean;
}

export interface PayoutListItem {
  id: string;
  salespersonId: string;
  salespersonName: string;
  kind: PayoutKind;
  status: string;
  totalAmount: number;
  entryCount: number;
  notes: string;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  lines: PayoutLine[];
  events: Array<{ toStatus: string; fromStatus: string | null; actorRole: string | null; note: string; at: string }>;
}

/** Which salesperson ids a user may act on / see, within their tenant. */
async function visibleSalespeople(tenantId: string, actor: PayoutActor, salespersonId: string | null): Promise<Set<string> | "all"> {
  if (actor.role === "owner" || actor.role === "admin") return "all";
  if (actor.role === "sales_manager") {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM salespeople WHERE tenant_id = $1 AND manager_user_id = $2`,
      [tenantId, actor.userId],
    );
    return new Set(rows.map((r) => r.id));
  }
  return new Set(salespersonId ? [salespersonId] : []);
}

export async function listPayouts(
  tenantId: string,
  actor: PayoutActor,
  actorSalespersonId: string | null,
): Promise<PayoutListItem[]> {
  const visible = await visibleSalespeople(tenantId, actor, actorSalespersonId);

  const { rows } = await query<any>(
    `SELECT b.*, s.name AS sp_name,
            (SELECT count(*) FROM payout_batch_entries e WHERE e.payout_batch_id = b.id) AS entry_count
       FROM payout_batches b
       LEFT JOIN salespeople s ON s.id = b.salesperson_id
      WHERE b.tenant_id = $1
      ORDER BY b.created_at DESC`,
    [tenantId],
  );
  const filtered = rows.filter((r) => visible === "all" || visible.has(r.salesperson_id));
  if (filtered.length === 0) return [];

  const ids = filtered.map((r) => r.id);
  const { rows: evRows } = await query<any>(
    `SELECT * FROM payout_events WHERE payout_batch_id = ANY($1::text[]) ORDER BY created_at ASC`,
    [ids],
  );
  const evByBatch = new Map<string, any[]>();
  for (const e of evRows) {
    const list = evByBatch.get(e.payout_batch_id) ?? [];
    list.push(e);
    evByBatch.set(e.payout_batch_id, list);
  }

  // Lines come from the batch's own snapshot, LEFT JOINed to the ledger only to
  // report whether the underlying row still exists. The amounts shown are the
  // ones that were submitted and approved — never a later re-priced value.
  const { rows: lineRows } = await query<any>(
    `SELECT e.payout_batch_id, e.commission_entry_id, e.commission_amount,
            e.client_id, e.rule_label, e.payment_date,
            (l.id IS NOT NULL) AS linked
       FROM payout_batch_entries e
       LEFT JOIN commission_ledger l
         ON l.id = e.commission_entry_id AND l.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1 AND e.payout_batch_id = ANY($2::text[])`,
    [tenantId, ids],
  );
  const linesByBatch = new Map<string, PayoutLine[]>();
  for (const l of lineRows) {
    const list = linesByBatch.get(l.payout_batch_id) ?? [];
    list.push({
      commissionEntryId: l.commission_entry_id,
      commissionAmount: Number(l.commission_amount ?? 0),
      clientId: l.client_id ?? null,
      ruleLabel: l.rule_label ?? "",
      paymentDate: l.payment_date ?? "",
      linked: !!l.linked,
    });
    linesByBatch.set(l.payout_batch_id, list);
  }

  return filtered.map((r) => ({
    id: r.id,
    salespersonId: r.salesperson_id,
    salespersonName: r.sp_name ?? "—",
    kind: (r.kind === "withdrawal_request" ? "withdrawal_request" : "admin_batch") as PayoutKind,
    status: r.status,
    totalAmount: Number(r.total_amount),
    entryCount: Number(r.entry_count),
    notes: r.notes ?? "",
    createdAt: r.created_at || "",
    submittedAt: r.submitted_at ?? null,
    approvedAt: r.approved_at ?? null,
    paidAt: r.paid_at ?? null,
    lines: linesByBatch.get(r.id) ?? [],
    events: (evByBatch.get(r.id) ?? []).map((e) => ({
      toStatus: e.to_status,
      fromStatus: e.from_status ?? null,
      actorRole: e.actor_role ?? null,
      note: e.note ?? "",
      at: e.created_at ? new Date(e.created_at).toISOString() : "",
    })),
  }));
}

async function logEvent(
  c: PoolClient,
  tenantId: string,
  batchId: string,
  from: string | null,
  to: string,
  actor: PayoutActor,
  note: string,
): Promise<void> {
  await c.query(
    `INSERT INTO payout_events (id, tenant_id, payout_batch_id, from_status, to_status, actor_user_id, actor_role, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uid("pe"), tenantId, batchId, from, to, actor.userId, actor.role, note],
  );
}

export class PayoutError extends Error {
  constructor(public code: string, public status = 400) {
    super(code);
  }
}

/**
 * SUBMIT: bundle pending ledger entries into a new payout batch.
 *
 * `kind` distinguishes an admin-assembled batch from a rep's own self-service
 * withdrawal request. Both are payout_batches and both run the identical
 * approve → mark-paid workflow — the kind only changes who created it and how
 * the Payouts screen groups it, so a withdrawal request cannot bypass any of
 * the approval, separation-of-duties or role checks below.
 */
export async function submitPayout(
  tenantId: string,
  actor: PayoutActor,
  actorSalespersonId: string | null,
  salespersonId: string,
  entryIds: string[],
  notes: string,
  kind: PayoutKind = "admin_batch",
): Promise<{ id: string }> {
  if (!salespersonId || entryIds.length === 0) throw new PayoutError("nothing_to_submit");

  // permission: who may submit for this salesperson?
  const visible = await visibleSalespeople(tenantId, actor, actorSalespersonId);
  if (visible !== "all" && !visible.has(salespersonId)) throw new PayoutError("forbidden", 403);

  return withTransaction(async (c) => {
    // validate the entries: same tenant + salesperson, still pending, not already in a batch
    const { rows: entries } = await c.query<any>(
      `SELECT id, commission_amount, status, client_id, commission_rule_used, payment_date
         FROM commission_ledger
        WHERE tenant_id = $1 AND salesperson_id = $2 AND id = ANY($3::text[]) FOR UPDATE`,
      [tenantId, salespersonId, entryIds],
    );
    if (entries.length !== entryIds.length) throw new PayoutError("entry_mismatch");
    const bad = entries.find((e) => e.status !== "pending");
    if (bad) throw new PayoutError("entry_not_pending");

    const total = entries.reduce((s, e) => s + Number(e.commission_amount), 0);
    const id = uid("po");
    const ts = nowISO();

    await c.query(
      `INSERT INTO payout_batches
         (id, tenant_id, salesperson_id, status, total_amount, submitted_at, created_by_user_id,
          kind, requested_by_user_id, notes, created_at, updated_at)
       VALUES ($1,$2,$3,'submitted',$4,$5,$6,$7,$8,$9,$10,$10)`,
      [id, tenantId, salespersonId, total, ts, actor.userId, kind,
       kind === "withdrawal_request" ? actor.userId : null, notes ?? "", ts],
    );
    // The entry row carries an IMMUTABLE SNAPSHOT of the line as submitted:
    // amount, rule label, client and date. The ledger row it points at can later
    // be re-priced by a recompute (its id survives — see recompute.ts) or, in the
    // worst case, removed entirely; either way the batch can still show exactly
    // what was approved and paid. A financial audit trail cannot depend on rows
    // that are still allowed to change.
    for (const e of entries) {
      await c.query(
        `INSERT INTO payout_batch_entries
           (payout_batch_id, commission_entry_id, tenant_id, commission_amount,
            salesperson_id, client_id, rule_label, payment_date, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [id, e.id, tenantId, Number(e.commission_amount), salespersonId,
         e.client_id ?? null, e.commission_rule_used ?? "", e.payment_date ?? "", ts],
      );
    }
    await c.query(
      `UPDATE commission_ledger SET status = 'submitted', payout_batch_id = $1, updated_at = $2
        WHERE tenant_id = $3 AND id = ANY($4::text[])`,
      [id, ts, tenantId, entryIds],
    );
    await logEvent(c, tenantId, id, "pending", "submitted", actor, notes ?? "");
    return { id };
  });
}

async function loadBatch(c: PoolClient, tenantId: string, batchId: string) {
  const { rows } = await c.query<any>(
    `SELECT * FROM payout_batches WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, batchId],
  );
  return rows[0] ?? null;
}

async function batchEntryIds(c: PoolClient, batchId: string): Promise<string[]> {
  const { rows } = await c.query<{ commission_entry_id: string }>(
    `SELECT commission_entry_id FROM payout_batch_entries WHERE payout_batch_id = $1`,
    [batchId],
  );
  return rows.map((r) => r.commission_entry_id);
}

// ---------------------------------------------------------------------------
// Payout authorization (pure, unit-tested in payouts-authz.test.ts)
// ---------------------------------------------------------------------------

/** Coarse role gate: may this role perform this action at all? */
export function roleMayTransition(action: Exclude<PayoutAction, "submit">, role: string): boolean {
  const canApprove = ["owner", "admin", "sales_manager"].includes(role);
  const canPayOrCancel = ["owner", "admin"].includes(role);
  if (action === "approve" || action === "reject") return canApprove;
  return canPayOrCancel; // mark_paid | cancel
}

/**
 * Team scope (H-3): owner/admin act on any batch; a sales_manager may act ONLY
 * on batches whose salesperson is on their team (`visible`). Anyone else is
 * confined to their own visible set.
 */
export function mayActOnBatch(
  role: string,
  visible: Set<string> | "all",
  batchSalespersonId: string,
): boolean {
  if (role === "owner" || role === "admin") return true;
  if (visible === "all") return true;
  return visible.has(batchSalespersonId);
}

/**
 * Separation of duties: the person who APPROVES a batch must not be the person
 * who submitted it. `owner` is exempt so a solo operator can still function.
 */
export function violatesSeparationOfDuties(
  action: string,
  role: string,
  submitterUserId: string | null,
  actorUserId: string,
): boolean {
  if (action !== "approve") return false;
  if (role === "owner") return false;
  return !!submitterUserId && submitterUserId === actorUserId;
}

/** Run an approve/reject/pay/cancel transition with role + state checks. */
export async function transitionPayout(
  tenantId: string,
  actor: PayoutActor,
  action: Exclude<PayoutAction, "submit">,
  batchId: string,
  note: string,
): Promise<void> {
  if (!roleMayTransition(action, actor.role)) throw new PayoutError("forbidden", 403);

  await withTransaction(async (c) => {
    const batch = await loadBatch(c, tenantId, batchId);
    if (!batch) throw new PayoutError("not_found", 404);

    // H-3 team scope: a sales_manager may only act on their OWN team's batches.
    if (actor.role === "sales_manager") {
      const visible = await visibleSalespeople(tenantId, actor, null);
      if (!mayActOnBatch(actor.role, visible, batch.salesperson_id)) {
        throw new PayoutError("forbidden", 403);
      }
    }

    // Separation of duties: the approver must not be the submitter (owner exempt).
    if (violatesSeparationOfDuties(action, actor.role, batch.created_by_user_id ?? null, actor.userId)) {
      throw new PayoutError("separation_of_duties", 403);
    }

    const ids = await batchEntryIds(c, batchId);
    const ts = nowISO();
    const from = batch.status as string;

    // Reconcile before approving or paying, so no stale or drifted amount is
    // ever approved. Two independent checks, because they mean different things:
    //
    //   snapshot vs batch total — an internal inconsistency in the batch itself.
    //   live ledger vs snapshot — somebody edited the underlying payment, plan
    //     or client AFTER submission, so the amount on screen when this batch
    //     was approved is no longer the amount it would pay.
    //
    // The second is the one the immutable snapshot makes detectable at all: it
    // used to be invisible, because there was nothing left to compare against.
    if (action === "approve" || action === "mark_paid") {
      const { rows: snapRows } = await c.query<{ s: string }>(
        `SELECT COALESCE(SUM(commission_amount),0)::text AS s
           FROM payout_batch_entries WHERE tenant_id = $1 AND payout_batch_id = $2`,
        [tenantId, batchId],
      );
      const snapshotTotal = Number(snapRows[0]?.s ?? 0);
      if (Math.abs(snapshotTotal - Number(batch.total_amount)) > 0.005) {
        throw new PayoutError("batch_total_mismatch", 409);
      }

      const { rows: liveRows } = await c.query<{ s: string; n: string }>(
        `SELECT COALESCE(SUM(commission_amount),0)::text AS s, count(*)::text AS n
           FROM commission_ledger WHERE tenant_id = $1 AND id = ANY($2::text[])`,
        [tenantId, ids],
      );
      const liveTotal = Number(liveRows[0]?.s ?? 0);
      const liveCount = Number(liveRows[0]?.n ?? 0);
      if (liveCount !== ids.length || Math.abs(liveTotal - snapshotTotal) > 0.005) {
        throw new PayoutError("batch_lines_changed", 409);
      }
    }

    const setEntries = async (status: string, paid = false) => {
      if (ids.length === 0) return;
      await c.query(
        `UPDATE commission_ledger
            SET status = $1, paid_date = ${paid ? "$2" : "paid_date"}, updated_at = ${paid ? "$2" : "$2"}
          WHERE tenant_id = $3 AND id = ANY($4::text[])`,
        paid ? [status, ts.slice(0, 10), tenantId, ids] : [status, ts, tenantId, ids],
      );
    };

    switch (action) {
      case "approve":
        if (from !== "submitted") throw new PayoutError("bad_state");
        await c.query(
          `UPDATE payout_batches SET status='approved', approved_at=$1, approved_by_user_id=$2, updated_at=$1 WHERE id=$3`,
          [ts, actor.userId, batchId],
        );
        await setEntries("approved");
        break;
      case "reject":
        if (from !== "submitted" && from !== "approved") throw new PayoutError("bad_state");
        await c.query(
          `UPDATE payout_batches SET status='rejected', rejected_at=$1, updated_at=$1 WHERE id=$2`,
          [ts, batchId],
        );
        // entries return to the pending pool and leave the batch
        await c.query(
          `UPDATE commission_ledger SET status='pending', payout_batch_id=NULL, updated_at=$1
            WHERE tenant_id=$2 AND id = ANY($3::text[])`,
          [ts, tenantId, ids],
        );
        break;
      case "mark_paid":
        if (from !== "approved") throw new PayoutError("bad_state");
        await c.query(
          `UPDATE payout_batches SET status='paid', paid_at=$1, paid_by_user_id=$2, updated_at=$1 WHERE id=$3`,
          [ts, actor.userId, batchId],
        );
        await setEntries("paid", true);
        break;
      case "cancel": {
        if (from === "canceled") throw new PayoutError("bad_state");
        await c.query(
          `UPDATE payout_batches SET status='canceled', canceled_at=$1, updated_at=$1 WHERE id=$2`,
          [ts, batchId],
        );
        // if the money already went out, the entries are clawed back; else they
        // return to the pending pool.
        const entryStatus = from === "paid" ? "clawed_back" : "pending";
        await c.query(
          `UPDATE commission_ledger SET status=$1, payout_batch_id=${entryStatus === "pending" ? "NULL" : "payout_batch_id"}, updated_at=$2
            WHERE tenant_id=$3 AND id = ANY($4::text[])`,
          [entryStatus, ts, tenantId, ids],
        );
        break;
      }
    }
    await logEvent(c, tenantId, batchId, from, (action === "mark_paid" ? "paid" : action === "cancel" ? "canceled" : action === "approve" ? "approved" : "rejected"), actor, note ?? "");
  });
}
