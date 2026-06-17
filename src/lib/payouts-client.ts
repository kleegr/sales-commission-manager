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

export interface ServerPayout {
  id: string;
  salespersonId: string;
  salespersonName: string;
  status: "submitted" | "approved" | "paid" | "rejected" | "canceled";
  totalAmount: number;
  entryCount: number;
  notes: string;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  events: PayoutEvent[];
}

export async function fetchPayouts(): Promise<ServerPayout[]> {
  const res = await fetch("/api/payouts", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`payouts GET ${res.status}`);
  const body = await res.json();
  return (body.payouts ?? []) as ServerPayout[];
}

async function post(body: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/payouts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: json.error ?? `error_${res.status}` };
  return { ok: true };
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
