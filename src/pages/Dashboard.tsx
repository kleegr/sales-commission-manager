import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Banknote,
  CircleDollarSign,
  Clock,
  HandCoins,
  TrendingUp,
  Users,
  Building2,
  ArrowRight,
} from "lucide-react";
import { useApp } from "../store/AppContext";
import { PageHeader, StatCard, Card, SectionTitle, Button, EmptyState } from "../components/ui";
import { DateRangeFilter, type DateRange } from "../components/DateRangeFilter";
import {
  CategoryBarChart,
  MoneyBarChart,
} from "../components/charts/Charts";
import {
  commissionTotals,
  monthlySeries,
  revenueInRange,
  rollupBySalesperson,
} from "../lib/analytics";
import { fullLedger } from "../lib/ledger";
import { inRange } from "../lib/analytics";
import { formatCurrency, formatNumber } from "../lib/format";

export default function Dashboard() {
  const { data } = useApp();
  const [range, setRange] = useState<DateRange>({ from: null, to: null });

  const ledger = useMemo(() => fullLedger(data, 24), [data]);

  const ledgerInRange = useMemo(
    () => ledger.filter((e) => inRange(e.dueDate, range.from, range.to)),
    [ledger, range],
  );

  const totals = useMemo(() => commissionTotals(ledgerInRange), [ledgerInRange]);
  const revenue = useMemo(() => revenueInRange(data, range.from, range.to), [data, range]);

  const activeSalespeople = data.salespeople.filter(
    (s) => s.status === "active" && s.approvalStatus !== "pending",
  ).length;
  const activeClients = data.clients.filter((c) => c.status === "active").length;

  const rollup = useMemo(() => rollupBySalesperson(data), [data]);
  const perfData = rollup
    .filter((r) => r.earned > 0 || r.projected > 0)
    .sort((x, y) => y.earned - x.earned)
    .map((r) => ({ name: r.name.split(" ")[0], earned: r.earned }));

  const series = useMemo(() => monthlySeries(ledger, 6, 6), [ledger]);
  const seriesData = series.map((p) => ({
    label: p.label,
    Earned: p.earned,
    Projected: p.projected,
  }));

  const COLORS = ["#3366ff", "#22c55e", "#a855f7", "#f59e0b", "#06b6d4", "#ec4899"];

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Revenue, commissions, and performance across your team"
        actions={<DateRangeFilter value={range} onChange={setRange} />}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Total revenue"
          value={formatCurrency(revenue)}
          icon={<Banknote className="h-5 w-5" />}
          tone="blue"
        />
        <StatCard
          label="Commissions owed"
          value={formatCurrency(totals.pending)}
          sub="Pending + submitted + approved"
          icon={<HandCoins className="h-5 w-5" />}
          tone="amber"
        />
        <StatCard
          label="Paid commissions"
          value={formatCurrency(totals.paid)}
          icon={<CircleDollarSign className="h-5 w-5" />}
          tone="green"
        />
        <StatCard
          label="Projected (upcoming)"
          value={formatCurrency(totals.projected)}
          sub="Future residuals"
          icon={<TrendingUp className="h-5 w-5" />}
          tone="cyan"
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Active salespeople" value={formatNumber(activeSalespeople)} icon={<Users className="h-5 w-5" />} tone="indigo" />
        <StatCard label="Active clients" value={formatNumber(activeClients)} icon={<Building2 className="h-5 w-5" />} tone="violet" />
        <StatCard label="Total earned" value={formatCurrency(totals.earned)} sub="Pending + paid" icon={<Clock className="h-5 w-5" />} tone="blue" />
        <StatCard label="Commission plans" value={formatNumber(data.plans.length)} icon={<CircleDollarSign className="h-5 w-5" />} tone="green" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <SectionTitle right={<span className="text-xs text-slate-400">Earned vs projected</span>}>
            Commissions over time
          </SectionTitle>
          <MoneyBarChart
            data={seriesData}
            xKey="label"
            stacked
            series={[
              { key: "Earned", name: "Earned", color: "#3366ff" },
              { key: "Projected", name: "Projected", color: "#06b6d4" },
            ]}
          />
        </Card>

        <Card className="lg:col-span-2">
          <SectionTitle>Salesperson performance</SectionTitle>
          {perfData.length === 0 ? (
            <EmptyState title="No commissions yet" description="Add payments to see performance." />
          ) : (
            <CategoryBarChart data={perfData} xKey="name" dataKey="earned" colors={COLORS} />
          )}
        </Card>
      </div>

      <Card className="mt-6" padded={false}>
        <div className="flex items-center justify-between px-5 py-4">
          <SectionTitle>Team leaderboard</SectionTitle>
          <Link to="/people">
            <Button variant="ghost" size="sm">
              View all <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-y border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/40">
              <tr>
                <th className="px-5 py-2 font-semibold">Salesperson</th>
                <th className="px-5 py-2 text-right font-semibold">Clients</th>
                <th className="px-5 py-2 text-right font-semibold">Earned</th>
                <th className="px-5 py-2 text-right font-semibold">Pending</th>
                <th className="px-5 py-2 text-right font-semibold">Projected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
              {rollup
                .sort((a, b) => b.earned - a.earned)
                .map((r) => (
                  <tr key={r.salespersonId} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="px-5 py-2.5">
                      <Link to={`/people/${r.salespersonId}`} className="font-medium text-slate-800 hover:text-brand-600 dark:text-slate-100">
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-slate-500">{r.clients}</td>
                    <td className="px-5 py-2.5 text-right font-medium tabular-nums text-slate-800 dark:text-slate-100">{formatCurrency(r.earned)}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-amber-600 dark:text-amber-400">{formatCurrency(r.pending)}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-cyan-600 dark:text-cyan-400">{formatCurrency(r.projected)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
