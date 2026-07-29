import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ListChecks,
  CheckCircle2,
  Circle,
  ChevronDown,
  ChevronUp,
  ArrowRight,
} from "lucide-react";
import { useApp } from "../store/AppContext";
import { Card } from "./ui";
import { classNames } from "../lib/format";

// ----------------------------------------------------------------------------
// SetupChecklist
//
// A first-run "Getting set up" card for the admin dashboard. Each step is
// derived from real data (no separate onboarding state to keep in sync) and
// links to the page where the admin completes it. The card is collapsible;
// once every step is done it shrinks to a small "Setup complete" confirmation
// instead of showing the full list.
// ----------------------------------------------------------------------------

interface Step {
  label: string;
  hint: string;
  to: string;
  cta: string;
  done: boolean;
}

export function SetupChecklist() {
  const { data } = useApp();
  const [open, setOpen] = useState(true);

  const steps = useMemo<Step[]>(() => {
    const activeSalespeople = data.salespeople.filter((s) => s.status === "active");
    const everyoneHasPlan =
      activeSalespeople.length > 0 &&
      activeSalespeople.every((s) => !!s.commissionPlanId);

    return [
      {
        label: "Create a commission plan",
        hint: "Set how setup fees, bonuses and residuals pay out.",
        to: "/plans",
        cta: "Build a plan",
        done: data.plans.length > 0,
      },
      {
        label: "Add your team (salespeople / affiliates / partners)",
        hint: "Invite the people who earn commission.",
        to: "/people",
        cta: "Add people",
        done: data.salespeople.length > 0,
      },
      {
        label: "Assign a plan to each person",
        hint: "Every active person needs a commission plan.",
        to: "/people",
        cta: "Assign plans",
        done: everyoneHasPlan,
      },
      {
        label: "Add a client",
        hint: "Track the accounts your team closes.",
        to: "/clients",
        cta: "Add a client",
        done: data.clients.length > 0,
      },
      {
        label: "Record a payment",
        hint: "Log a setup fee or subscription to generate commission.",
        to: "/payments",
        cta: "Record a payment",
        done: data.payments.length > 0,
      },
      {
        label: "Review the commission ledger",
        hint: "See which rule fired and what each line pays.",
        to: "/ledger",
        cta: "Open the ledger",
        done: data.commissions.length > 0,
      },
      {
        label: "Run your first payout",
        hint: "Submit earned commissions for approval and payment.",
        to: "/payouts",
        cta: "Start a payout",
        done: data.payouts.length > 0,
      },
    ];
  }, [data]);

  const total = steps.length;
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === total;
  const pct = Math.round((doneCount / total) * 100);

  // Collapsed confirmation once every step is complete.
  if (allDone) {
    return (
      <Card className="flex items-center gap-3">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
          <CheckCircle2 className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900 dark:text-white">
            Setup complete ✓
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            All {total} setup steps are done. Your workspace is ready to go.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card padded={false} className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 pt-4 text-left"
      >
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
          <ListChecks className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900 dark:text-white">
            Getting set up
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {doneCount} of {total} complete
          </p>
        </div>
        {open ? (
          <ChevronUp className="h-5 w-5 flex-none text-slate-400" />
        ) : (
          <ChevronDown className="h-5 w-5 flex-none text-slate-400" />
        )}
      </button>

      <div className="px-5 pb-4 pt-3">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div
            className="h-full rounded-full bg-brand-500 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {open && (
        <ul className="border-t border-slate-100 px-2 py-2 dark:border-slate-800/60">
          {steps.map((step) => (
            <li key={step.label}>
              <Link
                to={step.to}
                className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                {step.done ? (
                  <CheckCircle2 className="h-5 w-5 flex-none text-emerald-500" />
                ) : (
                  <Circle className="h-5 w-5 flex-none text-slate-300 dark:text-slate-600" />
                )}
                <span className="min-w-0 flex-1">
                  <span
                    className={classNames(
                      "block text-sm font-medium",
                      step.done
                        ? "text-slate-400 line-through dark:text-slate-500"
                        : "text-slate-800 dark:text-slate-100",
                    )}
                  >
                    {step.label}
                  </span>
                  {!step.done && (
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {step.hint}
                    </span>
                  )}
                </span>
                {!step.done && (
                  <span className="inline-flex flex-none items-center gap-1 text-xs font-medium text-brand-600 opacity-0 transition group-hover:opacity-100 dark:text-brand-300">
                    {step.cta}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
