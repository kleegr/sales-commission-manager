// ============================================================================
// COMMISSION BREAKDOWN MODAL
//
// Click any commission line and see exactly how it was produced: what the client
// paid, which rule fired, the arithmetic, and what has to happen before it can
// be paid. The numbers come from the stored ledger row (see
// lib/commission-breakdown.ts for why it derives rather than recomputes), so
// this always explains the money that was actually booked.
// ============================================================================

import { Calculator, AlertTriangle } from "lucide-react";
import { Modal } from "./ui/Modal";
import { Button, CommissionBadge } from "./ui";
import { buildBreakdown } from "../lib/commission-breakdown";
import { formatCurrency } from "../lib/format";
import type { Client, CommissionEntry, CommissionPlan } from "../types";

export function CommissionBreakdownModal({
  entry,
  plan,
  client,
  onClose,
}: {
  entry: CommissionEntry | null;
  plan?: CommissionPlan;
  client?: Client;
  onClose: () => void;
}) {
  if (!entry) return null;
  const b = buildBreakdown(entry, plan, client);

  return (
    <Modal
      open
      onClose={onClose}
      title="How this was calculated"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">
              <Calculator className="h-4 w-4" />
            </span>
            <span className="text-sm font-medium text-slate-900 dark:text-white">{b.title}</span>
          </div>
          <CommissionBadge status={entry.status} />
        </div>

        {/* The one-line version, for anyone who just wants the formula. */}
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-center dark:bg-slate-800/60">
          <p className="font-mono text-sm text-slate-600 dark:text-slate-300">
            {b.formula} <span className="text-slate-400">=</span>{" "}
            <span className="font-semibold text-slate-900 dark:text-white">
              {formatCurrency(b.amount)}
            </span>
          </p>
        </div>

        {/* Step by step, in the order you'd do it on paper. */}
        <ol className="divide-y divide-slate-100 dark:divide-slate-800">
          {b.steps.map((s, i) => (
            <li
              key={i}
              className={
                "flex items-baseline justify-between gap-4 py-2.5 " +
                (s.total ? "font-semibold text-slate-900 dark:text-white" : "")
              }
            >
              <span className="min-w-0">
                <span className="block text-sm">{s.label}</span>
                {s.detail && (
                  <span className="block text-xs font-normal text-slate-500">{s.detail}</span>
                )}
              </span>
              {s.value && (
                <span className="flex-none tabular-nums text-sm">{s.value}</span>
              )}
            </li>
          ))}
        </ol>

        {!b.verified && (
          <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
            The stored rate and payment amount don't multiply out to this total — the line was
            probably priced under an older version of the plan. The amount shown is the one that
            was booked.
          </p>
        )}

        {b.timing.length > 0 && (
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
              When you get paid
            </p>
            <ul className="space-y-1">
              {b.timing.map((t, i) => (
                <li key={i} className="text-xs text-slate-500">
                  {t}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
