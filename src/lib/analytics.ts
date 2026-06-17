// Selectors that turn the ledger into the numbers the dashboard, salesperson
// pages, and portal need. Kept separate from the engine (which is pure math)
// and the store (which is state) so views stay thin.

import type { AppData, CommissionEntry } from "../types";
import { displayStatus, fullLedger } from "./ledger";
import { isoToDate, todayISO } from "./format";

export interface Totals {
  revenue: number;
  earned: number; // pending + submitted + approved + paid (real, non-projected)
  paid: number;
  pending: number; // pending + submitted + approved (owed but not yet paid)
  projected: number; // future projected rows
}

export function inRange(iso: string, from: string | null, to: string | null): boolean {
  const t = isoToDate(iso).getTime();
  if (from && t < isoToDate(from).getTime()) return false;
  if (to && t > isoToDate(to).getTime()) return false;
  return true;
}

/** Revenue from real payments (setup + subscription, minus refunds) in range. */
export function revenueInRange(
  data: AppData,
  from: string | null,
  to: string | null,
): number {
  let total = 0;
  for (const p of data.payments) {
    if (!inRange(p.date, from, to)) continue;
    if (p.type === "refund") total -= p.amount;
    else if (p.type === "adjustment") total += p.amount;
    else total += p.amount;
  }
  return total;
}

/** Commission totals across a ledger slice, using display status. */
export function commissionTotals(
  entries: CommissionEntry[],
  today = todayISO(),
): Omit<Totals, "revenue"> {
  let earned = 0;
  let paid = 0;
  let pending = 0;
  let projected = 0;
  for (const e of entries) {
    const st = displayStatus(e, today);
    if (st === "projected") {
      projected += e.commissionAmount;
    } else if (st === "paid") {
      paid += e.commissionAmount;
      earned += e.commissionAmount;
    } else if (st === "pending" || st === "submitted" || st === "approved") {
      pending += e.commissionAmount;
      earned += e.commissionAmount;
    }
    // rejected / canceled / clawed_back contribute to none
  }
  return { earned, paid, pending, projected };
}

export interface SalespersonRollup {
  salespersonId: string;
  name: string;
  earned: number;
  paid: number;
  pending: number;
  projected: number;
  clients: number;
}

export function rollupBySalesperson(data: AppData): SalespersonRollup[] {
  const ledger = fullLedger(data, 24);
  const today = todayISO();
  const clientCount = new Map<string, number>();
  for (const c of data.clients) {
    if (c.salespersonId)
      clientCount.set(c.salespersonId, (clientCount.get(c.salespersonId) ?? 0) + 1);
  }
  return data.salespeople.map((sp) => {
    const mine = ledger.filter((e) => e.salespersonId === sp.id);
    const t = commissionTotals(mine, today);
    return {
      salespersonId: sp.id,
      name: sp.name,
      earned: t.earned,
      paid: t.paid,
      pending: t.pending,
      projected: t.projected,
      clients: clientCount.get(sp.id) ?? 0,
    };
  });
}

export interface MonthPoint {
  key: string; // yyyy-mm
  label: string; // "Jan '26"
  earned: number;
  projected: number;
}

/** Group a ledger slice into a monthly time series for charts. */
export function monthlySeries(
  entries: CommissionEntry[],
  monthsBack = 6,
  monthsForward = 6,
): MonthPoint[] {
  const today = todayISO();
  const now = new Date();
  const points: MonthPoint[] = [];
  const index = new Map<string, MonthPoint>();

  for (let i = -monthsBack; i <= monthsForward; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    const p: MonthPoint = { key, label, earned: 0, projected: 0 };
    points.push(p);
    index.set(key, p);
  }

  for (const e of entries) {
    const d = isoToDate(e.dueDate);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const p = index.get(key);
    if (!p) continue;
    const st = displayStatus(e, today);
    if (st === "projected") p.projected += e.commissionAmount;
    else if (st !== "rejected" && st !== "canceled" && st !== "clawed_back")
      p.earned += e.commissionAmount;
  }
  return points;
}
