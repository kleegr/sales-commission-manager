// ============================================================================
// EARNINGS PLANNER  (salesperson / affiliate portal)
//
// "If I close N more deals this month, what do I actually make — this month, and
// over the next year?"
//
// The projection page already answers that for an ADMIN designing a plan. This
// answers it for the REP living inside one: drag a slider, watch the number
// move, see which residual band the extra deals push you into.
//
// It runs the SAME engine functions as the ledger and the recruiting deck
// (projectPlanForClient and projectBook from commission-engine.ts). That is the
// point: the figure a rep plans against and the figure they are eventually paid
// come from one source of truth, so the planner can never quietly promise
// something the ledger will not deliver. Nothing here is stored — it is a
// what-if over the rep's own plan.
// ============================================================================

import { useMemo, useState } from "react";
import { SlidersHorizontal, TrendingUp, Info } from "lucide-react";
import { Card, SectionTitle, Badge } from "../ui";
import { projectBook, projectPlanForClient } from "../../lib/commission-engine";
import { residualLabel } from "../../lib/commission-engine";
import { formatCurrency, formatNumber } from "../../lib/format";
import type { CommissionPlan, MonthlyResidualRule, ProjectionAssumptions } from "../../types";

/** A labelled range input with its current value shown inline. */
function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format: (v: number) => string;
  hint?: string;
}) {
  const id = `plan-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm text-slate-600 dark:text-slate-300">
          {label}
        </label>
        <span className="text-sm font-semibold tabular-nums text-slate-900 dark:text-white">
          {format(value)}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-brand-600 dark:bg-slate-700"
      />
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

export function EarningsPlanner({
  plan,
  defaults,
}: {
  /** The rep's own commission plan. Without one there is nothing to model. */
  plan: CommissionPlan | undefined;
  /** The workspace's projection defaults, used as the starting position. */
  defaults: ProjectionAssumptions;
}) {
  const [dealsPerMonth, setDealsPerMonth] = useState(() =>
    Math.max(1, Math.round(defaults.closingsPerMonth || 3)),
  );
  const [setupFee, setSetupFee] = useState(() => Math.round(plan?.sampleSetupFee ?? defaults.avgSetupFee ?? 2500));
  const [monthly, setMonthly] = useState(() => Math.round(plan?.sampleMonthly ?? defaults.avgMonthly ?? 250));
  const [churn, setChurn] = useState(() => Math.round(defaults.monthlyChurnPct ?? 3));

  // One deal, month by month — the "what is a single client worth to me" number.
  const perDeal = useMemo(
    () => (plan ? projectPlanForClient(plan, { setupFee, monthlySubscription: monthly, horizon: 24 }) : null),
    [plan, setupFee, monthly],
  );

  // The whole book: N new clients every month, each cohort ageing and churning.
  const book = useMemo(() => {
    if (!plan) return null;
    return projectBook(plan, {
      avgSetupFee: setupFee,
      avgMonthly: monthly,
      closingsPerMonth: dealsPerMonth,
      monthlyChurnPct: churn,
      months: 24,
    });
  }, [plan, setupFee, monthly, dealsPerMonth, churn]);

  // The residual bands ARE the tiers a rep progresses through as a client ages.
  const bands = useMemo(
    () =>
      (plan?.rules.filter((r): r is MonthlyResidualRule => r.type === "monthly_residual") ?? []).sort(
        (a, b) => a.startMonth - b.startMonth,
      ),
    [plan],
  );

  if (!plan) {
    return (
      <Card className="space-y-2">
        <SectionTitle right={<SlidersHorizontal className="h-4 w-4 text-slate-400" />}>
          Earnings planner
        </SectionTitle>
        <p className="text-sm text-slate-500">
          You don't have a commission plan assigned yet, so there is nothing to model. Ask your
          manager to assign one.
        </p>
      </Card>
    );
  }

  const upfrontPerDeal = (perDeal?.setupFeeCommission ?? 0) + (perDeal?.signupBonus ?? 0);
  const firstYearPerDeal = perDeal?.total12 ?? 0;
  const month1 = book?.months[0]?.total ?? 0;
  const month12 = book?.months[11]?.total ?? 0;
  const year1 = book?.total12 ?? 0;

  return (
    <Card className="space-y-5">
      <SectionTitle right={<SlidersHorizontal className="h-4 w-4 text-slate-400" />}>
        Earnings planner
      </SectionTitle>
      <p className="-mt-2 text-sm text-slate-500">
        Move the sliders to see what closing more deals is worth. This uses{" "}
        <span className="font-medium">your</span> plan and the same calculation as your ledger — it
        is a forecast, not a guarantee.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Slider
          label="Deals closed per month"
          value={dealsPerMonth}
          onChange={setDealsPerMonth}
          min={1}
          max={30}
          format={(v) => formatNumber(v)}
        />
        <Slider
          label="Average setup fee"
          value={setupFee}
          onChange={setSetupFee}
          min={0}
          max={20_000}
          step={100}
          format={(v) => formatCurrency(v)}
        />
        <Slider
          label="Average monthly subscription"
          value={monthly}
          onChange={setMonthly}
          min={0}
          max={5_000}
          step={25}
          format={(v) => formatCurrency(v)}
        />
        <Slider
          label="Monthly churn"
          value={churn}
          onChange={setChurn}
          min={0}
          max={25}
          format={(v) => `${v}%`}
          hint="How many clients cancel each month."
        />
      </div>

      {/* The two numbers a rep actually plans against. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Each new client</p>
          <p className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">
            {formatCurrency(upfrontPerDeal)}
          </p>
          <p className="text-xs text-slate-500">
            up front, then {formatCurrency(firstYearPerDeal - upfrontPerDeal)} over their first year
          </p>
        </div>
        <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-3 dark:border-brand-500/30 dark:bg-brand-500/10">
          <p className="text-xs font-medium uppercase tracking-wide text-brand-700 dark:text-brand-300">
            At {formatNumber(dealsPerMonth)} deals a month
          </p>
          <p className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">
            {formatCurrency(year1)}
          </p>
          <p className="text-xs text-brand-700/80 dark:text-brand-300/80">in your first 12 months</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
        <div>
          <p className="text-xs text-slate-400">Month 1</p>
          <p className="text-sm font-semibold tabular-nums text-slate-900 dark:text-white">
            {formatCurrency(month1)}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-400">Month 12</p>
          <p className="flex items-center gap-1 text-sm font-semibold tabular-nums text-slate-900 dark:text-white">
            {formatCurrency(month12)}
            {month12 > month1 && <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />}
          </p>
        </div>
      </div>

      {/* Tier progression: a client moves through these bands as they age. */}
      {bands.length > 0 && (
        <div className="border-t border-slate-100 pt-4 dark:border-slate-800">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">
            How your rate changes as a client stays
          </p>
          <ul className="space-y-1.5">
            {bands.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-slate-600 dark:text-slate-300">
                  {residualLabel(b)}
                </span>
                <Badge tone={b.continueForever ? "green" : "slate"}>
                  {b.continueForever ? "Forever" : "Then steps"}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="flex items-start gap-2 text-xs text-slate-400">
        <Info className="mt-0.5 h-3.5 w-3.5 flex-none" />
        Assumes every client keeps paying until they churn. Your real ledger only pays on money the
        client has actually paid.
      </p>
    </Card>
  );
}
