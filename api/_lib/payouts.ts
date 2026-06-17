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

export interface PayoutActor {
  userId: string;
  role: string;
}

export interface PayoutListItem {
  id: string;
  salespersonId: string;
  salespersonName: string;
  status: string;
  totalAmount: number;
  entryCount: number;
  notes: string;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
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

  return filtered.map((r) => ({
    id: r.id,
    salespersonId: r.salesperson_id,
    salespersonName: r.sp_name ?? "—",
    status: r.status,
    totalAmount: Number(r.total_amount),
    entryCount: Number(r.entry_count),
    notes: r.notes ?? "",
    createdAt: r.created_at || "",
    submittedAt: r.submitted_at ?? null,
    approvedAt: r.approved_at ?? null,
    paidAt: r.paid_at ?? null,
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

/** SUBMIT: bundle pending ledger entries into a new payout batch. */
export async function submitPayout(
  tenantId: string,
  actor: PayoutActor,
  actorSalespersonId: string | null,
  salespersonId: string,
  entryIds: string[],
  notes: string,
): Promise<{ id: string }> {
  if (!salespersonId || entryIds.length === 0) throw new PayoutError("nothing_to_submit");

  // permission: who may submit for this salesperson?
  const visible = await visibleSalespeople(tenantId, actor, actorSalespersonId);
  if (visible !== "all" && !visible.has(salespersonId)) throw new PayoutError("forbidden", 403);

  return withTransaction(async (c) => {
    // validate the entries: same tenant + salesperson, still pending, not already in a batch
    const { rows: entries } = await c.query<any>(
      `SELECT id, commission_amount, status FROM commission_ledger
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
         (id, tenant_id, salesperson_id, status, total_amount, submitted_at, created_by_user_id, notes, created_at, updated_at)
       VALUES ($1,$2,$3,'submitted',$4,$5,$6,$7,$8,$8)`,
      [id, tenantId, salespersonId, total, ts, actor.userId, notes ?? "", ts],
    );
    for (const e of entries) {
      await c.query(
        `INSERT INTO payout_batch_entries (payout_batch_id, commission_entry_id, tenant_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [id, e.id, tenantId],
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

/** Run an approve/reject/pay/cancel transition with role + state checks. */
export async function transitionPayout(
  tenantId: string,
  actor: PayoutActor,
  action: Exclude<PayoutAction, "submit">,
  batchId: string,
  note: string,
): Promise<void> {
  const canApprove = ["owner", "admin", "sales_manager"].includes(actor.role);
  const canPayOrCancel = ["owner", "admin"].includes(actor.role);

  if ((action === "approve" || action === "reject") && !canApprove) throw new PayoutError("forbidden", 403);
  if ((action === "mark_paid" || action === "cancel") && !canPayOrCancel) throw new PayoutError("forbidden", 403);

  await withTransaction(async (c) => {
    const batch = await loadBatch(c, tenantId, batchId);
    if (!batch) throw new PayoutError("not_found", 404);
    const ids = await batchEntryIds(c, batchId);
    const ts = nowISO();
    const from = batch.status as string;

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
