import { useMemo, useState } from "react";
import { BarChart3, DollarSign, Wallet, Clock, TrendingUp } from "lucide-react";
import { useApp } from "../store/AppContext";
import {
  PageHeader,
  StatCard,
  Card,
  SectionTitle,
  EmptyState,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "../components/ui";
import { DateRangeFilter, type DateRange } from "../components/DateRangeFilter";
import { MoneyBarChart } from "../components/charts/Charts";
import {
  revenueInRange,
  commissionTotals,
  rollupBySalesperson,
  inRange,
} from "../lib/analytics";
import { fullLedger, clientLabel } from "../lib/ledger";
import { isoToDate, formatCurrency } from "../lib/format";

function monthKey(iso: string): string {
  const d = isoToDate(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

export default function Reports() {
  const { data, role } = useApp();
  const [range, setRange] = useState<DateRange>({ from: null, to: null });

  const ledger = useMemo(() => fullLedger(data, 24), [data]);

  const revenue = useMemo(() => revenueInRange(data, range.from, range.to), [data, range]);
  const totals = useMemo(() => {
    const slice = ledger.filter((e) => inRange(e.dueDate, range.from, range.to));
    return commissionTotals(slice);
  }, [ledger, range]);

  // Revenue by month (from real payments).
  const revenueSeries = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of data.payments) {
      if (!inRange(p.date, range.from, range.to)) continue;
      const delta = p.type === "refund" ? -p.amount : p.amount;
      map.set(monthKey(p.date), (map.get(monthKey(p.date)) ?? 0) + delta);
    }
    return [...map.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, revenue]) => ({ label: monthLabel(key), revenue }));
  }, [data.payments, range]);

  const rollup = useMemo(() => rollupBySalesperson(data), [data]);
  const roleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of data.salespeople) m.set(s.id, s.role);
    return m;
  }, [data.salespeople]);

  const reps = rollup.filter((r) => roleById.get(r.salespersonId) === "salesperson");
  const partners = rollup.filter((r) =>
    ["affiliate", "partner"].includes(roleById.get(r.salespersonId) ?? ""),
  );

  // Client revenue (total real payments per client).
  const clientRevenue = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of data.payments) {
      if (!inRange(p.date, range.from, range.to)) continue;
      const delta = p.type === "refund" ? -p.amount : p.amount;
      map.set(p.clientId, (map.get(p.clientId) ?? 0) + delta);
    }
    return [...map.entries()]
      .map(([clientId, total]) => ({
        clientId,
        label: clientLabel(data.clients.find((c) => c.id === clientId)),
        total,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
  }, [data.payments, data.clients, range]);

  const scopeNote =
    role === "sales_manager"
      ? "Figures cover your team only."
      : ["salesperson", "affiliate", "partner"].includes(role)
        ? "Figures cover your own book only."
        : "Figures cover the whole workspace.";

  return (
    <div>
      <PageHeader title="Reports" subtitle={scopeNote} actions={<DateRangeFilter value={range} onChange={setRange} />} />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Revenue" value={formatCurrency(revenue)} icon={<DollarSign className="h-5 w-5" />} tone="green" />
        <StatCard label="Commission liability" value={formatCurrency(totals.pending)} icon={<Clock className="h-5 w-5" />} tone="amber" />
        <StatCard label="Commissions paid" value={formatCurrency(totals.paid)} icon={<Wallet className="h-5 w-5" />} tone="indigo" />
        <StatCard label="Projected (next 24m)" value={formatCurrency(totals.projected)} icon={<TrendingUp className="h-5 w-5" />} tone="cyan" />
      </div>

      <SectionTitle>Revenue by month</SectionTitle>
      <Card className="mb-6 mt-3">
        {revenueSeries.length === 0 ? (
          <EmptyState icon={<BarChart3 className="h-6 w-6" />} title="No revenue in range" description="Adjust the date range or record payments to see revenue here." />
        ) : (
          <MoneyBarChart data={revenueSeries} xKey="label" series={[{ key: "revenue", name: "Revenue", color: "#16a34a" }]} />
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle>Salesperson performance</SectionTitle>
          <Card padded={false} className="mt-3 overflow-hidden">
            {reps.length === 0 ? (
              <div className="p-6"><EmptyState icon={<BarChart3 className="h-6 w-6" />} title="No salespeople" description="No sales reps in scope." /></div>
            ) : (
              <Table>
                <THead><TR><TH>Name</TH><TH className="text-right">Clients</TH><TH className="text-right">Paid</TH><TH className="text-right">Pending</TH></TR></THead>
                <TBody>
                  {reps.map((r) => (
                    <TR key={r.salespersonId}>
                      <TD className="font-medium text-slate-900 dark:text-white">{r.name}</TD>
                      <TD className="text-right text-slate-500">{r.clients}</TD>
                      <TD className="text-right tabular-nums text-slate-700 dark:text-slate-200">{formatCurrency(r.paid)}</TD>
                      <TD className="text-right tabular-nums text-slate-700 dark:text-slate-200">{formatCurrency(r.pending)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>

        <div>
          <SectionTitle>Affiliate / partner performance</SectionTitle>
          <Card padded={false} className="mt-3 overflow-hidden">
            {partners.length === 0 ? (
              <div className="p-6"><EmptyState icon={<BarChart3 className="h-6 w-6" />} title="No affiliates" description="No affiliates or partners in scope." /></div>
            ) : (
              <Table>
                <THead><TR><TH>Name</TH><TH className="text-right">Referrals</TH><TH className="text-right">Paid</TH><TH className="text-right">Pending</TH></TR></THead>
                <TBody>
                  {partners.map((r) => (
                    <TR key={r.salespersonId}>
                      <TD className="font-medium text-slate-900 dark:text-white">{r.name}</TD>
                      <TD className="text-right text-slate-500">{r.clients}</TD>
                      <TD className="text-right tabular-nums text-slate-700 dark:text-slate-200">{formatCurrency(r.paid)}</TD>
                      <TD className="text-right tabular-nums text-slate-700 dark:text-slate-200">{formatCurrency(r.pending)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>
      </div>

      <div className="mt-6"><SectionTitle>Top clients by revenue</SectionTitle></div>
      <Card padded={false} className="mt-3 overflow-hidden">
        {clientRevenue.length === 0 ? (
          <div className="p-6"><EmptyState icon={<BarChart3 className="h-6 w-6" />} title="No client revenue" description="No payments recorded in range." /></div>
        ) : (
          <Table>
            <THead><TR><TH>Client</TH><TH className="text-right">Revenue</TH></TR></THead>
            <TBody>
              {clientRevenue.map((c) => (
                <TR key={c.clientId}>
                  <TD className="font-medium text-slate-900 dark:text-white">{c.label}</TD>
                  <TD className="text-right tabular-nums text-slate-700 dark:text-slate-200">{formatCurrency(c.total)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
