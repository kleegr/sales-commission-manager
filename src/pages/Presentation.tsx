import { useMemo, useState } from "react";
import {
  Sparkles,
  CircleDollarSign,
  Gift,
  Repeat,
  Wallet,
  TrendingUp,
} from "lucide-react";
import { useApp } from "../store/AppContext";
import type { RuleType } from "../types";
import {
  PageHeader,
  Card,
  EmptyState,
  StatCard,
  SectionTitle,
  Field,
  Select,
  Badge,
} from "../components/ui";
import { MoneyBarChart, MoneyAreaChart } from "../components/charts/Charts";
import {
  projectPlanForClient,
  projectBook,
  ruleHeadline,
} from "../lib/commission-engine";
import { formatCurrency, formatNumber, formatPercent } from "../lib/format";

const RULE_ICON: Record<RuleType, typeof Gift> = {
  setup_fee: CircleDollarSign,
  signup_bonus: Gift,
  monthly_residual: Repeat,
  salary: Wallet,
};
const RULE_TONE = {
  setup_fee: "blue",
  signup_bonus: "violet",
  monthly_residual: "green",
  salary: "amber",
} as const;

export default function Presentation() {
  const { data } = useApp();
  const [planId, setPlanId] = useState<string>("");

  const plan = data.plans.find((p) => p.id === planId) ?? data.plans[0];
  const a = data.settings.assumptions;

  const client = useMemo(
    () =>
      plan
        ? projectPlanForClient(plan, {
            setupFee: plan.sampleSetupFee || a.avgSetupFee,
            monthlySubscription: plan.sampleMonthly || a.avgMonthly,
            horizon: 60,
          })
        : null,
    [plan, a],
  );
  const book = useMemo(() => (plan ? projectBook(plan, a) : null), [plan, a]);

  const yearData = useMemo(() => {
    if (!client) return [];
    return client.yearTotals.map((t, i) => ({ label: `Year ${i + 1}`, earned: t }));
  }, [client]);

  const bookCumulative = useMemo(() => {
    if (!book) return [];
    return book.months
      .filter((_, i) => (i + 1) % 3 === 0 || i === 0)
      .map((m) => ({ label: `M${m.month}`, cumulative: m.cumulative }));
  }, [book]);

  if (data.plans.length === 0) {
    return (
      <div>
        <PageHeader title="Recruiting presentation" />
        <EmptyState
          icon={<Sparkles className="h-6 w-6" />}
          title="No plans to present"
          description="Build a commission plan first, then come back to generate a recruiting view."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Recruiting presentation"
        subtitle="A clean, candidate-facing view of what a plan pays"
        actions={
          <Field className="w-64">
            <Select value={plan?.id ?? ""} onChange={(e) => setPlanId(e.target.value)}>
              {data.plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        }
      />

      {plan && client && book && (
        <>
          {/* Hero */}
          <Card className="mb-6 bg-gradient-to-br from-brand-600 to-indigo-600 text-white">
            <div className="flex items-center gap-2 text-brand-100">
              <Sparkles className="h-5 w-5" />
              <span className="text-sm font-medium uppercase tracking-wide">Commission plan</span>
            </div>
            <h2 className="mt-2 text-3xl font-bold tracking-tight">{plan.name}</h2>
            {plan.description && (
              <p className="mt-2 max-w-2xl text-brand-50/90">{plan.description}</p>
            )}
            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-sm text-brand-100">Upfront per deal</p>
                <p className="text-2xl font-bold">
                  {formatCurrency(client.setupFeeCommission + client.signupBonus)}
                </p>
              </div>
              <div>
                <p className="text-sm text-brand-100">First-year earnings</p>
                <p className="text-2xl font-bold">{formatCurrency(client.total12)}</p>
              </div>
              <div>
                <p className="text-sm text-brand-100">5-year per client</p>
                <p className="text-2xl font-bold">{formatCurrency(client.total60)}</p>
              </div>
            </div>
            <p className="mt-4 text-xs text-brand-100/80">
              Example based on a {formatCurrency(plan.sampleSetupFee)} setup fee and{" "}
              {formatCurrency(plan.sampleMonthly)}/mo subscription.
            </p>
          </Card>

          {/* How you get paid */}
          <SectionTitle>How you get paid</SectionTitle>
          <div className="mb-6 mt-3 grid gap-4 sm:grid-cols-2">
            {plan.rules.length === 0 ? (
              <p className="text-sm text-slate-400">This plan has no rules yet.</p>
            ) : (
              plan.rules.map((r) => {
                const Icon = RULE_ICON[r.type];
                return (
                  <Card key={r.id} className="flex items-start gap-3">
                    <span
                      className={
                        "flex h-10 w-10 flex-none items-center justify-center rounded-lg " +
                        (r.type === "setup_fee"
                          ? "bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300"
                          : r.type === "signup_bonus"
                            ? "bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300"
                            : r.type === "monthly_residual"
                              ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300"
                              : "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300")
                      }
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge tone={RULE_TONE[r.type]}>{r.type.replace("_", " ")}</Badge>
                      </div>
                      <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">
                        {ruleHeadline(r)}
                      </p>
                    </div>
                  </Card>
                );
              })
            )}
          </div>

          {/* Per-client earnings over 5 years */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <SectionTitle>Per-client earnings by year</SectionTitle>
              <div className="mt-3">
                <MoneyBarChart
                  data={yearData}
                  xKey="label"
                  series={[{ key: "earned", name: "Earned", color: "#3366ff" }]}
                  height={260}
                />
              </div>
            </Card>

            <Card>
              <SectionTitle right={<TrendingUp className="h-4 w-4 text-slate-400" />}>
                Build a book of business
              </SectionTitle>
              <p className="mt-1 text-sm text-slate-500">
                Closing {formatNumber(a.closingsPerMonth)} clients/month at{" "}
                {formatPercent(a.monthlyChurnPct)} monthly churn.
              </p>
              <div className="mt-3">
                <MoneyAreaChart
                  data={bookCumulative}
                  xKey="label"
                  series={[{ key: "cumulative", name: "Cumulative", color: "#16a34a" }]}
                  height={240}
                />
              </div>
            </Card>
          </div>

          {/* Book totals */}
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Year 1 (book)" value={formatCurrency(book.total12)} tone="blue" />
            <StatCard label="Year 2 (book)" value={formatCurrency(book.total24)} tone="indigo" />
            <StatCard label="5-year (book)" value={formatCurrency(book.total60)} tone="green" />
            <StatCard
              label="Lifetime / client"
              value={formatCurrency(client.grandTotal)}
              tone="violet"
            />
          </div>

          <Card className="mt-6">
            <SectionTitle>Assumptions</SectionTitle>
            <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Assumption label="Avg setup fee" value={formatCurrency(plan.sampleSetupFee)} />
              <Assumption label="Avg monthly" value={formatCurrency(plan.sampleMonthly)} />
              <Assumption label="Closings / month" value={formatNumber(a.closingsPerMonth)} />
              <Assumption label="Monthly churn" value={formatPercent(a.monthlyChurnPct)} />
            </div>
            <p className="mt-3 text-xs text-slate-400">
              Figures are deterministic projections from this plan's rules — not guarantees. Actual
              earnings depend on closings, retention, and plan terms.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

function Assumption({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="font-semibold text-slate-900 dark:text-white">{value}</p>
    </div>
  );
}
