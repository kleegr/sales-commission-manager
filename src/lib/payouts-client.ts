// Client for the server-side payout workflow (/api/payouts).
// Used by the Payouts page when running on the Neon backend; in local-dev
// fallback the page uses the in-memory reducer instead.

export interface PayoutEvent {
  toStatus: string;
  fromStatus: string | null;
  actorRole: string | null;
  note: string;
  at: string;
}

/**
 * One line of a batch, from the IMMUTABLE snapshot taken at submit time. These
 * amounts are what was approved and paid — they never change, even if the
 * underlying ledger row is later re-priced. `linked` is false when the ledger
 * row itself no longer exists.
 */
export interface PayoutLine {
  commissionEntryId: string;
  commissionAmount: number;
  clientId: string | null;
  ruleLabel: string;
  paymentDate: string;
  linked: boolean;
}

export interface ServerPayout {
  id: string;
  salespersonId: string;
  salespersonName: string;
  /** How the batch was raised: assembled by an admin, or requested by the rep. */
  kind: "admin_batch" | "withdrawal_request";
  status: "submitted" | "approved" | "paid" | "rejected" | "canceled";
  totalAmount: number;
  entryCount: number;
  notes: string;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  lines: PayoutLine[];
  events: PayoutEvent[];
}

/**
 * A rep's reconciled balance. Every dollar sits in exactly one bucket, so the
 * card can show the composition rather than a single unexplained number.
 */
export interface RepBalance {
  commission: number;
  salary: number;
  deductions: number;
  available: number;
  net: number;
  awaitingApproval: number;
  notYetReleased: number;
  paidToDate: number;
  salaryPaidToDate: number;
  availableEntryIds: string[];
  /** True while a withdrawal request is already awaiting review. */
  hasOpenRequest: boolean;
}

export async function fetchPayouts(): Promise<ServerPayout[]> {
  const res = await fetch("/api/payouts", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`payouts GET ${res.status}`);
  const body = await res.json();
  return (body.payouts ?? []) as ServerPayout[];
}

export async function fetchBalance(salespersonId?: string): Promise<RepBalance> {
  const q = salespersonId ? `&salespersonId=${encodeURIComponent(salespersonId)}` : "";
  const res = await fetch(`/api/payouts?resource=balance${q}`, {
    headers: { accept: "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `balance GET ${res.status}`);
  return body.balance as RepBalance;
}

async function post(body: unknown): Promise<{ ok: boolean; error?: string; data?: any }> {
  const res = await fetch("/api/payouts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: json.error ?? `error_${res.status}` };
  return { ok: true, data: json };
}

export function submitPayout(salespersonId: string, commissionEntryIds: string[], notes: string) {
  return post({ action: "submit", salespersonId, commissionEntryIds, notes });
}

export function payoutTransition(
  action: "approve" | "reject" | "mark_paid" | "cancel",
  payoutId: string,
  note = "",
) {
  return post({ action, payoutId, note });
}

/**
 * Ask to be paid from your own available balance.
 *
 * `amount` is a REQUEST, not an instruction: the server reconciles the balance,
 * decides which whole ledger lines back it, and answers with the amount it could
 * actually cover (`partial` when that is less than asked, because a ledger line
 * cannot be split). Pass null for "all of it".
 */
export function requestWithdrawal(amount: number | null, notes = "") {
  return post({ action: "request_withdrawal", amount, notes });
}
