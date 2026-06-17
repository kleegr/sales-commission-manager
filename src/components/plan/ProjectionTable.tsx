import { useState } from "react";
import type { PlanProjection } from "../../lib/commission-engine";
import { formatCurrency, classNames } from "../../lib/format";
import { Badge } from "../ui/primitives";
import { ChevronDown, ChevronRight } from "lucide-react";

const YEAR_RANGES = [
  { year: 1, start: 1, end: 12 },
  { year: 2, start: 13, end: 24 },
  { year: 3, start: 25, end: 36 },
  { year: 4, start: 37, end: 48 },
  { year: 5, start: 49, end: 60 },
];

export function ProjectionTable({ projection }: { projection: PlanProjection }) {
  const [open, setOpen] = useState<Record<number, boolean>>({ 1: true });

  const horizon = projection.horizon;
  const visibleYears = YEAR_RANGES.filter((y) => y.start <= horizon);

  return (
    <div className="space-y-3">
      {/* Upfront commissions called out separately */}
      {(projection.setupFeeLine || projection.signupBonusLine) && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-800/40">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Upfront (Month 1)
          </p>
          <div className="flex flex-wrap gap-4">
            {projection.setupFeeLine && (
              <div>
                <p className="text-xs text-slate-500">Setup fee commission</p>
                <p className="text-lg font-semibold text-slate-900 dark:text-white">
                  {formatCurrency(projection.setupFeeCommission)}
                </p>
              </div>
            )}
            {projection.signupBonusLine && (
              <div>
                <p className="text-xs text-slate-500">Signup bonus</p>
                <p className="text-lg font-semibold text-slate-900 dark:text-white">
                  {formatCurrency(projection.signupBonus)}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {visibleYears.map((y) => {
        const isOpen = open[y.year] ?? false;
        const monthsInYear = projection.months.filter(
          (m) => m.month >= y.start && m.month <= y.end,
        );
        const yearTotal = projection.yearTotals[y.year - 1] ?? 0;
        if (monthsInYear.length === 0) return null;

        return (
          <div
            key={y.year}
            className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800"
          >
            <button
              onClick={() => setOpen((o) => ({ ...o, [y.year]: !isOpen }))}
              className="flex w-full items-center justify-between bg-white px-4 py-3 text-left transition hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800/60"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 text-slate-400" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-slate-400" />
                )}
                Year {y.year}
                <span className="font-normal text-slate-400">
                  (Months {y.start}–{Math.min(y.end, horizon)})
                </span>
              </span>
              <span className="text-sm font-semibold text-brand-600 dark:text-brand-300">
                {formatCurrency(yearTotal)}
              </span>
            </button>

            {isOpen && (
              <div className="border-t border-slate-200 dark:border-slate-800">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left dark:bg-slate-800/40">
                    <tr className="text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-2 font-semibold">Month</th>
                      <th className="px-4 py-2 font-semibold">Rule applied</th>
                      <th className="px-4 py-2 text-right font-semibold">Rate</th>
                      <th className="px-4 py-2 text-right font-semibold">Base</th>
                      <th className="px-4 py-2 text-right font-semibold">Commission</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthsInYear.map((m) => {
                      const lines = m.lines.length === 0
                        ? [null]
                        : m.lines;
                      return lines.map((line, i) => (
                        <tr
                          key={`${m.month}-${i}`}
                          className={classNames(
                            "border-t border-slate-100 dark:border-slate-800/60",
                            i === 0 && "bg-white dark:bg-slate-900",
                          )}
                        >
                          {i === 0 && (
                            <td
                              rowSpan={lines.length}
                              className="px-4 py-2 align-top font-medium text-slate-700 dark:text-slate-200"
                            >
                              {m.month}
                            </td>
                          )}
                          {line ? (
                            <>
                              <td className="px-4 py-2 text-slate-600 dark:text-slate-300">
                                {line.ruleLabel}
                              </td>
                              <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                                {line.valueType === "percentage"
                                  ? `${line.value}%`
                                  : "flat"}
                              </td>
                              <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                                {line.baseAmount > 0
                                  ? formatCurrency(line.baseAmount)
                                  : "—"}
                              </td>
                              <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-100">
                                {formatCurrency(line.amount)}
                              </td>
                            </>
                          ) : (
                            <td
                              colSpan={4}
                              className="px-4 py-2 text-slate-400"
                            >
                              No commission this month
                            </td>
                          )}
                        </tr>
                      ));
                    })}
                  </tbody>
                  <tbody>
                    {monthsInYear.map(
                      (m) =>
                        m.lines.length > 1 && (
                          <tr key={`tot-${m.month}`} className="hidden" />
                        ),
                    )}
                  </tbody>
                </table>
                {/* Per-month totals strip for months with multiple rules */}
                <MonthTotals months={monthsInYear} />
              </div>
            )}
          </div>
        );
      })}

      {/* Grand totals */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <TotalCard label="First 12 months" value={projection.total12} />
        <TotalCard label="First 24 months" value={projection.total24} />
        <TotalCard label="First 5 years" value={projection.total60} />
        <TotalCard label="Lifetime (horizon)" value={projection.grandTotal} highlight />
      </div>
    </div>
  );
}

function MonthTotals({
  months,
}: {
  months: PlanProjection["months"];
}) {
  const multi = months.filter((m) => m.lines.length > 1);
  if (multi.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2 dark:border-slate-800/60 dark:bg-slate-800/30">
      <span className="text-xs font-medium text-slate-400">Combined months:</span>
      {multi.map((m) => (
        <Badge key={m.month} tone="green">
          M{m.month} total {formatCurrency(m.total)}
        </Badge>
      ))}
    </div>
  );
}

function TotalCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={classNames(
        "rounded-xl border p-3",
        highlight
          ? "border-brand-200 bg-brand-50 dark:border-brand-500/30 dark:bg-brand-500/10"
          : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
      )}
    >
      <p className="text-xs text-slate-500">{label}</p>
      <p
        className={classNames(
          "mt-1 text-lg font-semibold tabular-nums",
          highlight
            ? "text-brand-700 dark:text-brand-300"
            : "text-slate-900 dark:text-white",
        )}
      >
        {formatCurrency(value)}
      </p>
    </div>
  );
}
