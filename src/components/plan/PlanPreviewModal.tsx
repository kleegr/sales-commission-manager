import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { X, Pencil, Clock } from "lucide-react";
import type { CommissionPlan, ProjectionAssumptions } from "../../types";
import { ProjectionView } from "./ProjectionView";
import { TimingExplainer } from "./TimingExplainer";
import { Button, Card, SectionTitle } from "../ui/primitives";
import { planProjectedTotals, planTimingFlags } from "../../lib/plan-analytics";
import { formatCurrency } from "../../lib/format";

/**
 * A true full-screen preview of a plan — large, spacious, and easy to read.
 * Shows headline payout numbers, the plain-English timing rules, and the full
 * per-client / book-of-business projection (charts + month-by-month). Designed
 * so the preview never feels like a cramped side panel.
 */
export function PlanPreviewModal({
  open,
  plan,
  assumptions,
  onClose,
}: {
  open: boolean;
  plan: CommissionPlan | null;
  assumptions: ProjectionAssumptions;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open || !plan) return null;

  const totals = planProjectedTotals(plan, assumptions);
  const flags = planTimingFlags(plan);

  const headline = [
    { label: "Upfront / deal", value: totals.upfront },
    { label: "First-year (1 client)", value: totals.total12 },
    { label: "2-year (1 client)", value: totals.total24 },
    { label: "5-year (1 client)", value: totals.total60 },
  ];

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-slate-50 dark:bg-slate-950">
      {/* Top bar */}
      <header className="flex flex-none items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900 sm:px-6">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Plan preview
          </p>
          <h2 className="truncate text-lg font-semibold text-slate-900 dark:text-white">
            {plan.name || "Untitled plan"}
          </h2>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Link to={`/plans/${plan.id}/edit`} onClick={onClose}>
            <Button variant="secondary" size="sm">
              <Pencil className="h-4 w-4" /> Edit
            </Button>
          </Link>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close preview">
            <X className="h-5 w-5" />
          </Button>
        </div>
      </header>

      {/* Scrollable body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
          {/* Headline numbers */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {headline.map((h) => (
              <Card key={h.label}>
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {h.label}
                </p>
                <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
                  {formatCurrency(h.value)}
                </p>
              </Card>
            ))}
          </div>
          <p className="-mt-2 text-xs text-slate-500">
            Sample based on {formatCurrency(totals.setupFee)} setup fee and{" "}
            {formatCurrency(totals.monthly)}/mo subscription. Deterministic projection from this
            plan's rules — not a guarantee.
          </p>

          {/* Timing in plain English */}
          {flags.hasTiming && (
            <Card>
              <SectionTitle right={<Clock className="h-4 w-4 text-slate-400" />}>
                When commissions are paid
              </SectionTitle>
              <div className="mt-2">
                <TimingExplainer plan={plan} />
              </div>
            </Card>
          )}

          {/* The full projection (no onExpand — we're already full screen) */}
          <ProjectionView plan={plan} initialAssumptions={assumptions} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
