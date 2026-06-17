import { useMemo, useState } from "react";
import type { CommissionPlan, ProjectionAssumptions } from "../../types";
import {
  projectBook,
  projectPlanForClient,
} from "../../lib/commission-engine";
import { ProjectionTable } from "./ProjectionTable";
import { MoneyAreaChart, MoneyBarChart } from "../charts/Charts";
import { Card, Button, SectionTitle } from "../ui/primitives";
import { Field, NumberField } from "../ui/form";
import { formatCurrency, classNames } from "../../lib/format";
import { downloadCSV, printHTMLToPDF } from "../../lib/export";
import { Download, FileText, User, Users } from "lucide-react";

type Mode = "client" | "book";

export function ProjectionView({
  plan,
  initialAssumptions,
  defaultMode = "client",
}: {
  plan: CommissionPlan;
  initialAssumptions: ProjectionAssumptions;
  defaultMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [a, setA] = useState<ProjectionAssumptions>({
    ...initialAssumptions,
    avgSetupFee: plan.sampleSetupFee || initialAssumptions.avgSetupFee,
    avgMonthly: plan.sampleMonthly || initialAssumptions.avgMonthly,
  });

  const clientProjection = useMemo(
    () =>
      projectPlanForClient(plan, {
        setupFee: a.avgSetupFee,
        monthlySubscription: a.avgMonthly,
        horizon: a.months,
      }),
    [plan, a.avgSetupFee, a.avgMonthly, a.months],
  );

  const book = useMemo(() => projectBook(plan, a), [plan, a]);

  // Chart data
  const clientMonthly = clientProjection.months.map((m) => ({
    label: `M${m.month}`,
    commission: m.total,
  }));
  let clientCum = 0;
  const clientCumData = clientProjection.months.map((m) => {
    clientCum += m.total;
    return { label: `M${m.month}`, cumulative: clientCum };
  });

  const bookCumData = book.months.map((m) => ({
    label: `M${m.month}`,
    cumulative: m.cumulative,
    monthly: m.total,
  }));

  function exportCSV() {
    if (mode === "client") {
      const rows: (string | number)[][] = [
        ["Month", "Rule", "Type", "Value", "Base", "Commission"],
      ];
      if (clientProjection.setupFeeLine)
        rows.push([
          "1",
          clientProjection.setupFeeLine.ruleLabel,
          clientProjection.setupFeeLine.valueType,
          clientProjection.setupFeeLine.value,
          clientProjection.setupFeeLine.baseAmount,
          clientProjection.setupFeeLine.amount,
        ]);
      if (clientProjection.signupBonusLine)
        rows.push([
          "1",
          "Signup bonus",
          "fixed",
          clientProjection.signupBonusLine.value,
          0,
          clientProjection.signupBonusLine.amount,
        ]);
      for (const m of clientProjection.months) {
        for (const l of m.lines) {
          rows.push([m.month, l.ruleLabel, l.valueType, l.value, l.baseAmount, l.amount]);
        }
      }
      rows.push([]);
      rows.push(["First 12 months", "", "", "", "", clientProjection.total12]);
      rows.push(["First 24 months", "", "", "", "", clientProjection.total24]);
      rows.push(["First 60 months", "", "", "", "", clientProjection.total60]);
      downloadCSV(`${plan.name}-per-client-projection`, rows);
    } else {
      const rows: (string | number)[][] = [
        [
          "Month",
          "New clients",
          "Active clients",
          "Setup",
          "Signup bonus",
          "Residual",
          "Salary",
          "Monthly total",
          "Cumulative",
        ],
      ];
      for (const m of book.months) {
        rows.push([
          m.month,
          Math.round(m.newClients),
          Math.round(m.activeClients * 100) / 100,
          m.setupCommission,
          m.signupBonus,
          m.residualCommission,
          m.salary,
          m.total,
          m.cumulative,
        ]);
      }
      downloadCSV(`${plan.name}-book-projection`, rows);
    }
  }

  function exportPDF() {
    const fmt = (n: number) => formatCurrency(n);
    if (mode === "client") {
      const rows = clientProjection.months
        .map(
          (m) =>
            `<tr><td>${m.month}</td><td>${m.lines
              .map((l) => l.ruleLabel)
              .join("<br/>") || "—"}</td><td style="text-align:right">${fmt(
              m.total,
            )}</td></tr>`,
        )
        .join("");
      printHTMLToPDF(
        `${plan.name} — Per-client projection`,
        `<h1>${plan.name}</h1>
         <p class="muted">Per-client projection · ${fmt(a.avgSetupFee)} setup · ${fmt(
           a.avgMonthly,
         )}/mo · ${a.months} months</p>
         <div class="cards">
           <div class="card"><div class="l">Setup commission</div><div class="v">${fmt(
             clientProjection.setupFeeCommission,
           )}</div></div>
           <div class="card"><div class="l">Signup bonus</div><div class="v">${fmt(
             clientProjection.signupBonus,
           )}</div></div>
           <div class="card"><div class="l">First 12 mo</div><div class="v">${fmt(
             clientProjection.total12,
           )}</div></div>
           <div class="card"><div class="l">First 5 yr</div><div class="v">${fmt(
             clientProjection.total60,
           )}</div></div>
         </div>
         <h2>Month by month</h2>
         <table><thead><tr><th>Month</th><th>Rules applied</th><th style="text-align:right">Total</th></tr></thead><tbody>${rows}</tbody></table>`,
      );
    } else {
      const rows = book.months
        .map(
          (m) =>
            `<tr><td>${m.month}</td><td style="text-align:right">${Math.round(
              m.activeClients,
            )}</td><td style="text-align:right">${fmt(
              m.total,
            )}</td><td style="text-align:right">${fmt(m.cumulative)}</td></tr>`,
        )
        .join("");
      printHTMLToPDF(
        `${plan.name} — Book projection`,
        `<h1>${plan.name}</h1>
         <p class="muted">Book of business · ${a.closingsPerMonth} closings/mo · ${fmt(
           a.avgMonthly,
         )}/mo · ${a.monthlyChurnPct}% churn · ${a.months} months</p>
         <div class="cards">
           <div class="card"><div class="l">First 12 mo</div><div class="v">${fmt(
             book.total12,
           )}</div></div>
           <div class="card"><div class="l">First 24 mo</div><div class="v">${fmt(
             book.total24,
           )}</div></div>
           <div class="card"><div class="l">First 5 yr</div><div class="v">${fmt(
             book.total60,
           )}</div></div>
         </div>
         <h2>Month by month</h2>
         <table><thead><tr><th>Month</th><th style="text-align:right">Active clients</th><th style="text-align:right">Monthly</th><th style="text-align:right">Cumulative</th></tr></thead><tbody>${rows}</tbody></table>`,
      );
    }
  }

  return (
    <div className="space-y-5">
      {/* Mode toggle + exports */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-800 dark:bg-slate-900">
          <ModeButton active={mode === "client"} onClick={() => setMode("client")} icon={<User className="h-4 w-4" />}>
            Per client
          </ModeButton>
          <ModeButton active={mode === "book"} onClick={() => setMode("book")} icon={<Users className="h-4 w-4" />}>
            Book of business
          </ModeButton>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={exportCSV}>
            <Download className="h-4 w-4" /> CSV
          </Button>
          <Button variant="secondary" size="sm" onClick={exportPDF}>
            <FileText className="h-4 w-4" /> PDF
          </Button>
        </div>
      </div>

      {/* Assumptions */}
      <Card>
        <SectionTitle>Assumptions</SectionTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Field label="Avg setup fee">
            <NumberField value={a.avgSetupFee} onChange={(v) => setA({ ...a, avgSetupFee: v })} prefix="$" min={0} />
          </Field>
          <Field label="Avg monthly">
            <NumberField value={a.avgMonthly} onChange={(v) => setA({ ...a, avgMonthly: v })} prefix="$" min={0} />
          </Field>
          <Field label="Closings / month">
            <NumberField
              value={a.closingsPerMonth}
              onChange={(v) => setA({ ...a, closingsPerMonth: v })}
              min={0}
              disabled={mode === "client"}
            />
          </Field>
          <Field label="Monthly churn">
            <NumberField
              value={a.monthlyChurnPct}
              onChange={(v) => setA({ ...a, monthlyChurnPct: v })}
              suffix="%"
              min={0}
              max={100}
              disabled={mode === "client"}
            />
          </Field>
          <Field label="Horizon (months)">
            <NumberField value={a.months} onChange={(v) => setA({ ...a, months: v })} min={1} max={60} emptyValue={60} />
          </Field>
        </div>
        {mode === "client" && (
          <p className="mt-3 text-xs text-slate-500">
            Per-client mode projects a single client. Switch to Book of business to model closings per month and churn.
          </p>
        )}
      </Card>

      {/* Charts */}
      {mode === "client" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <SectionTitle>Cumulative earnings (1 client)</SectionTitle>
            <MoneyAreaChart
              data={clientCumData}
              xKey="label"
              series={[{ key: "cumulative", name: "Cumulative", color: "#3366ff" }]}
            />
          </Card>
          <Card>
            <SectionTitle>Commission per month</SectionTitle>
            <MoneyBarChart
              data={clientMonthly}
              xKey="label"
              series={[{ key: "commission", name: "Commission", color: "#22c55e" }]}
            />
          </Card>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <SectionTitle>Cumulative earnings (growing book)</SectionTitle>
            <MoneyAreaChart
              data={bookCumData}
              xKey="label"
              series={[{ key: "cumulative", name: "Cumulative", color: "#3366ff" }]}
            />
          </Card>
          <Card>
            <SectionTitle>Monthly commission</SectionTitle>
            <MoneyBarChart
              data={bookCumData}
              xKey="label"
              series={[{ key: "monthly", name: "Monthly", color: "#22c55e" }]}
            />
          </Card>
        </div>
      )}

      {/* Detail table */}
      {mode === "client" ? (
        <ProjectionTable projection={clientProjection} />
      ) : (
        <BookTable book={book} />
      )}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={classNames(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition",
        active
          ? "bg-brand-600 text-white shadow-sm"
          : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function BookTable({ book }: { book: ReturnType<typeof projectBook> }) {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? book.months : book.months.slice(0, 24);
  return (
    <Card padded={false}>
      <div className="flex items-center justify-between px-4 py-3">
        <SectionTitle>Book of business — month by month</SectionTitle>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/40">
            <tr>
              <th className="px-4 py-2 font-semibold">Mo</th>
              <th className="px-4 py-2 text-right font-semibold">Active</th>
              <th className="px-4 py-2 text-right font-semibold">Setup</th>
              <th className="px-4 py-2 text-right font-semibold">Bonus</th>
              <th className="px-4 py-2 text-right font-semibold">Residual</th>
              <th className="px-4 py-2 text-right font-semibold">Salary</th>
              <th className="px-4 py-2 text-right font-semibold">Total</th>
              <th className="px-4 py-2 text-right font-semibold">Cumulative</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
            {rows.map((m) => (
              <tr key={m.month}>
                <td className="px-4 py-2 font-medium text-slate-700 dark:text-slate-200">{m.month}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500">{Math.round(m.activeClients)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500">{formatCurrency(m.setupCommission)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500">{formatCurrency(m.signupBonus)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500">{formatCurrency(m.residualCommission)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500">{formatCurrency(m.salary)}</td>
                <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-100">{formatCurrency(m.total)}</td>
                <td className="px-4 py-2 text-right font-semibold tabular-nums text-brand-600 dark:text-brand-300">{formatCurrency(m.cumulative)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {book.months.length > 24 && (
        <div className="border-t border-slate-200 px-4 py-3 text-center dark:border-slate-800">
          <Button variant="ghost" size="sm" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "Show first 24 months" : `Show all ${book.months.length} months`}
          </Button>
        </div>
      )}
    </Card>
  );
}
